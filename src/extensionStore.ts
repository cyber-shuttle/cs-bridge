import { Logger } from './logger';
import { SlurmSession, persistableConnectionInfo } from './models';
import { Files, JsonDir } from './modules/store';
import { deleteRunsFile } from './modules/runStore';

const logger = Logger.getInstance();

let sessions: JsonDir<SlurmSession>;

// A window connected to a session rewrites windows/{windowId}.json until it closes. env.sessionId repeats across
// browser tabs, and a hidden tab's timers can slow to once a minute.
interface WindowBeat { sessionId: string; at: number }
let windows: JsonDir<WindowBeat>;
const BEAT_MS = 20_000;
const isBeating = (w: WindowBeat) => Date.now() - w.at < 90_000;
let beat: ReturnType<typeof setInterval> | undefined;
const windowId = Math.random().toString(36).slice(2);

export async function initSessionStore(files: Files, onError: (err: unknown) => void) {
    sessions = new JsonDir<SlurmSession>(files, 'sessions', onError,
        // Keeps the object the monitor holds, and this window's live connection details, which are never written.
        (cur, next) => (cur ? Object.assign(cur, next, { connectionInfo: cur.connectionInfo ?? next.connectionInfo }) : next),
        s => ({ ...s, connectionInfo: persistableConnectionInfo(s.connectionInfo) }));
    windows = new JsonDir<WindowBeat>(files, 'windows', onError);
    await Promise.all([sessions.load(), windows.load()]);
    for (const s of sessions.values()) {
        // The connection is gone after a reload; demote so the UI offers Connect (which reattaches from the persisted refs).
        if (s.status === 'connected' || s.status === 'connecting') { s.status = 'ready_to_connect'; }
    }
    for (const [id, w] of windows.entries()) { if (!isBeating(w)) { windows.delete(id); } }
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

export function setStatus(session: SlurmSession, status: SlurmSession['status'], errorMessage?: string): void {
    session.status = status;
    if (errorMessage !== undefined) { session.errorMessage = errorMessage; }
    updateSession(session);
}

export function deleteSession(sessionId: string) {
    sessions.delete(sessionId);
    deleteRunsFile(sessionId);
}

export function attachWindow(sessionId: string): void {
    const write = () => windows.set(windowId, { sessionId, at: Date.now() });
    write();
    beat = setInterval(write, BEAT_MS);
}

export function detachWindow(): Promise<void> | undefined {
    clearInterval(beat);
    return windows?.delete(windowId);
}

export function windowState(s: SlurmSession): { isCurrent: boolean; windowAlive: boolean } {
    return { isCurrent: windows.get(windowId)?.sessionId === s.id, windowAlive: windows.values().some(w => w.sessionId === s.id && isBeating(w)) };
}

// Heartbeats fire it too.
export function onSessionsChange(listener: () => void): { dispose(): void } {
    const subs = [sessions.onDidChange(listener), windows.onDidChange(listener)];
    return { dispose: () => subs.forEach(s => s.dispose()) };
}
