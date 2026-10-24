import { Logger } from './logger';
import { SessionStatus, SlurmJobStatus, SlurmSession } from './models';
import { deriveStatus } from './modules/sessionMachine';
import { Files, JsonDir, replaceFields } from './modules/store';
import { deleteRunsFile } from './modules/runStore';

const logger = Logger.getInstance();

let sessions: JsonDir<SlurmSession>;

// Every window rewrites windows/{windowId}.json until it closes; a remote window's beat names its session and the
// folder URI it has open, which Switch focuses: VS Code finds a window only by the exact URI, and the user may have
// opened another folder there. env.sessionId repeats across browser tabs, and a hidden tab's timers can slow to once a minute.
interface WindowBeat { sessionId?: string; at: number; folder?: string }
let windows: JsonDir<WindowBeat>;
const BEAT_MS = 20_000;
const isBeating = (w: WindowBeat) => Date.now() - w.at < 90_000;
let beat: ReturnType<typeof setInterval> | undefined;
const windowId = Math.random().toString(36).slice(2);

export async function initSessionStore(files: Files, onError: (err: unknown) => void) {
    // Keeps the object the monitor and an in-flight step hold. A field another window cleared is absent from its JSON.
    sessions = new JsonDir<SlurmSession>(files, 'sessions', onError, (cur, next) => (cur ? replaceFields(cur, next) : next));
    windows = new JsonDir<WindowBeat>(files, 'windows', onError);
    await Promise.all([sessions.load(), windows.load()]);
    // A window that died without detaching leaves a beat that lapses with no write to watch.
    const prune = () => { for (const [id, w] of windows.entries()) { if (!isBeating(w)) { windows.delete(id); } } };
    prune();
    setInterval(prune, BEAT_MS);
    logger.info(`Loaded ${sessions.values().length} session(s)`);
    return [sessions, windows];
}

export function getAllSessions(): SlurmSession[] {
    return sessions.values();
}

export function getSession(sessionId: string): SlurmSession | undefined {
    return sessions.get(sessionId);
}

export function addSession(session: SlurmSession) {
    sessions.set(session.id, session);
}

export function patch(session: SlurmSession, fields: Partial<SlurmSession>): Promise<void> {
    return sessions.patch(session.id, fields);
}

// Written only on change: the monitor says it every tick.
export function setError(session: SlurmSession, errorMessage: string): void {
    if (session.errorMessage !== errorMessage) { patch(session, { errorMessage }); }
}

// A live-set change notifies onSessionsChange like a record write, so no caller has to re-render by hand.
const liveListeners = new Set<() => void>();
class LiveSet extends Set<string> {
    override add(id: string): this {
        if (!this.has(id)) { super.add(id); liveListeners.forEach(l => l()); }
        return this;
    }

    override delete(id: string): boolean {
        const had = super.delete(id);
        if (had) { liveListeners.forEach(l => l()); }
        return had;
    }
}

export const live = {
    launching: new LiveSet(), connecting: new LiveSet(), connected: new LiveSet(), unreachable: new LiveSet(),
    busy: new Set<string>(), connectTokens: new Map<string, string>(),
};

// A remote window beating for the session is a connection too, whichever window holds the tunnel.
export function statusOf(session: SlurmSession): SessionStatus {
    const { id } = session;
    return deriveStatus(session, {
        launching: live.launching.has(id), connecting: live.connecting.has(id),
        connected: live.connected.has(id) || windowState(session).windowAlive, unreachable: live.unreachable.has(id),
    }, Date.now());
}

// Writing only on change keeps the 5 s polls from churning the store.
export function observe(session: SlurmSession, state: SlurmJobStatus): void {
    if (session.observed?.state !== state) { patch(session, { observed: { state, at: Date.now() } }); }
}

export const fail = (session: SlurmSession, message: string): void => void patch(session, { failure: message, errorMessage: message });
// The owner window carries the stop out when the record reaches it.
export const requestStop = (session: SlurmSession): Promise<void> => patch(session, { desired: 'stopped', errorMessage: '' });

export function deleteSession(sessionId: string) {
    sessions.delete(sessionId);
    deleteRunsFile(sessionId);
}

export function startBeat(remote?: { sessionId: string; folder: string }): void {
    const write = () => windows.set(windowId, { ...remote, at: Date.now() });
    write();
    beat = setInterval(write, BEAT_MS);
}

// A claim holds while its window beats, so a closed or crashed window's sessions pass to the next window that looks.
export function claim(session: SlurmSession): boolean {
    const owner = session.owner && windows.get(session.owner);
    if (session.owner !== windowId && owner && isBeating(owner)) { return false; }
    if (session.owner !== windowId) { patch(session, { owner: windowId }); }
    return true;
}

export const owns = (session: SlurmSession): boolean => session.owner === windowId;

// Releasing with the loop lets another window claim at once rather than after this one's beat lapses.
export function disown(session: SlurmSession): void {
    if (owns(session)) { patch(session, { owner: undefined }); }
}

export function detachWindow(): Promise<void> | undefined {
    clearInterval(beat);
    return windows?.delete(windowId);
}

export function windowState(s: SlurmSession): { isCurrent: boolean; windowAlive: boolean; windowFolder?: string } {
    const live = windows.values().find(w => w.sessionId === s.id && isBeating(w));
    return { isCurrent: windows.get(windowId)?.sessionId === s.id, windowAlive: !!live, windowFolder: live?.folder };
}

// Heartbeats and live sets fire it too.
export function onSessionsChange(listener: () => void): { dispose(): void } {
    const subs = [sessions.onDidChange(listener), windows.onDidChange(listener)];
    liveListeners.add(listener);
    return { dispose: () => { subs.forEach(s => s.dispose()); liveListeners.delete(listener); } };
}
