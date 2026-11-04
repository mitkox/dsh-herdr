/**
 * DSH session-journal reader — the no-auth, read-only data source for the
 * herdr monitor sidecar.
 *
 * A DSH host persists every session as an append-only JSONL journal:
 *
 *   $DSH_HOME/sessions/<cwd-slug>/<session-dir>/session.v4.jsonl.zstd
 *
 * The file is a *concatenation of zstd frames*: each append is its own frame,
 * so a crash-truncated tail is normal while the host is writing. We decode the
 * whole file on change through a streaming zstd decoder, keep whatever the
 * decoder emitted before an "unexpected end of file" error, and process only
 * complete JSONL lines. The journal is pure observation: reading it never
 * touches the host process, its sockets or its sessions.
 *
 * No npm dependencies. `node:zlib` zstd support needs Node >= 23.8 / 22.15
 * (Node 26 here); on older Node we fall back to the `zstd` binary.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

/** Journal file name inside a session directory. */
export const JOURNAL_NAME = 'session.v4.jsonl.zstd';
/** Matches versioned journal names so a future v5 can be added deliberately. */
export const JOURNAL_RE = /^session\.v(\d+)\.jsonl\.zstd$/;

/** Tools whose pending (unmatched) call means "a human must answer". */
export const QUESTION_TOOLS = new Set(['ask_user_question', 'exit_plan_mode']);

/**
 * Decode a zstd buffer tolerantly. Returns the concatenation of everything the
 * decoder could decode; a truncated trailing frame is not an error for callers
 * because we only consume complete JSONL lines anyway.
 * @param {Buffer} buffer - compressed bytes of the journal.
 * @returns {string} decoded UTF-8 text (possibly ending mid-line).
 */
export function decodeJournal(buffer) {
	if (buffer.length === 0) return '';
	try {
		return zstdDecompressSync(buffer).toString('utf8');
	} catch {
		// Streaming API yields the decodable prefix before reporting truncation.
		return decodePartial(buffer);
	}
}

/**
 * @param {Buffer} buffer
 * @returns {string}
 */
export function decodeJournalAsync(buffer) {
	return new Promise((resolve) => {
		if (buffer.length === 0) return resolve('');
		let chunks = [];
		let settled = false;
		let decoder;
		const finish = () => {
			if (settled) return;
			settled = true;
			const out = Buffer.concat(chunks).toString('utf8');
			chunks = [];
			resolve(out);
		};
		try {
			decoder = createZstdDecompress();
		} catch {
			return resolve(decodePartial(buffer));
		}
		decoder.on('data', (chunk) => chunks.push(chunk));
		decoder.on('error', finish);
		decoder.on('end', finish);
		decoder.end(buffer);
	});
}

/** Synchronous fallback used when streaming is unavailable (old Node). */
function decodePartial(buffer) {
	try {
		const r = spawnSync('zstd', ['-dcq'], { input: buffer, maxBuffer: 256 * 1024 * 1024 });
		if (r.stdout && r.stdout.length > 0) return r.stdout.toString('utf8');
	} catch {
		// fall through
	}
	try {
		// Last resort: zstdDecompressSync may still return the complete prefix on
		// some Node versions.
		return zstdDecompressSync(buffer, { finishFlush: zlibConstant('ZSTD_e_flush') ?? 0 }).toString('utf8');
	} catch {
		return '';
	}
}

/** @param {string} name @returns {number|null} */
function zlibConstant(name) {
	// node:zlib exposes no zstd flush constants as JS numbers; keep the option
	// out unless the runtime provides it.
	return undefined;
}

/** Default sessions root: $DSH_HOME/sessions, else ~/.dsh/sessions. */
export function defaultSessionsDir(env = process.env) {
	const home = env.DSH_HOME ?? join(env.HOME ?? process.cwd(), '.dsh');
	return join(home, 'sessions');
}

/**
 * Enumerate session journals under a sessions root (recursive, bounded depth).
 * @param {string} root - e.g. ~/.dsh/sessions
 * @param {{maxAgeMs?: number, limit?: number}} [opts]
 * @returns {{file:string, mtimeMs:number, size:number, dir:string}[]} newest first
 */
export function findSessionJournals(root, { maxAgeMs = 0, limit = Infinity } = {}) {
	const out = [];
	const now = Date.now();
	/** @param {string} dir @param {number} depth */
	const walk = (dir, depth) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (depth < 4) walk(full, depth + 1);
				continue;
			}
			if (!entry.isFile() || !JOURNAL_RE.test(entry.name)) continue;
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (maxAgeMs > 0 && now - st.mtimeMs > maxAgeMs) continue;
			out.push({ file: full, mtimeMs: st.mtimeMs, size: st.size, dir });
		}
	};
	walk(root, 0);
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out.slice(0, limit === Infinity ? undefined : limit);
}

/** Extract the session id from a journal path (`.../<id>/session.v4...`). */
export function sessionIdFromPath(file) {
	const dir = basename(join(file, '..'));
	return dir.replace(/^session-/, '') === dir ? dir : dir;
}

/** `abcdef12` style short id for display. */
export function shortId(sessionId) {
	if (!sessionId) return '????????';
	return String(sessionId).replace(/^session-/, '').slice(0, 8);
}

/**
 * One journal being followed. `refresh()` is idempotent and cheap when the
 * file has not changed. State is derived purely from journal events.
 */
export class SessionJournal {
	/**
	 * @param {string} file - absolute path to session.v4.jsonl.zstd
	 * @param {{staleMs?:number, now?:()=>number}} [opts]
	 */
	constructor(file, { staleMs = 15 * 60_000, now = Date.now } = {}) {
		this.file = file;
		this.staleMs = staleMs;
		this.now = now;

		// journal metadata
		this.sessionId = null;
		this.cwd = null;
		this.agentPreset = null;
		this.parentSession = null;
		this.origin = null;
		this.createdAt = null;
		this.title = null;

		// activity state
		this.turn = 0;
		this.step = 0;
		this.running = false;
		this.turnStartedAt = null;
		this.lastTurnEnd = null;
		this.lastEventType = null;
		this.lastEventAt = null;
		this.lastSeq = -1;
		this.activity = null;
		this.activityAt = null;
		this.lastAssistantText = null;
		this.lastUserText = null;
		this.lastTool = null;
		this.lastError = null;
		this.eventCount = 0;

		/** @type {Map<string,{toolName:string,callId?:string,askedAt:number,reason?:string}>} */
		this.pendingApprovals = new Map();
		/** @type {Map<string,{name:string,startedAt:number,summary:string}>} */
		this.pendingTools = new Map();

		// tailing bookkeeping
		this._size = -1;
		this._mtimeMs = -1;
		this._lineCount = 0;
		this._lastGoodText = '';
		this.missing = false;
		this.decodeErrors = 0;
	}

	/**
	 * Read + apply new journal lines.
	 * @returns {Promise<{changed:boolean, events:object[], snapshot:object}>}
	 */
	async refresh() {
		let buffer;
		let mtimeMs;
		try {
			const st = statSync(this.file);
			if (st.size === this._size && st.mtimeMs === this._mtimeMs) {
				return { changed: false, events: [], snapshot: this.snapshot() };
			}
			buffer = readFileSync(this.file);
			mtimeMs = st.mtimeMs;
		} catch (error) {
			if (error && error.code === 'ENOENT') this.missing = true;
			return { changed: false, events: [], snapshot: this.snapshot() };
		}
		const text = await decodeJournalAsync(buffer);
		if (text.length < this._lastGoodText.length && !text.startsWith(this._lastGoodText)) {
			// Journal was rewritten/compacted: start over from the new content.
			this._lineCount = 0;
			this._size = -1;
			this._mtimeMs = -1;
		}
		this._lastGoodText = text;
		this._size = buffer.length;
		this._mtimeMs = mtimeMs;

		// Complete lines are always everything before the final '\n'-separated
		// segment: a file that ends with '\n' yields a trailing empty segment,
		// and a host still writing a frame leaves a partial last line — neither
		// is a processable line.
		const lines = text === '' ? [] : text.split('\n').slice(0, -1);
		const events = [];
		for (let i = this._lineCount; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line === '') continue;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				continue; // truncated / corrupt line: skip, next refresh will retry
			}
			this.#apply(event);
			events.push(event);
		}
		this._lineCount = lines.length;
		if (events.length > 0) this.missing = false;
		return { changed: events.length > 0, events, snapshot: this.snapshot() };
	}

	/** Fold one journal event into the state. */
	#apply(event) {
		const type = event.type;
		const data = event.data ?? {};
		const at = typeof event.time === 'number' ? event.time : this.now();
		this.eventCount += 1;
		this.lastEventType = type;
		this.lastEventAt = at;
		if (typeof event.seq === 'number' && event.seq > this.lastSeq) this.lastSeq = event.seq;

		switch (type) {
			case 'session': {
				this.sessionId = event.id ?? this.sessionId;
				this.cwd = event.cwd ?? this.cwd;
				this.agentPreset = event.agentPreset ?? this.agentPreset;
				this.parentSession = event.parentSession ?? this.parentSession;
				this.origin = event.origin ?? this.origin;
				this.createdAt = event.createdAt ?? this.createdAt;
				return;
			}
			case 'session/title': {
				if (typeof data.title === 'string' && data.title.trim() !== '') {
					this.title = data.title.trim();
					this.#activity(`title: ${this.title}`, at);
				}
				return;
			}
			case 'turn/start': {
				this.turn = typeof data.turn === 'number' ? data.turn : this.turn + 1;
				this.running = true;
				this.turnStartedAt = at;
				this.lastError = null;
				this.#activity('turn started', at);
				return;
			}
			case 'turn/end': {
				this.running = false;
				if (typeof data.turn === 'number' && data.turn > this.turn) this.turn = data.turn;
				const reason = data.reason ?? null;
				this.lastTurnEnd = { turn: data.turn ?? this.turn, reason, at };
				if (reason && reason.kind === 'error') {
					const msg = reason.error?.message ?? reason.error ?? 'unknown error';
					this.lastError = String(msg);
					this.#activity(`turn error: ${this.lastError}`, at);
				} else {
					this.#activity(`turn ${this.turn} ${reason?.kind ?? 'done'}`, at);
				}
				return;
			}
			case 'step/start': {
				this.step = typeof data.step === 'number' ? data.step : this.step;
				return;
			}
			case 'tool/call': {
				const callId = data.callId ?? `anon-${event.seq}`;
				const name = data.name ?? 'tool';
				const summary = describeArguments(data.arguments);
				this.pendingTools.set(callId, { name, startedAt: at, summary });
				this.lastTool = { name, at, callId };
				this.#activity(summary ? `${name}: ${summary}` : name, at);
				return;
			}
			case 'tool/result': {
				const callId = data.message?.toolCallId
					?? data.message?.source?.callId
					?? data.toolCallId
					?? null;
				let name = this.lastTool?.name ?? 'tool';
				if (callId && this.pendingTools.has(callId)) {
					name = this.pendingTools.get(callId).name;
					this.pendingTools.delete(callId);
				}
				const failed = Boolean(data.error) || Boolean(data.message?.error);
				const errorText = data.error?.message ?? data.message?.error?.message ?? '';
				this.#activity(failed ? `${name} failed${errorText ? `: ${truncate(errorText, 80)}` : ''}` : `${name} done`, at);
				if (failed) this.lastError = String(errorText || `${name} failed`);
				return;
			}
			case 'approval/asked': {
				const id = data.id ?? `approval-${event.seq}`;
				this.pendingApprovals.set(id, {
					toolName: data.toolName ?? 'tool',
					callId: data.callId,
					askedAt: at,
					reason: data.reason,
				});
				this.#activity(`approval needed: ${data.toolName ?? 'tool'}`, at);
				return;
			}
			case 'approval/decided': {
				this.pendingApprovals.delete(data.id ?? '');
				this.#activity(`approval ${data.outcome ?? 'decided'}`, at);
				return;
			}
			case 'assistant/message': {
				const text = extractText(data.message?.content);
				if (text) {
					this.lastAssistantText = text;
					this.#activity(firstLine(text), at);
				}
				return;
			}
			case 'user/message': {
				const text = extractText(data.content);
				if (text) {
					this.lastUserText = text;
					this.#activity(`user: ${truncate(firstLine(text), 80)}`, at);
				}
				return;
			}
			case 'command/run': {
				this.#activity(`command: ${truncate(JSON.stringify(data).slice(0, 100), 100)}`, at);
				return;
			}
			case 'todo/write': {
				this.#activity('todos updated', at);
				return;
			}
			case 'job/registered': {
				const label = data.name ?? data.title ?? data.kind ?? data.jobId ?? 'job';
				this.#activity(`job started: ${truncate(String(label), 80)}`, at);
				return;
			}
			case 'job/settled': {
				const label = data.name ?? data.title ?? data.kind ?? data.jobId ?? 'job';
				this.#activity(`job settled: ${truncate(String(label), 80)}`, at);
				return;
			}
			default:
				return;
		}
	}

	#activity(text, at) {
		this.activity = text;
		this.activityAt = at;
	}

	/** Pending approval (oldest first) or null. */
	pendingApproval() {
		let found = null;
		for (const entry of this.pendingApprovals.values()) {
			if (!found || entry.askedAt < found.askedAt) found = entry;
		}
		return found;
	}

	/** Pending question tool (oldest first) or null. */
	pendingQuestion() {
		let found = null;
		for (const entry of this.pendingTools.values()) {
			if (!QUESTION_TOOLS.has(entry.name)) continue;
			if (!found || entry.startedAt < found.startedAt) found = entry;
		}
		return found;
	}

	/**
	 * Derived monitor status.
	 * Precedence: blocked (approval > question) > working > idle.
	 * A turn with no journal activity for `staleMs` is reported idle/stale so a
	 * crashed host cannot leave a terminal "working" forever.
	 * @returns {{status:'working'|'blocked'|'idle', blockedReason:null|'approval'|'question', activity:string, stale:boolean}}
	 */
	deriveStatus() {
		const approval = this.pendingApproval();
		if (approval) {
			return {
				status: 'blocked',
				blockedReason: 'approval',
				activity: `approval: ${approval.toolName}`,
				stale: false,
			};
		}
		const question = this.pendingQuestion();
		if (question) {
			return {
				status: 'blocked',
				blockedReason: 'question',
				activity: question.summary ? `question: ${question.summary}` : 'question: waiting',
				stale: false,
			};
		}
		if (this.running) {
			const stale = this.lastEventAt !== null && this.now() - this.lastEventAt > this.staleMs;
			return {
				status: stale ? 'idle' : 'working',
				blockedReason: null,
				activity: stale ? `stale: no journal activity for ${Math.round((this.now() - this.lastEventAt) / 1000)}s` : (this.activity ?? 'working'),
				stale,
			};
		}
		return {
			status: 'idle',
			blockedReason: null,
			activity: this.activity ?? 'idle',
			stale: false,
		};
	}

	/** Display title: journal title, else cwd basename + short session id. */
	displayTitle() {
		if (this.title) return this.title;
		const id = shortId(this.sessionId ?? sessionIdFromPath(this.file));
		if (this.cwd) {
			const base = basename(this.cwd) || this.cwd;
			return `${base} (${id})`;
		}
		return id;
	}

	/** Immutable snapshot for feed/OSC/state consumers. */
	snapshot() {
		const { status, blockedReason, activity, stale } = this.deriveStatus();
		return {
			file: this.file,
			sessionId: this.sessionId ?? sessionIdFromPath(this.file),
			shortId: shortId(this.sessionId ?? sessionIdFromPath(this.file)),
			title: this.displayTitle(),
			cwd: this.cwd,
			agentPreset: this.agentPreset,
			parentSession: this.parentSession,
			origin: this.origin,
			status,
			blockedReason,
			activity,
			stale,
			running: this.running,
			turn: this.turn,
			step: this.step,
			lastEventType: this.lastEventType,
			lastEventAt: this.lastEventAt,
			updatedMs: this.lastEventAt ?? 0,
			pendingApprovals: this.pendingApprovals.size,
			pendingTools: this.pendingTools.size,
			eventCount: this.eventCount,
			lastError: this.lastError,
			missing: this.missing,
		};
	}
}

/** Join the visible text blocks of a DSH message content array. */
export function extractText(content) {
	if (!Array.isArray(content)) return '';
	const parts = [];
	for (const block of content) {
		if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
	}
	return parts.join('\n').trim();
}

/** First non-empty line, collapsed to one display line. */
export function firstLine(text) {
	const line = String(text ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
	return truncate(line, 160);
}

/** Truncate with an ellipsis, collapse whitespace. */
export function truncate(text, length = 100) {
	const one = String(text ?? '').replace(/\s+/g, ' ').trim();
	if (one.length <= length) return one;
	return `${one.slice(0, Math.max(0, length - 1))}…`;
}

/**
 * One-line human summary of a tool call's arguments JSON.
 * Handles the shipped DSH tools we see in journals; falls back to the first
 * meaningful JSON string value.
 * @param {string|undefined} argumentsJson
 */
export function describeArguments(argumentsJson) {
	if (typeof argumentsJson !== 'string' || argumentsJson === '') return '';
	let args;
	try {
		args = JSON.parse(argumentsJson);
	} catch {
		return truncate(argumentsJson, 100);
	}
	if (!args || typeof args !== 'object') return truncate(String(args), 80);
	const pick = (...keys) => {
		for (const key of keys) {
			const value = args[key];
			if (typeof value === 'string' && value !== '') return value;
		}
		return null;
	};
	const command = pick('command', 'cmd', 'script');
	if (command) return `$ ${truncate(command, 110)}`;
	const file = pick('file_path', 'path', 'filePath', 'target');
	const pattern = pick('pattern', 'query', 'search');
	if (pattern && file) return `${truncate(pattern, 50)} in ${truncate(file, 60)}`;
	if (file) return truncate(file, 110);
	if (pattern) return truncate(pattern, 110);
	const url = pick('url');
	if (url) return truncate(url, 110);
	const question = args.questions?.[0]?.question ?? args.questions?.[0]?.title;
	if (typeof question === 'string') return truncate(question, 110);
	if (typeof args.subject === 'string') return truncate(args.subject, 110);
	if (typeof args.task_id === 'string') return truncate(args.task_id, 60);
	if (typeof args.objective === 'string') return truncate(args.objective, 110);
	// Fall back to the first string value in a stable key order.
	for (const value of Object.values(args)) {
		if (typeof value === 'string' && value.trim() !== '') return truncate(value, 110);
	}
	return '';
}
