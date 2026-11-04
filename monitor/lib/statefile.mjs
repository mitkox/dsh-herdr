/**
 * Atomic writer for the shared DSH→Herdr state document.
 *
 * TWO producers share one schema (owner: plugin/STATE-SCHEMA.md):
 *   - dsh-plugin's host plugin  -> state/dsh-agents.json
 *   - this sidecar (no restart) -> state/dsh-sidecar.json
 *
 * Shape (schemaVersion 1):
 * {
 *   schemaVersion: 1,
 *   updatedMs: <ms>,
 *   producer: "dsh-monitor-sidecar",
 *   host: { pid, profile, herdr, terminalId|null },
 *   sessions: [
 *     { id, title, status: "working"|"blocked"|"idle"|"done",
 *       activity: string|null, updatedMs, blockedReason?: "approval"|"question",
 *       source: "log-tail" }
 *   ]
 * }
 *
 * Sessions are ordered blocked > working > idle, newest activity first inside
 * a group. Readers must tolerate unknown fields and file disappearance.
 * Writes are tmp-file + rename so a reader never sees partial JSON.
 */
import { mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const STATE_SCHEMA_VERSION = 1;
/**
 * DEV DEFAULT is under /tmp on purpose: your canonical producer is
 * `bin/dsh-herdr` (Lead-owned) writing ~/.local/state/dsh-herdr/agents.json.
 * This sidecar is a reference/fallback producer, so it must not race the
 * canonical writer. Point DSH_HERDR_STATE at a real path to use it in production
 * (e.g. <repo>/state/dsh-sidecar.json, which the app mod also reads).
 */
export const DEFAULT_STATE_PATH = join(tmpdir(), 'dsh-herdr-sidecar-state.json');

const STATUS_RANK = { blocked: 0, working: 1, idle: 2, done: 3 };

/** Resolve the sidecar state path: DSH_HERDR_STATE > explicit > repo default. */
export function defaultStatePath(env = process.env) {
	return env.DSH_HERDR_STATE || DEFAULT_STATE_PATH;
}

/** Sort + shape one session row; reads tolerate extra keys. */
export function toStateSession(snapshot) {
	const row = {
		id: snapshot.sessionId,
		title: snapshot.title,
		status: snapshot.status === 'done' ? 'done' : snapshot.status,
		activity: snapshot.activity ?? null,
		updatedMs: snapshot.updatedMs ?? snapshot.lastEventAt ?? Date.now(),
		source: 'log-tail',
	};
	if (snapshot.status === 'blocked' && snapshot.blockedReason) row.blockedReason = snapshot.blockedReason;
	return row;
}

export function sortSessions(sessions) {
	const rank = (s) => STATUS_RANK[s.status] ?? 9;
	return [...sessions].sort((a, b) => rank(a) - rank(b) || (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
}

/**
 * Debounced atomic state-file writer.
 * `update()` may be called on every poll tick; bytes are written on change or
 * after `heartbeatMs`, whichever comes first (readers use updatedMs for liveness).
 */
export class StateFileWriter {
	/**
	 * @param {object} [opts]
	 * @param {string} [opts.path]
	 * @param {number} [opts.heartbeatMs]
	 * @param {number} [opts.maxSessions]
	 * @param {object} [opts.host]
	 * @param {() => number} [opts.now]
	 */
	constructor({
		path = defaultStatePath(),
		heartbeatMs = 2500,
		maxSessions = 20,
		host = {},
		now = Date.now,
	} = {}) {
		this.path = path;
		this.heartbeatMs = heartbeatMs;
		this.maxSessions = maxSessions;
		this.now = now;
		this.host = {
			pid: host.pid ?? process.pid,
			profile: host.profile ?? null,
			herdr: host.herdr ?? Boolean(
				process.env.HC_TERMINAL_ID && process.env.HC_TERMINAL_SOCKET && process.stdout.isTTY,
			),
			terminalId: host.terminalId ?? (process.stdout.isTTY ? process.env.HC_TERMINAL_ID ?? null : null),
		};
		this._lastPayload = null;
		this._lastWriteAt = 0;
		this.writes = 0;
		this.lastError = null;
	}

	/**
	 * @param {object[]} snapshots - SessionJournal snapshots (or already-shaped rows with `id`)
	 * @returns {boolean} whether bytes were written
	 */
	update(snapshots) {
		const now = this.now();
		let rows = snapshots.map((snapshot) => (snapshot.id ? snapshot : toStateSession(snapshot)));
		rows = rows.map(({ source = 'log-tail', ...row }) => ({ ...row, source }));
		rows = sortSessions(rows).slice(0, this.maxSessions);
		const content = {
			schemaVersion: STATE_SCHEMA_VERSION,
			producer: 'dsh-monitor-sidecar',
			host: this.host,
			sessions: rows,
		};
		const key = JSON.stringify(content);
		const changed = key !== this._lastPayload;
		if (!changed && now - this._lastWriteAt < this.heartbeatMs) return false;
		try {
			const payload = JSON.stringify({ ...content, updatedMs: now }, null, 2);
			this.#write(payload);
			this._lastPayload = key;
			this._lastWriteAt = now;
			this.writes += 1;
			this.lastError = null;
			return true;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			return false;
		}
	}

	#write(payload) {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp-${process.pid}`;
		writeFileSync(tmp, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
		try {
			renameSync(tmp, this.path);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
	}

	/** Remove the state file on clean shutdown so stale data cannot linger. */
	remove() {
		try {
			rmSync(this.path, { force: true });
		} catch {
			// ignore
		}
	}
}
