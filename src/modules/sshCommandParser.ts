import { parse } from 'shell-quote';
import { BasicParser } from 'posix-getopt';
import { groups } from './util';

export class CommandParseError extends Error {}

export interface SshConfigEntry {
    Host: string;
    HostName: string;
    [key: string]: string;
}

// Verbatim getopt option string from Remote-SSH 0.123.0.
const OPTSTRING = ':1246ab:c:e:fgi:kl:m:no:p:qstvxAB:CD:E:F:GI:J:KL:MNO:PQ:R:S:TVw:W:XYy';

// Flag -> ssh_config directive (Remote-SSH 0.123.0). Flags in OPTSTRING but absent here are consumed by getopt without
// producing a directive. A flag is either a switch or takes an argument, as OPTSTRING's colons say.
type Config = Record<string, string>;
const SWITCHES: Record<string, (c: Config) => void> = {
    1: (c) => { c.Protocol = '1'; },
    2: (c) => { c.Protocol = '2'; },
    4: (c) => { c.AddressFamily = 'inet'; },
    6: (c) => { c.AddressFamily = 'inet6'; },
    A: (c) => { c.ForwardAgent = 'yes'; },
    C: (c) => { c.Compression = 'yes'; },
    g: (c) => { c.GatewayPorts = 'yes'; },
    K: (c) => { c.GSSAPIAuthentication = 'yes'; },
    k: (c) => { c.GSSAPIDelegateCredentials = 'no'; },
    M: (c) => { c.ControlMaster = 'yes'; },
    v: (c) => { c.LogLevel = 'verbose'; },
    X: (c) => { c.ForwardX11 = 'yes'; },
    x: (c) => { c.ForwardX11 = 'no'; },
    Y: (c) => { c.ForwardX11Trusted = 'yes'; },
};
const WITH_ARG: Record<string, (c: Config, arg: string) => void> = {
    b: (c, a) => { c.BindAddress = a; },
    c: (c, a) => { c.Cipher = a; },
    D: (c, a) => { c.DynamicForward = a; },
    I: (c, a) => { c.SmartcardDevice = a; },
    i: (c, a) => { c.IdentityFile = a; },
    J: (c, a) => { c.ProxyJump = a; },
    L: (c, a) => {
        const g = groups(a.match(/^(?<listener>(.*):?\d+)?:(?<dest>.+?)?$/), 'listener', 'dest');
        if (!g) { throw new CommandParseError(`LocalForward needs a listener and a destination separated by a colon. ${a} does not match.`); }
        c.LocalForward = g.join(' ');
    },
    l: (c, a) => { c.User = a; },
    m: (c, a) => { c.MACs = a; },
    o: (c, a) => {
        const idx = a.indexOf('=');
        if (idx === -1) { throw new CommandParseError(`Argument missing for option ${a}`); }
        c[a.slice(0, idx)] = a.slice(idx + 1);
    },
    p: (c, a) => { c.Port = a; },
    R: (c, a) => { c.RemoteForward = a; },
    S: (c, a) => { c.ControlPath = a; },
    w: (c, a) => { c.TunnelDevice = a; },
};

function consumeFlags(tokens: string[], config: Config): number {
    const parser = new BasicParser(OPTSTRING, tokens, 0);
    for (;;) {
        const opt = parser.getopt();
        if (!opt) { break; }
        if (opt.option === ':') { throw new CommandParseError(`Expected flag -${opt.optopt} to have an argument but it did not`); }
        if (opt.option === '?') { throw new CommandParseError(`Unknown flag ${opt.optopt}`); }
        if (opt.optarg === undefined) { SWITCHES[opt.option]?.(config); }
        else { WITH_ARG[opt.option]?.(config, opt.optarg); }
    }
    return parser.optind();
}

export function parseHostToken(token: string): { hostname: string; username?: string; port?: string } {
    let url: URL | undefined;
    try { url = new URL(token); }
    catch { /* not a URL */ }
    if (url && url.protocol === 'ssh:') {
        return { hostname: url.hostname, username: url.username || undefined, port: url.port || undefined };
    }
    const atIndex = token.lastIndexOf('@');
    if (atIndex === -1) { return { hostname: token }; }
    const [username = ''] = token.slice(0, atIndex).split(':', 1);
    const [hostname = '', port] = token.slice(atIndex + 1).split(':', 2);
    return { hostname, username, ...port && { port } };
}

export function sshCommandToConfig(command: string): SshConfigEntry {
    const tokens = parse(command).filter((t): t is string => typeof t === 'string'); // shell operators and globs are not ssh arguments
    if (tokens[0] === 'ssh') { tokens.shift(); }
    const config: Config = {};
    for (let i = 0; i < tokens.length; i++) {
        i += consumeFlags(tokens.slice(i), config);
        const token = tokens[i];
        if (token !== undefined && config.Host) { break; } // the remote command starts here
        if (token !== undefined) {
            const { hostname, port, username } = parseHostToken(token);
            config.Host = hostname;
            if (!config.HostName) { config.HostName = hostname; }
            if (!config.Port && port) { config.Port = port; }
            if (!config.User && username) { config.User = username; }
        }
    }
    const { Host, HostName, ...rest } = config;
    if (!Host || !HostName) { throw new CommandParseError('Missing hostname in SSH connection string'); }
    return { Host, HostName, ...rest };
}

const INVALID_HOST_CHARS = ['\\', '\'', '"', '`', '!', '%', '\r', '\n', ' '];

export function assertValidHost(entry: SshConfigEntry): void {
    for (const [label, val] of [['alias', entry.Host], ['hostname', entry.HostName], ['username', entry.User]] as const) {
        if (!val) { continue; }
        if (val.startsWith('-')) { throw new CommandParseError(`SSH ${label} cannot begin with -`); }
        const bad = INVALID_HOST_CHARS.find(ch => val.includes(ch));
        if (bad) { throw new CommandParseError(`SSH ${label} cannot include the character ${bad}`); }
    }
}
