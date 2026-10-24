import { Logger } from './logger';
import { SessionStatus, SlurmJobStatus, SlurmSession } from './models';
import { deriveStatus } from './modules/sessionMachine';
import { Files, JsonDir } from './modules/store';
import { deleteRunsFile } from './modules/runStore';

const logger = Logger.getInstance();

let sessions: JsonDir<SlurmSession>;

// A window connected to a session rewrites windows/{windowId}.json until it closes. env.sessionId repeats across
// browser tabs, and a hidden tab's timers can slow to once a minute. folder is the URI the window has open, which
// Switch focuses: VS Code finds a window only by the exact URI, and the user may have opened another folder there.
interface WindowBeat { sessionId: string; at: number; folder?: string }
let windows: JsonDir<WindowBeat>;
const BEAT_MS = 20_000;
const isBeating = (w: WindowBeat) => Date.now() - w.at < 90_000;
let beat: ReturnType<typeof setInterval> | undefined;
const windowId = Math.random().toString(36).slice(2);

export async function initSessionStore(files: Files, onError: (err: unknown) => void) {
    // Keeps the object the monitor and an in-flight step hold.
    sessions = new JsonDir<SlurmSession>(files, 'sessions', onError, (cur, next) => (cur ? Object.assign(cur, next) : next));
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

export function updateSession(session: SlurmSession) {
    if (sessions.get(session.id)) { sessions.set(session.id, session); }
}

// A live-set change notifies onSessionsChange like a record write, so no caller has to re-render by hand.
const liveListeners = new Set<() => void>();
class LiveSet extends Set<string> {
    add(id: string): this {
        if (!this.has(id)) { super.add(id); liveListeners.forEach(l => l()); }
        return this;
    }

    delete(id: string): boolean {
        const had = super.delete(id);
        if (had) { liveListeners.forEach(l => l()); }
        return had;
    }
}

export const live = {
    launching: new LiveSet(), connecting: new LiveSet(), connected: new LiveSet(), unreachable: new LiveSet(),
    connectTokens: new Map<string, string>(),
};

// A remote window beating for the session is a connection too, whichever window holds the tunnel.
export function statusOf(session: SlurmSession, now = Date.now()): SessionStatus {
    const { id } = session;
    return deriveStatus(session, {
        launching: live.launching.has(id), connecting: live.connecting.has(id),
        connected: live.connected.has(id) || windowState(session).windowAlive, unreachable: live.unreachable.has(id),
    }, now);
}

// Writing only on change keeps the 5 s polls from churning the store.
export function observe(session: SlurmSession, state: SlurmJobStatus): void {
    if (session.observed?.state === state) { return; }
    session.observed = { state, at: Date.now() };
    updateSession(session);
}

export function fail(session: SlurmSession, message: string): void {
    session.failure = message;
    session.errorMessage = message;
    updateSession(session);
}

export function deleteSession(sessionId: string) {
    sessions.delete(sessionId);
    deleteRunsFile(sessionId);
}

export function attachWindow(sessionId: string, folder: string): void {
    const write = () => windows.set(windowId, { sessionId, at: Date.now(), folder });
    write();
    beat = setInterval(write, BEAT_MS);
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
