import { UsageSample, SlurmDiscovery, SlurmJobStatus, SlurmSession, nonEmpty } from '../models';
import { SshManager } from './sshSupport';
import { parseJson } from './json';
import { parseAccounts, parsePartitionLine, parseSacctStatus } from './slurmParse';

export async function getSlurmJobStatus(slurmSession: SlurmSession): Promise<{ status: SlurmJobStatus; elapsedSeconds: number }> {
    const command = `sacct -j ${slurmSession.jobId} -n -o State%20,ExitCode,Reason%40,ElapsedRaw --parsable2 2>/dev/null | head -1`;
    return parseSacctStatus((await SshManager.getInstance().runRemoteCommand(slurmSession.alias, command, { batch: true })).trim());
}

// Linkspan's /usage on its loopback control port from inside the job. --input none is load-bearing: srun forwards
// stdin to the task, which would otherwise swallow the persistent shell's completion marker (sshShell) and hang.
export async function getSampleViaSrun(session: SlurmSession, controlPort: number): Promise<UsageSample> {
    const command = `srun --jobid=${session.jobId} --overlap --quiet --input none `
        + `curl -sf --max-time 4 http://127.0.0.1:${controlPort}/api/v1/usage`;
    return parseJson<UsageSample>(await SshManager.getInstance().runRemoteCommand(session.alias, command, { batch: true }));
}

// Everything the session form needs, or an error the form shows with Retry: a host that answers for accounts but not
// for partitions or $HOME could only produce a session that fails later.
export async function getSlurmDiscovery(alias: string): Promise<SlurmDiscovery> {
    const run = (command: string) => SshManager.getInstance().runRemoteCommand(alias, command);
    // Only the first command authenticates (later ones reuse the ControlMaster socket), so the auth box surfaces here.
    // Slurm's database lowercases account names; TACC's submit filter wants them as project.map spells them.
    const accounts = parseAccounts(await run('sacctmgr -n show associations where user=$USER format=Account -P'
        + ' | if [ -r /usr/local/etc/project.map ]; then grep -iwf - /usr/local/etc/project.map | cut -d" " -f1; else cat; fi'));
    /* Example output:
    interactive-cpu|24|191000+|gpu:v100:2(S:0-1)
    interactive-cpu1|24|385000+|gpu:rtx_6000:4(S:0-1)
    interactive-cpu2|64|515000|gpu:a100:2(S:2,5)
    cpu-small*|24+|191000+|(null)
    cpu-amd|128|515000+|(null)
    */
    const partitions = (await run('sinfo -h -o "%P|%c|%m|%G"')).split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(parsePartitionLine);
    if (!nonEmpty(partitions)) { throw new Error(`sinfo lists no partitions on ${alias}`); }
    const homeDir = (await run('echo $HOME')).trim();
    if (!homeDir) { throw new Error(`$HOME is unset on ${alias}`); }
    return { alias, accounts, partitions, homeDir };
}
