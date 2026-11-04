/**
 * Tiny terminal formatting helpers shared by the watch UIs.
 * Colors are emitted only for a TTY and never when NO_COLOR is set.
 */
const ESC = '\u001b[';

/** @param {NodeJS.WriteStream|undefined} stream @param {NodeJS.ProcessEnv} [env] */
export function makeColors(stream = process.stdout, env = process.env) {
	const enabled = Boolean(stream && stream.isTTY) && !env.NO_COLOR && env.TERM !== 'dumb';
	const wrap = (code) => (text) => enabled ? `${ESC}${code}m${text}${ESC}0m` : String(text);
	return {
		enabled,
		bold: wrap('1'),
		dim: wrap('2'),
		red: wrap('31'),
		green: wrap('32'),
		yellow: wrap('33'),
		blue: wrap('34'),
		magenta: wrap('35'),
		cyan: wrap('36'),
		gray: wrap('90'),
	};
}

/** HH:MM:SS in local time. */
export function clock(ms = Date.now()) {
	const date = new Date(ms);
	const pad = (n) => String(n).padStart(2, '0');
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Human age: 3s, 2m, 1h. */
export function age(ms) {
	if (!Number.isFinite(ms) || ms < 0) return '?';
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return `${h}h`;
}

/** A stable accent color per session, for the aggregate feed prefix. */
export function sessionColor(shortId, colors) {
	const palette = [colors.cyan, colors.magenta, colors.blue, colors.green, colors.yellow];
	let hash = 0;
	for (const ch of String(shortId ?? '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
	return palette[hash % palette.length];
}

/** Status glyph + label, colored. */
export function statusText(status, colors) {
	switch (status) {
		case 'working': return colors.cyan('working');
		case 'blocked': return colors.yellow('blocked');
		case 'idle': return colors.gray('idle');
		case 'done': return colors.green('done');
		case 'error': return colors.red('error');
		default: return colors.gray(String(status));
	}
}

/** One feed line for a journal event (without timestamp/prefix).
 * `toolCalls` is an optional Map(callId -> {name, startTime}) so tool results
 * can name their call and show a duration. */
export function eventLine(event, colors, { verbose = false, toolCalls = null } = {}) {
	const data = event.data ?? {};
	const type = event.type;
	switch (type) {
		case 'turn/start':
			return colors.dim(`── turn ${data.turn ?? '?'} started ──`);
		case 'turn/end': {
			const reason = data.reason?.kind ?? 'done';
			const line = `── turn ${data.turn ?? '?'} ended (${reason}) ──`;
			return reason === 'error' ? colors.red(line) : colors.dim(line);
		}
		case 'tool/call': {
			const name = data.name ?? 'tool';
			const summary = formatArgs(data.arguments);
			if (toolCalls && data.callId) toolCalls.set(data.callId, { name, start: event.time });
			return `${colors.blue('⚙')} ${colors.bold(name)}${summary ? colors.gray(` ${summary}`) : ''}`;
		}
		case 'tool/result': {
			const failed = Boolean(data.error) || Boolean(data.message?.error);
			const callId = data.message?.toolCallId ?? data.message?.source?.callId ?? data.toolCallId ?? null;
			const known = callId && toolCalls ? toolCalls.get(callId) : null;
			const name = known?.name ? `${known.name} ` : '';
			const took = known?.start && typeof event.time === 'number' ? ` (${Math.max(0, event.time - known.start)}ms)` : '';
			const errorText = data.error?.message ?? data.message?.error?.message ?? '';
			return failed
				? `${colors.red('✗')} ${colors.red(`${name}failed`)}${errorText ? colors.gray(`: ${oneLine(errorText).slice(0, 160)}`) : ''}`
				: `${colors.green('✓')} ${colors.gray(`${name}done${took}`)}`;
		}
		case 'assistant/message': {
			const text = textBlocks(data.message?.content);
			if (!text && !verbose) return null;
			return `${colors.magenta('💬')} ${firstLine(text)}`;
		}
		case 'user/message': {
			const text = textBlocks(data.content);
			if (!text && !verbose) return null;
			return `${colors.green('👤')} ${firstLine(text)}`;
		}
		case 'approval/asked':
			return `${colors.yellow('⏸')} ${colors.yellow('approval needed')}: ${data.toolName ?? 'tool'}${data.reason ? colors.gray(` — ${firstLine(data.reason)}`) : ''}`;
		case 'approval/decided':
			return `${colors.green('▶')} approval ${data.outcome ?? 'decided'}`;
		case 'session/title':
			return data.title ? `${colors.gray('🏷')} title: ${data.title}` : null;
		case 'step/start':
		case 'step/end':
		case 'request/header':
		case 'request/context':
		case 'session':
		case 'agent/inbox/spliced':
			return verbose ? colors.gray(`${type}`) : null;
		default: {
			if (!verbose) return null;
			const short = JSON.stringify(data).slice(0, 200);
			return colors.gray(`${type} ${short}`);
		}
	}
}

/** Tool argument summary, compact (shares rules with the state activity text). */
export function formatArgs(argumentsJson) {
	if (typeof argumentsJson !== 'string' || argumentsJson === '') return '';
	let args;
	try {
		args = JSON.parse(argumentsJson);
	} catch {
		return String(argumentsJson).slice(0, 100);
	}
	if (!args || typeof args !== 'object') return String(args).slice(0, 80);
	const pick = (...keys) => {
		for (const key of keys) {
			const value = args[key];
			if (typeof value === 'string' && value !== '') return value;
		}
		return null;
	};
	const command = pick('command', 'cmd', 'script');
	if (command) return `$ ${oneLine(command).slice(0, 120)}`;
	const file = pick('file_path', 'path', 'filePath', 'target');
	const pattern = pick('pattern', 'query', 'search');
	if (pattern && file) return `${oneLine(pattern).slice(0, 50)} in ${oneLine(file).slice(0, 70)}`;
	if (file) return oneLine(file).slice(0, 120);
	if (pattern) return oneLine(pattern).slice(0, 120);
	const url = pick('url');
	if (url) return oneLine(url).slice(0, 120);
	const question = args.questions?.[0]?.question;
	if (typeof question === 'string') return oneLine(question).slice(0, 120);
	if (typeof args.subject === 'string') return oneLine(args.subject).slice(0, 120);
	if (typeof args.objective === 'string') return oneLine(args.objective).slice(0, 120);
	for (const value of Object.values(args)) {
		if (typeof value === 'string' && value.trim() !== '') return oneLine(value).slice(0, 120);
	}
	return '';
}

function oneLine(text) {
	return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function textBlocks(content) {
	if (!Array.isArray(content)) return '';
	return content
		.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text)
		.join('\n')
		.trim();
}

function firstLine(text) {
	return text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
}
