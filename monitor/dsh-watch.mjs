#!/usr/bin/env node
/**
 * dsh-watch — watch ONE DeepSeek Harness session live from a herdr-core
 * terminal, with an activity feed and OSC 7501 agent-status reporting.
 *
 * Data source: DSH's append-only session journal
 *   $DSH_HOME/sessions/<cwd-slug>/<session-dir>/session.v4.jsonl.zstd
 * It is read-only: no DSH host API token, no host restart, no sockets touched.
 * Because it reports through OSC 7501, the terminal shows up in Herdr as a
 * "DeepSeek Harness" agent (program name `dsh-tui`, Herdr's built-in entry)
 * with the session title and the current activity as its status message.
 *
 * Usage:
 *   node dsh-watch.mjs                      # newest session in $DSH_HOME/sessions
 *   node dsh-watch.mjs <session-id-prefix>  # pick a session by id prefix
 *   node dsh-watch.mjs --list               # list recent sessions and exit
 *   node dsh-watch.mjs --file <journal>     # explicit session.v4.jsonl.zstd
 *
 * Options:
 *   --sessions-dir <dir>  sessions root (default $DSH_HOME/sessions | ~/.dsh/sessions)
 *   --file <path>         explicit journal file
 *   --poll-ms <n>         journal poll interval (default 400)
 *   --stale-ms <n>        turn with no journal activity => idle after this (default 900000)
 *   --history <n>         initial events to replay in the feed (default 12)
 *   --app <name>          OSC app name (default dsh-tui)
 *   --no-osc | --osc      force OSC off/on (auto = inside a herdr PTY)
 *   --no-color            disable ANSI colors
 *   --verbose             print every journal event type
 *   --once                print history/status then exit
 *   -h, --help
 */
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import {
	SessionJournal,
	defaultSessionsDir,
	findSessionJournals,
	shortId,
	truncate,
} from './lib/sessionlog.mjs';
import { OscReporter, isHerdrTerminal, shouldAutoEnableOsc } from './lib/osc.mjs';
import { clock, eventLine, makeColors } from './lib/format.mjs';

const SCRIPT = 'dsh-watch';

function usage() {
	return `dsh-watch — live activity feed + OSC 7501 status for one DSH session

Usage:
  node dsh-watch.mjs [session-id-prefix] [options]
  node dsh-watch.mjs --list
  node dsh-watch.mjs --file <session.v4.jsonl.zstd>

Options:
  --sessions-dir <dir>  sessions root (default $DSH_HOME/sessions | ~/.dsh/sessions)
  --file <path>         explicit journal file
  --poll-ms <n>         poll interval in ms (default 400)
  --stale-ms <n>        turn with no journal activity becomes idle (default 900000)
  --history <n>         initial events replayed in the feed (default 12)
  --app <name>          OSC app name (default dsh-tui)
  --no-osc / --osc      force OSC off/on (default: auto inside a herdr PTY)
  --no-color            disable colors
  --verbose             print every journal event type
  --once                print then exit
  -h, --help            this help

Journal: <sessions-dir>/<cwd-slug>/<session-dir>/session.v4.jsonl.zstd
`;
}

/** @param {string[]} argv */
function parseArgs(argv) {
	const opts = {
		sessionsDir: undefined,
		file: undefined,
		pollMs: 400,
		staleMs: 15 * 60_000,
		history: 12,
		app: process.env.DSH_HERDR_APP ?? 'dsh-tui',
		osc: null,
		color: undefined,
		verbose: false,
		once: false,
		list: false,
		positional: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`missing value for ${arg}`);
			return value;
		};
		switch (arg) {
			case '-h': case '--help': opts.help = true; break;
			case '--list': opts.list = true; break;
			case '--file': opts.file = next(); break;
			case '--sessions-dir': opts.sessionsDir = next(); break;
			case '--poll-ms': opts.pollMs = Number(next()); break;
			case '--stale-ms': opts.staleMs = Number(next()); break;
			case '--history': opts.history = Number(next()); break;
			case '--app': opts.app = next(); break;
			case '--osc': opts.osc = true; break;
			case '--no-osc': opts.osc = false; break;
			case '--no-color': opts.color = false; break;
			case '--color': opts.color = true; break;
			case '--verbose': opts.verbose = true; break;
			case '--once': opts.once = true; break;
			default:
				if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
				opts.positional.push(arg);
		}
	}
	if (!Number.isFinite(opts.pollMs) || opts.pollMs < 50) throw new Error('--poll-ms must be >= 50');
	if (!Number.isFinite(opts.staleMs) || opts.staleMs < 1000) throw new Error('--stale-ms must be >= 1000');
	return opts;
}

/** Pick the journal to follow from --file / positional / newest. */
function resolveJournal(opts) {
	if (opts.file) {
		if (!existsSync(opts.file)) throw new Error(`journal not found: ${opts.file}`);
		return opts.file;
	}
	const sessionsDir = opts.sessionsDir ?? defaultSessionsDir();
	if (opts.positional.length > 0) {
		const target = opts.positional[0];
		// A direct path to a session directory or journal file also works.
		if (existsSync(target)) {
			const st = statSync(target);
			if (st.isFile()) return target;
			const direct = join(target, 'session.v4.jsonl.zstd');
			if (existsSync(direct)) return direct;
		}
		const journals = findSessionJournals(sessionsDir);
		const wanted = target.replace(/^session-/, '');
		const matches = journals.filter(({ file }) => {
			const id = shortId(file.split('/').at(-2) ?? '');
			return file.includes(wanted) || id.startsWith(wanted.slice(0, 8));
		});
		if (matches.length === 0) {
			throw new Error(`no session matches "${target}" under ${sessionsDir} (try --list)`);
		}
		return matches[0].file;
	}
	const [newest] = findSessionJournals(sessionsDir, { limit: 1 });
	if (!newest) throw new Error(`no session journals under ${sessionsDir}`);
	return newest.file;
}

/** --list: recent sessions with derived status. */
async function listSessions(opts, colors) {
	const sessionsDir = opts.sessionsDir ?? defaultSessionsDir();
	const journals = findSessionJournals(sessionsDir, { maxAgeMs: 7 * 24 * 3600_000, limit: 25 });
	if (journals.length === 0) {
		console.log(`No session journals under ${sessionsDir}`);
		return;
	}
	console.log(colors.bold(`Recent DSH sessions under ${sessionsDir}`));
	for (const { file, mtimeMs } of journals) {
		const journal = new SessionJournal(file, { staleMs: opts.staleMs });
		await journal.refresh();
		const snap = journal.snapshot();
		const marker = snap.status === 'blocked' ? '⏸' : snap.status === 'working' ? '▶' : '·';
		console.log(
			`${marker} ${colors.bold(shortId(snap.sessionId))}  ${clock(snap.updatedMs || mtimeMs)}  `
			+ `${snap.status.padEnd(7)} ${truncate(snap.title, 60)}`,
		);
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		process.stdout.write(usage());
		return;
	}
	const colors = makeColors(process.stdout);
	if (opts.color === false) Object.assign(colors, makeColors({ isTTY: false }));
	if (opts.list) {
		await listSessions(opts, colors);
		return;
	}

	const file = resolveJournal(opts);
	const journal = new SessionJournal(file, { staleMs: opts.staleMs });
	const herdr = isHerdrTerminal();
	const autoOsc = shouldAutoEnableOsc(process.stdout);
	const oscEnabled = opts.osc === true || (opts.osc !== false && autoOsc);
	const osc = new OscReporter({ enabled: oscEnabled, app: opts.app });
	const toolCalls = new Map();

	// Initial read before printing the header so title/status/activity are known.
	const first = await journal.refresh();
	const snap0 = journal.snapshot();
	process.stdout.write(`${colors.bold('◈ dsh-watch')} ${colors.gray('— one DSH session, read-only journal tail')}\n`);
	process.stdout.write(`${colors.gray('journal')} ${file}\n`);
	process.stdout.write(
		`${colors.gray('herdr  ')} ${oscEnabled ? colors.green(`reporting as app=${opts.app} via OSC 7501`) : colors.gray(herdr ? 'herdr env found but stdout is not a TTY — OSC disabled (use --osc to force)' : 'not in a herdr terminal — OSC disabled')}\n`,
	);
	process.stdout.write(`${colors.gray('title  ')} ${colors.bold(snap0.title)}\n`);
	process.stdout.write(`${colors.gray('session')} ${snap0.sessionId}${snap0.cwd ? colors.gray(`  cwd=${snap0.cwd}`) : ''}\n`);
	process.stdout.write('\n');

	const initial = first.events.length > opts.history ? first.events.slice(-opts.history) : first.events;
	for (const event of initial) printEvent(event, colors, opts, toolCalls, 'history');
	let lastStatus = null;
	const report = () => {
		const snap = journal.snapshot();
		if (snap.status !== lastStatus) {
			lastStatus = snap.status;
			const label = snap.status === 'blocked' ? colors.yellow('blocked') : snap.status === 'working' ? colors.cyan('working') : colors.gray('idle');
			process.stdout.write(`${colors.gray(`[${clock()}]`)} ● status: ${label}${snap.activity ? colors.gray(` — ${truncate(snap.activity, 120)}`) : ''}\n`);
		}
		osc.report({
			state: snap.status,
			kind: snap.blockedReason === 'approval' ? 'permission' : snap.blockedReason === 'question' ? 'question' : null,
			title: snap.title,
			msg: snap.activity ?? '',
		});
		return snap;
	};
	const snap = report();
	if (initial.length > 0) process.stdout.write(`${colors.gray(`watching… (${initial.length} history events, poll ${opts.pollMs}ms)`)}\n\n`);
	else process.stdout.write(`${colors.gray(`watching… (poll ${opts.pollMs}ms)`)}\n\n`);

	if (opts.once) {
		process.stdout.write(`${colors.gray('final status:')} ${snap.status} — ${snap.activity}\n`);
		osc.close();
		return;
	}

	let stopping = false;
	const stop = () => { stopping = true; };
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);

	while (!stopping) {
		await sleep(opts.pollMs);
		if (stopping) break;
		const result = await journal.refresh();
		if (!result.changed) {
			// Keep stale detection + heartbeat alive even without new events.
			report();
			continue;
		}
		for (const event of result.events) printEvent(event, colors, opts, toolCalls, 'live');
		report();
	}
	const final = journal.snapshot();
	process.stdout.write(`\n${colors.gray(`stopped watching ${shortId(final.sessionId)} (${final.status})`)}\n`);
	osc.close();
}

function printEvent(event, colors, opts, toolCalls, phase) {
	const line = eventLine(event, colors, { verbose: opts.verbose, toolCalls });
	if (!line) return;
	const at = typeof event.time === 'number' ? event.time : Date.now();
	const suffix = phase === 'history' ? colors.gray('  (history)') : '';
	process.stdout.write(`${colors.gray(`[${clock(at)}]`)} ${line}${suffix}\n`);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
	console.error(`dsh-watch: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
