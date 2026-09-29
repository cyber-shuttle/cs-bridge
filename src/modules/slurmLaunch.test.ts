import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkspanIsUpToDate, keepsInstalledLinkspan, installLinkspan, submitJobToSlurm, validateSlurmConfig, RemoteRunner } from './slurmLaunch';
import { SlurmSession } from '../models';
import { buildShellCommand } from './sshShell';

const noopLog = { info() {}, warn() {}, error() {} };
const session = (over: Partial<SlurmSession> = {}) => ({ cluster: 'cl', name: 's', ...over }) as SlurmSession;
const scratch: string[] = [];
const scratchDir = () => { const dir = mkdtempSync(join(tmpdir(), 'cs-test-')); scratch.push(dir); return dir; };
after(() => scratch.forEach(dir => rmSync(dir, { recursive: true, force: true })));

// Runs each command as the SSH host's persistent shell would: through its single-line rule, then in real bash with a
// scratch HOME and PATH led by stub executables standing in for the cluster's tools (curl, uname, sbatch).
function host(stubs: Record<string, string> = {}): { run: RemoteRunner; home: string; calls: string[] } {
    const home = scratchDir();
    const bin = join(home, 'stubs');
    mkdirSync(bin);
    for (const [name, body] of Object.entries(stubs)) { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 }); }
    const calls: string[] = [];
    const run: RemoteRunner = {
        async runRemoteCommand(_host, command) {
            buildShellCommand('t', command);
            calls.push(command);
            const r = spawnSync('bash', ['-c', command], { encoding: 'utf-8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
            return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? 1 };
        },
    };
    return { run, home, calls };
}

// A release archive as GitHub serves it: linkspan at the root of a .tar.gz.
function releaseArchive(content: string): string {
    const dir = scratchDir();
    writeFileSync(join(dir, 'linkspan'), content);
    spawnSync('tar', ['-czf', join(dir, 'release.tgz'), '-C', dir, 'linkspan']);
    return join(dir, 'release.tgz');
}

// curl serving one release asset by name, and failing (as -f does on a 404) for any other.
const curlServing = (asset: string, archive: string) => `case "$*" in *${asset}*) cat '${archive}';; *) exit 22;; esac`;

test('keepsInstalledLinkspan keeps only a real version that is ahead of the release', () => {
    assert.equal(keepsInstalledLinkspan('0.15.13', '0.15.12'), true);
    assert.equal(keepsInstalledLinkspan('0.15.12', '0.15.12'), true); // already installed
    assert.equal(keepsInstalledLinkspan('0.15.11', '0.15.12'), false);
    assert.equal(keepsInstalledLinkspan('0.9.0', '0.15.0'), false); // numbers, not strings
    // A build ahead of a release outranks older releases and yields to its own.
    assert.equal(keepsInstalledLinkspan('0.16.0.1ebf666', '0.15.12'), true);
    assert.equal(keepsInstalledLinkspan('0.16.0.1ebf666', '0.16.0'), false);
    assert.equal(keepsInstalledLinkspan('0.17.0.1ebf666', '0.16.0'), true);
    assert.equal(keepsInstalledLinkspan('0.16.0', '0.16.0.aaaaaaa'), true); // a release never carries a commit
    // Only X.Y.Z[.commit] is a version; anything else must never outrank a release.
    assert.equal(keepsInstalledLinkspan('dev', '0.15.12'), false);
    assert.equal(keepsInstalledLinkspan('0.15.12-1-g1ee565a', '0.15.12'), false);
    assert.equal(keepsInstalledLinkspan('', '0.15.12'), false);
    assert.equal(keepsInstalledLinkspan('0.15.12', ''), true); // no answer about the latest keeps what works
});

test('linkspanIsUpToDate keeps an install at or ahead of the latest release and at or above 0.22.0', async () => {
    const cases = [
        ['0.22.0', 'v0.22.0', true], ['0.22.0', 'v0.23.0', false], ['0.23.0.abcdef1', 'v0.23.0', false],
        ['0.22.0.abcdef1', 'v0.22.0', false], ['0.23.1.abcdef1', 'v0.23.0', true], ['0.22.3', '', true], ['0.21.9', '', false], ['', 'v0.22.0', false],
    ] as const;
    for (const [installed, latest, kept] of cases) {
        const { run, home } = host({ curl: latest ? `printf https://github.com/cyber-shuttle/linkspan/releases/tag/${latest}` : 'exit 22' });
        if (installed) {
            mkdirSync(join(home, '.cybershuttle/bin'), { recursive: true });
            writeFileSync(join(home, '.cybershuttle/bin/linkspan'), `#!/bin/bash\necho v${installed}\n`, { mode: 0o700 });
        }
        assert.equal(await linkspanIsUpToDate(session(), run, noopLog), kept, `${installed} vs ${latest}`);
    }
});

test('installLinkspan puts the release for the host\'s architecture at ~/.cybershuttle/bin/linkspan, owner-only', async () => {
    const { run, home, calls } = host({ uname: 'echo aarch64', curl: curlServing('linkspan_Linux_arm64.tar.gz', releaseArchive('arm64 build')) });
    await installLinkspan(session(), run, noopLog);
    const bin = join(home, '.cybershuttle/bin');
    assert.equal(readFileSync(join(bin, 'linkspan'), 'utf-8'), 'arm64 build');
    assert.equal(statSync(bin).mode & 0o777, 0o700);
    assert.equal(statSync(join(bin, 'linkspan')).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(bin), ['linkspan'], 'no staged file is left behind');
    assert.match(calls.at(-1)!, /\| base64 -d \| bash$/, 'set -eu and the EXIT trap run in their own bash, not the shared login shell');
});

// An interrupted download must not replace the binary the next launch execs.
test('installLinkspan fails on a broken download and keeps the installed binary', async () => {
    const { run, home } = host({ uname: 'echo x86_64', curl: 'printf partial; exit 18' });
    const bin = join(home, '.cybershuttle/bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'linkspan'), 'working build');
    await assert.rejects(() => installLinkspan(session(), run, noopLog), /Failed to install Linkspan on SSH host cl/);
    assert.equal(readFileSync(join(bin, 'linkspan'), 'utf-8'), 'working build');
    assert.deepEqual(readdirSync(bin), ['linkspan']);
});

// cs-plane's provisionScript refuses an unmapped machine by name (error=architecture).
// Building a release URL from it instead would 404 and read as a network fault.
test('installLinkspan refuses a machine Linkspan is not released for', async () => {
    const { run, home } = host({ uname: 'echo ppc64le' });
    await assert.rejects(() => installLinkspan(session(), run, noopLog), /architecture ppc64le, which Linkspan is not released for/);
    assert.equal(existsSync(join(home, '.cybershuttle')), false);
});

test('validateSlurmConfig hands sbatch --test-only the job script and surfaces the site filter\'s refusal', async () => {
    const s = session({ cpus: 2, memory: '4 GB', wallTime: '00:30:00', queue: 'skx-dev', allocation: 'acct1', gpuClass: '', gpuCount: 0 });
    const ok = host({ sbatch: '[ "$1" = --test-only ] && cat > "$HOME/script" && echo "sbatch: Job 1 to start at ..." >&2' });
    await validateSlurmConfig(s, ok.run, noopLog);
    assert.match(readFileSync(join(ok.home, 'script'), 'utf-8'), /^#SBATCH --partition=skx-dev$/m);

    const refused = host({ sbatch: 'echo "ERROR: Unknown project acct1" >&2; exit 1' });
    await assert.rejects(() => validateSlurmConfig(s, refused.run, noopLog),
        /Slurm on SSH host cl rejected the session configuration: ERROR: Unknown project acct1/);
});

// sbatchEnv reaches sbatch as its environment, exported to the job, never as an argument or in the script.
test('submitJobToSlurm feeds sbatch the script and sbatchEnv, recording the job id', async () => {
    const { run, home } = host({ sbatch: 'cat > "$HOME/script"; printf %s "$LINKSPAN_LINK_TOKEN" > "$HOME/token"; echo "$*" > "$HOME/args"; echo "Submitted batch job 4242"' });
    const s = session({ jobScript: '#!/bin/bash\necho hi' });
    await submitJobToSlurm(s, run, noopLog, { LINKSPAN_LINK_TOKEN: 'tok\'en' });
    assert.equal(readFileSync(join(home, 'script'), 'utf-8'), '#!/bin/bash\necho hi');
    assert.equal(readFileSync(join(home, 'token'), 'utf-8'), 'tok\'en');
    assert.equal(readFileSync(join(home, 'args'), 'utf-8').trim(), '--export=ALL');
    assert.equal(s.jobId, '4242');
    assert.equal(s.status, undefined, 'status belongs to setStatus, not the submit step');
    assert.ok((s.submittedAt ?? 0) > 0);

    await assert.rejects(() => submitJobToSlurm(session(), host().run, noopLog), /missing job script/);
    await assert.rejects(() => submitJobToSlurm(session({ jobScript: 'x' }), host({ sbatch: 'echo no id here' }).run, noopLog),
        /Failed to parse job ID/);
});
