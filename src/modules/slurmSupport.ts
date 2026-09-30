import { UsageSample, SlurmDiscovery, SlurmJobStatus, SlurmSession } from '../models';
import { Logger, errMsg } from '../logger';
import { SshManager } from './sshSupport';
import { parseAccounts, parsePartitionLine, parseSacctStatus } from './slurmParse';

export async function getSlurmJobStatus(slurmSession: SlurmSession): Promise<{ status: SlurmJobStatus; elapsedSeconds: number }> {
    const command = `sacct -j ${slurmSession.jobId} -n -o State%20,ExitCode,Reason%40,ElapsedRaw --parsable2 2>/dev/null | head -1`;
    const commandResult = await SshManager.getInstance().runRemoteCommand(slurmSession.alias, command, { batch: true });
    if (commandResult.code !== 0) {
        throw new Error(`Failed to get job status. SSH command error: ${commandResult.stderr}`);
    }
    return parseSacctStatus(commandResult.stdout.trim());
}

// Linkspan's /usage on its loopback control port from inside the job. --input none is load-bearing: srun forwards
// stdin to the task, which would otherwise swallow the persistent shell's completion marker (sshShell) and hang.
export async function getSampleViaSrun(session: SlurmSession): Promise<UsageSample> {
    const command = `srun --jobid=${session.jobId} --overlap --quiet --input none `
        + `curl -sf --max-time 4 http://127.0.0.1:${session.connectionInfo?.controlPort}/api/v1/usage`;
    const res = await SshManager.getInstance().runRemoteCommand(session.alias, command, { batch: true });
    if (res.code !== 0) { throw new Error(`live usage via srun failed (${res.code}): ${res.stderr}`); }
    return JSON.parse(res.stdout) as UsageSample;
}

export async function getSlurmDiscovery(alias: string): Promise<SlurmDiscovery> {
    const sshManager = SshManager.getInstance();
    const log = Logger.getInstance();
    const info: SlurmDiscovery = { alias, accounts: [], partitions: [] };
    // Only the first command authenticates (later ones reuse the ControlMaster socket), so the auth box surfaces here.
    // Slurm's database lowercases account names; TACC's submit filter wants them as project.map spells them.
    const accountResult = await sshManager.runRemoteCommand(alias,
        'sacctmgr -n show associations where user=$USER format=Account -P'
        + ' | if [ -r /usr/local/etc/project.map ]; then grep -iwf - /usr/local/etc/project.map | cut -d" " -f1; else cat; fi');
    if (accountResult.code !== 0) {
        throw new Error(`Failed to query associations (exit ${accountResult.code}): ${accountResult.stderr || 'Unknown error'}`);
    }
    info.accounts = parseAccounts(accountResult.stdout);

    try {
        const partitionResult = await sshManager.runRemoteCommand(alias, 'sinfo -h -o "%P|%c|%m|%G"');
        /* Example output:
        interactive-cpu|24|191000+|gpu:v100:2(S:0-1)
        interactive-cpu1|24|385000+|gpu:rtx_6000:4(S:0-1)
        interactive-cpu2|64|515000|gpu:a100:2(S:2,5)
        cpu-small*|24+|191000+|(null)
        cpu-amd|128|515000+|(null)
        */
        if (partitionResult.code === 0) {
            info.partitions = partitionResult.stdout
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)
                .map(parsePartitionLine);
        }
    }
    catch (err) {
        log.warn(`Failed to query partitions: ${errMsg(err)}`); // non-fatal: accounts info may still be useful
    }

    try {
        const homeResult = await sshManager.runRemoteCommand(alias, 'echo $HOME');
        if (homeResult.code === 0) { info.homeDir = homeResult.stdout.trim(); }
    }
    catch (err) {
        log.warn(`Failed to query $HOME: ${errMsg(err)}`);
    }

    return info;
}
