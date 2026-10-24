import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse, LineType, type Directive } from 'ssh-config';
import { SlurmSession, SshHost, isEc2 } from '../models';
import { keyName } from './ec2';
import { SshConfigEntry } from './sshCommandParser';
import { lockedUpdateTextFile } from './fsSupport';

export const USER_SSH_CONFIG_PATH = path.join(os.homedir(), '.ssh', 'config');
export const SYSTEM_SSH_CONFIG_PATH = process.platform === 'win32'
    ? path.join(process.env.ALLUSERSPROFILE || process.env.PROGRAMDATA || 'C:\\ProgramData', 'ssh', 'ssh_config')
    : '/etc/ssh/ssh_config';

// SSH client directives that let a session ride out brief tunnel stalls, but give up within ~45s (15×3) on a
// dead-ended connection so a replacement ssh -D doesn't overlap the old one and re-saturate the tunnel.
export const SSH_RESILIENCE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
    ['ServerAliveInterval', '15'],
    ['ServerAliveCountMax', '3'],
    ['TCPKeepAlive', 'yes'],
    ['Compression', 'no'],
    ['ConnectTimeout', '10'],
    ['IPQoS', 'cs0'],
];

// The per-session SSH host's alias, which is also the vscode-remote authority VS Code shows verbatim as the remote
// window's "[SSH: …]" label — so it reads like the target: <alias>-<last 6 of the session name> (e.g. delta-493119).
// Never equals a bare SSH host alias, so it can't shadow the real SSH host used for Slurm; unique per session in
// practice (the name is a creation timestamp, or an instance id). The same function builds the ssh_config Host line, the authority, and
// the reverse lookup, so all three stay in lockstep.
export const csHostAlias = ({ alias, name }: Pick<SlurmSession, 'alias' | 'name'>): string =>
    `${alias}-${name.slice(-6)}`;

export const sessionKeyName = (sessionId: string): string => `id_cshost-${sessionId}`;

// The whole file from the records, so no window edits it in place and nothing is left behind.
export function renderSshConfig(sessions: SlurmSession[], keyPath: (name: string) => string): string {
    return sessions.flatMap((s) => {
        const ci = s.connectionInfo;
        if (isEc2(s)) { return ci?.sshPort && s.ec2.ip ? [buildSshConfigBlock(s.id, csHostAlias(s), s.ec2.ip, ci.sshPort, s.ec2.user, keyPath(keyName(s.ec2.region)))] : []; }
        // The custom SSH server ignores the user.
        return ci?.localPort ? [buildSshConfigBlock(s.id, csHostAlias(s), '127.0.0.1', ci.localPort, 'cs-ssh-user', keyPath(sessionKeyName(s.id)))] : [];
    }).map(block => `${block}\n`).join('');
}

// Pins each Slurm session's server to node-local /tmp, not $HOME/.vscode-server: on HPC $HOME is a shared network fs
// where stalls miss the ptyHost heartbeat and one account's sessions fight over a single tree.
const SERVER_INSTALL_ROOT = '/tmp/cs-vscode/';
export function renderServerInstallPaths(sessions: SlurmSession[], current: Record<string, string>): Record<string, string> {
    const ours = Object.fromEntries(sessions.filter(s => !isEc2(s) && s.connectionInfo?.localPort).map(s => [csHostAlias(s), `${SERVER_INSTALL_ROOT}${s.id}`]));
    return { ...Object.fromEntries(Object.entries(current).filter(([, dir]) => !dir.startsWith(SERVER_INSTALL_ROOT))), ...ours };
}

export function buildSshConfigBlock(
    sessionId: string,
    alias: string,
    hostname: string,
    port: number,
    user: string,
    identityFile: string,
): string {
    return [
        ``,
        `# CS-Bridge auto-generated for session ${sessionId}`,
        `Host ${alias}`,
        `    HostName ${hostname}`,
        `    Port ${port}`,
        `    User ${user}`,
        `    StrictHostKeyChecking no`,
        `    UserKnownHostsFile /dev/null`,
        `    IdentityFile "${identityFile}"`,
        ...SSH_RESILIENCE_OPTIONS.map(([key, value]) => `    ${key} ${value}`),
    ].join('\n');
}

// ssh-config models a directive value as a plain string or, for multi-token directives, an array of tokens.
const directiveText = (value: Directive['value']): string =>
    Array.isArray(value) ? value.map(t => t.val).join(' ') : value;

// An Include only applies globally when it is uncommented and precedes the first Host/Match block;
// OpenSSH scopes anything after one to that block.
export function includeIsEffective(configText: string, includeLine: string): boolean {
    const wanted = includeLine.trim().replace(/\s+/g, ' ');
    for (const raw of configText.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) { continue; }
        if (/^(Host|Match)\b/i.test(line)) { return false; }
        if (line.replace(/\s+/g, ' ') === wanted) { return true; }
    }
    return false;
}

export function parseHostsFromConfigText(text: string, source: SshHost['source']): SshHost[] {
    const config = parse(text);
    const hosts: SshHost[] = [];
    for (const section of config) {
        // Keep Host sections only: they carry a `config` array, Match sections also carry `criteria`.
        if (!('config' in section) || 'criteria' in section || section.param !== 'Host') { continue; }
        const raw = Array.isArray(section.value) ? section.value[0] : section.value;
        const alias = typeof raw === 'string' ? raw.trim().split(/\s+/)[0] : '';
        if (!alias || alias.includes('*') || alias.includes('?')) { continue; }
        const host: SshHost = { alias, source };
        const extraDirectives: string[] = [];
        for (const child of section.config) {
            if (child.type !== LineType.DIRECTIVE) { continue; }
            const value = directiveText(child.value);
            if (child.param === 'HostName') { host.hostname = value; }
            else if (child.param === 'User') { host.user = value; }
            else { extraDirectives.push(`${child.param} ${value}`); }
        }
        if (extraDirectives.length) { host.extraDirectives = extraDirectives; }
        hosts.push(host);
    }
    return hosts;
}

export function addHostToConfigText(text: string, entry: SshConfigEntry): string {
    const config = parse(text);
    config.remove({ Host: entry.Host });
    config.prepend(entry, true); // top of file, after any Include lines
    return config.toString();
}

export function deleteHostFromConfigText(text: string, alias: string): string {
    const config = parse(text);
    config.remove({ Host: alias });
    return config.toString();
}

export function editHostInConfigText(text: string, alias: string, edit: SshConfigEntry): string {
    const config = parse(text);
    const found = config.find({ Host: alias });
    const section = found && 'config' in found ? found : undefined;
    if (!section) { throw new Error(`SSH host ${alias} is not in ~/.ssh/config.`); }
    if (edit.Host !== alias && config.find({ Host: edit.Host })) { throw new Error(`SSH host ${edit.Host} already exists.`); }
    section.value = edit.Host;
    for (const [param, value] of [['User', edit.User], ['HostName', edit.HostName]] as const) {
        const i = section.config.findIndex(line => 'param' in line && line.param === param);
        const existing = section.config[i];
        const line: Directive = existing && 'param' in existing ? existing : { type: LineType.DIRECTIVE, before: section.config[0]?.before ?? '    ', after: '\n', separator: ' ', param, value: '' };
        if (i >= 0) { section.config.splice(i, 1); }
        if (value) { section.config.splice(Math.max(i, 0), 0, { ...line, value }); }
    }
    return config.toString();
}

export function mergeHostsByPriority(...lists: SshHost[][]): SshHost[] {
    const byAlias = new Map<string, SshHost>();
    for (const host of lists.flat()) {
        if (!byAlias.has(host.alias)) { byAlias.set(host.alias, host); }
    }
    return [...byAlias.values()];
}

export function addHostToConfigFile(filePath: string, entry: SshConfigEntry): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    lockedUpdateTextFile(filePath, text => addHostToConfigText(text, entry), 0o600);
}

export function editHostInConfigFile(filePath: string, alias: string, edit: SshConfigEntry): void {
    lockedUpdateTextFile(filePath, text => editHostInConfigText(text, alias, edit), 0o600);
}

export function deleteHostFromConfigFile(filePath: string, alias: string): void {
    lockedUpdateTextFile(filePath, (text, exists) => (exists ? deleteHostFromConfigText(text, alias) : null), 0o600);
}
