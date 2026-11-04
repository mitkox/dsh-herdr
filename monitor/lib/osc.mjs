/**
 * OSC 7501 reporter for herdr-core.
 *
 * Wire format (herdr-core 0.1.17, verified empirically — see
 * monitor/TESTING.md):
 *
 *   ESC ] 7501 ; key=value (":" key=value)* ESC \
 *
 * `title` and `msg` MUST be base64 (the parser drops them otherwise); every
 * other field is plain text. Accepted state words: idle | working | done |
 * blocked | error | clear. `kind` is only meaningful with blocked and is one
 * of permission | question | auth. A report with an `id` creates a child
 * record; without `id` it replaces the terminal's root record.
 *
 * The reporter is a no-op unless the process runs inside a herdr-core terminal
 * (HC_TERMINAL_ID + HC_TERMINAL_SOCKET are injected there) or the caller
 * forces it. It never throws: a broken stdout must not kill the monitor.
 */
export const OSC_START = '\u001b]7501;';
export const OSC_END = '\u001b\\';
export const ALLOWED_STATES = new Set(['idle', 'working', 'done', 'blocked', 'error', 'clear']);
export const ALLOWED_KINDS = new Set(['permission', 'question', 'auth']);

/** True when the current process runs inside a herdr-core terminal. */
export function isHerdrTerminal(env = process.env) {
	return Boolean(env.HC_TERMINAL_ID && env.HC_TERMINAL_SOCKET);
}

/**
 * Auto-enable OSC only when the process looks like it owns a herdr terminal's
 * PTY. DSH tool children inherit HC_TERMINAL_ID/HC_TERMINAL_SOCKET (the host
 * itself runs in a herdr pane) but have piped stdout: emitting OSC there would
 * be captured as text, not parsed by herdr-core. `--osc` forces it on.
 */
export function shouldAutoEnableOsc(stream = process.stdout, env = process.env) {
	return isHerdrTerminal(env) && Boolean(stream?.isTTY);
}

/** Base64 without padding surprises: herdr-core decodes standard base64. */
export function b64(text) {
	return Buffer.from(String(text ?? ''), 'utf8').toString('base64');
}

/** Strip control characters / newlines that would corrupt the OSC payload. */
function oneLine(text) {
	return String(text ?? '')
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function clip(text, length) {
	const one = oneLine(text);
	if (one.length <= length) return one;
	return `${one.slice(0, Math.max(0, length - 1))}…`;
}

/** Build one OSC 7501 sequence; exported for tests. */
export function buildOscReport({ state, kind = null, progress = null, app = 'dsh-tui', title = '', msg = '', id = null }) {
	const fields = [`state=${state}`];
	if (id) fields.push(`id=${oneLine(id)}`);
	if (kind) fields.push(`kind=${oneLine(kind)}`);
	if (progress !== null && Number.isInteger(progress)) fields.push(`progress=${progress}`);
	if (app) fields.push(`app=${oneLine(app)}`);
	if (title) fields.push(`title=${b64(clip(title, 120))}`);
	if (msg) fields.push(`msg=${b64(clip(msg, 200))}`);
	return `${OSC_START}${fields.join(':')}${OSC_END}`;
}

/**
 * Debounced reporter: writes only when the reported tuple changed, plus a
 * periodic heartbeat so a viewer that (re)connects soon sees the latest state.
 */
export class OscReporter {
	/**
	 * @param {object} [opts]
	 * @param {NodeJS.WritableStream} [opts.stream] - usually process.stdout
	 * @param {boolean} [opts.enabled] - defaults to shouldAutoEnableOsc()
	 * @param {string} [opts.app] - reported app name ("dsh-tui" gets Herdr's DeepSeek Harness name/icon)
	 * @param {number} [opts.minIntervalMs] - at most one report per interval
	 * @param {number} [opts.heartbeatMs] - repeat unchanged state at this interval
	 * @param {() => number} [opts.now]
	 */
	constructor({
		stream = process.stdout,
		enabled = shouldAutoEnableOsc(stream),
		app = process.env.DSH_HERDR_APP ?? 'dsh-tui',
		minIntervalMs = 300,
		heartbeatMs = 15_000,
		now = Date.now,
	} = {}) {
		this.stream = stream;
		this.enabled = enabled;
		this.app = app;
		this.minIntervalMs = minIntervalMs;
		this.heartbeatMs = heartbeatMs;
		this.now = now;
		this._lastKey = null;
		this._lastWriteAt = 0;
		this._closed = false;
		this.reports = 0;
		this.suppressed = 0;
	}

	/**
	 * Report a state tuple. Returns true when bytes were written.
	 * @param {{state:string, kind?:string|null, progress?:number|null, title?:string, msg?:string}} report
	 */
	report({ state, kind = null, progress = null, title = '', msg = '' }) {
		if (!this.enabled) return false;
		if (!ALLOWED_STATES.has(state)) throw new Error(`unhandled herdr state: ${state}`);
		if (kind !== null && !ALLOWED_KINDS.has(kind)) kind = null;
		const key = JSON.stringify([state, kind ?? '', progress ?? '', title ?? '', msg ?? '']);
		const at = this.now();
		const changed = key !== this._lastKey;
		const dueHeartbeat = at - this._lastWriteAt >= this.heartbeatMs;
		if (!changed && !dueHeartbeat) {
			this.suppressed += 1;
			return false;
		}
		if (changed && at - this._lastWriteAt < this.minIntervalMs) {
			this.suppressed += 1;
			return false;
		}
		const line = buildOscReport({ state, kind, progress, app: this.app, title, msg });
		try {
			this.stream.write(line);
		} catch {
			return false;
		}
		this._lastKey = key;
		this._lastWriteAt = at;
		this.reports += 1;
		return true;
	}

	/** Remove the terminal's root record when the monitor exits. */
	close() {
		if (!this.enabled || this._closed) return;
		this._closed = true;
		try {
			this.stream.write(`${OSC_START}state=clear${OSC_END}`);
		} catch {
			// ignore
		}
	}
}
