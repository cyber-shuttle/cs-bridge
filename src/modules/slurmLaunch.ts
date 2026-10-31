import { ConnectionInfo, SlurmSession } from '../models';
import { buildSlurmScript, devTunnelLaunch, envAssignments } from './slurmParse';
import { groups } from './util';

// RemoteRunner/LogSink are injected (SshManager and Logger satisfy them structurally) so the steps below
// are unit-testable with fakes, free of SSH and vscode.
export interface RemoteRunner {
    runRemoteCommand(alias: string, command: string): Promise<string>; // stdout; a non-zero exit throws
}

interface LogSink {
    info(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

// A step throws on failure, except the version check, which answers false; the caller persists what a step returns.

type Host = Pick<SlurmSession, 'alias'>;

export interface LaunchDraft { script: string; sbatchEnv: Record<string, string>; connectionInfo: ConnectionInfo } // the run's, recorded on submit

export async function checkSlurmAvailability(session: Host, run: RemoteRunner, log: LogSink): Promise<void> {
    await run.runRemoteCommand(session.alias, 'sinfo');
    log.info(`Slurm is available on SSH host ${session.alias}`);
}

// Newest wins, ties go to the release. A release is X.Y.Z; a build ahead of one is X.Y.Z.<commit>, so it yields
// once that release ships and never ties another build. Anything else is not a version. cs-plane matches this.
const INSTALLED = /^(\d+)\.(\d+)\.(\d+)(\.[0-9a-f]{7,40})?$/;
const RELEASED = /^(\d+)\.(\d+)\.(\d+)$/;
const MINIMUM = '0.22.0'; // the first with /usage and --tunnel-mode link

export function keepsInstalledLinkspan(local: string, latest: string): boolean {
    const here = INSTALLED.exec(local);
    if (!here) { return false; }
    const there = RELEASED.exec(latest);
    if (!there) { return true; } // no answer about the latest; a working binary beats a guess
    for (let i = 1; i <= 3; i++) {
        if (Number(here[i]) !== Number(there[i])) { return Number(here[i]) > Number(there[i]); }
    }
    return !here[4];
}

// As in cs-plane, the latest tag decides, and the floor counts a build as its release.
export async function linkspanIsUpToDate(session: Host, run: RemoteRunner, log: LogSink): Promise<boolean> {
    let versions: string;
    try { versions = await run.runRemoteCommand(session.alias, `printf 'installed=%s\\nlatest=%s\\n' "$(~/.cybershuttle/bin/linkspan --version 2>/dev/null | head -1)" "$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cyber-shuttle/linkspan/releases/latest 2>/dev/null | sed 's#.*/##')"`); }
    catch (err) {
        log.error(`Failed to check Linkspan version on SSH host ${session.alias}: ${String(err)}`);
        return false;
    }

    const g = groups(versions.match(/^installed=(?<installed>.*)\nlatest=(?<latest>.*)$/m), 'installed', 'latest');
    if (!g) {
        log.error(`Failed to check Linkspan version on SSH host ${session.alias}: ${versions}`);
        return false;
    }
    const clean = (v: string) => v.replace(/[v\s]/g, '');
    const [installed, latest] = [clean(g[0]), clean(g[1])];
    if (keepsInstalledLinkspan(installed, latest) && keepsInstalledLinkspan(installed.replace(/\.[0-9a-f]{7,40}$/, ''), MINIMUM)) {
        log.info(`Linkspan ${installed} on SSH host ${session.alias} is current (latest ${latest || 'unknown'}); keeping it`);
        return true;
    }
    log.info(`Linkspan on SSH host ${session.alias} is missing, behind ${latest || 'the latest release'} or below ${MINIMUM}. Local version: ${installed}`);
    return false;
}

// uname to the release asset. cs-plane maps the same three machines in
// provisionScript and refuses anything else by name; an unmapped arch would
// otherwise build a URL that 404s, which reads as a network fault rather than
// as a machine Linkspan is not released for.
const RELEASE_ARCH: Readonly<Record<string, string>> = { x86_64: 'x86_64', aarch64: 'arm64', arm64: 'arm64' };

export async function installLinkspan(session: Host, run: RemoteRunner, log: LogSink): Promise<void> {
    const machine = (await run.runRemoteCommand(session.alias, 'uname -m')).trim();
    const arch = RELEASE_ARCH[machine];
    if (!arch) {
        throw new Error(`SSH host ${session.alias} reports architecture ${machine}, which Linkspan is not released for`);
    }
    log.info(`Detected architecture on SSH host ${session.alias}: ${machine}`);

    const downloadUrl = `https://github.com/cyber-shuttle/linkspan/releases/latest/download/linkspan_Linux_${arch}.tar.gz`;
    log.info(`Downloading Linkspan from ${downloadUrl} for architecture ${arch}`);
    // Staged and moved, so an interrupted download never becomes the binary a job
    // execs -- cs-plane's provisionScript installs the same way. The directory
    // and the binary stay owner-only: nothing else on a shared SSH host needs them.
    const install = [
        'set -eu',
        'bin=$HOME/.cybershuttle/bin',
        'install -d -m 700 "$bin"',
        'staged=$bin/.linkspan.$$',
        'trap \'rm -f "$staged"\' EXIT',
        `curl -fsSL "${downloadUrl}" | tar -xzO linkspan > "$staged"`,
        '[ -s "$staged" ]',
        'chmod 700 "$staged"',
        'mv -f "$staged" "$bin/linkspan"',
    ].join('\n');
    const installB64 = Buffer.from(install).toString('base64');
    await run.runRemoteCommand(session.alias, `echo '${installB64}' | base64 -d | bash`);
    log.info(`Linkspan installed successfully on SSH host ${session.alias}`);
}

// --test-only runs the site submit filter without queueing.
// Some sites require a time limit, and a new session has none yet, so 30 min stands in.
export async function validateSlurmConfig(session: SlurmSession, run: RemoteRunner, log: LogSink, wallMinutes = 30): Promise<void> {
    // A dry run needs no tunnel or port: the script's Linkspan line is a placeholder --test-only never executes.
    const scriptB64 = Buffer.from(buildSlurmScript({ ...session, resources: { ...session.resources, wallMinutes } }, devTunnelLaunch({ id: '', cluster: '' }, ''), 0)).toString('base64');
    await run.runRemoteCommand(session.alias, `echo '${scriptB64}' | base64 -d | sbatch --test-only`);
    log.info(`Slurm on SSH host ${session.alias} validated the session configuration`);
}

// sbatchEnv reaches the job as assignments on sbatch over the shell's stdin, never an argv, the job script or a file.
export async function submitJobToSlurm(session: Pick<SlurmSession, 'alias' | 'name'>, run: RemoteRunner, log: LogSink, draft: Pick<LaunchDraft, 'script' | 'sbatchEnv'>): Promise<string> {
    const scriptB64 = Buffer.from(draft.script).toString('base64');
    const env = envAssignments(draft.sbatchEnv);
    const submitCommand = `echo '${scriptB64}' | base64 -d | ${env}sbatch${env && ' --export=ALL'}`;
    log.info(`Submitting job to Slurm for session ${session.name}`);

    const output = (await run.runRemoteCommand(session.alias, submitCommand)).trim();
    const jobId = output.match(/Submitted batch job (\d+)/)?.[1];
    if (!jobId) { throw new Error(`Failed to parse job ID from sbatch output: ${output}`); }
    log.info(`Job submitted successfully with Job ID: ${jobId}`);
    return jobId;
}
