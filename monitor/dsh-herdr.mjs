#!/usr/bin/env node
/**
 * dsh-herdr — watch ALL DeepSeek Harness sessions from one herdr-core
 * terminal, and publish the aggregate agent state for Herdr.
 *
 * Two outputs, same source (read-only DSH session journals):
 *   1. a live aggregate activity feed in the terminal (every session, prefixed);
 *   2. OSC 7501 status on the terminal itself (app="dsh-tui") AND an atomic
 *      JSON state file consumed by the herdr-app monitor mod. You's
 *      canonical producer is bin/dsh-herdr (Lead-owned) writing
 *      ~/.local/state/dsh-herdr/agents.json; this sidecar defaults to a DEV
 *      path under /tmp so the two never race. Set DSH_HERDR_STATE (or
 *      --state-file) to write a real location, e.g.
 *      <repo>/state/dsh-sidecar.json.
 *      Schema: plugin/STATE-SCHEMA.md, schemaVersion 1; the dsh-plugin
 *      host plugin owns state/dsh-agents.json (single writer per file).
 *
 * Nothing here talks to the DSH host: no token, no SSE, no restart, no prompt.
 * Sessions are discovered as append-only journals under $DSH_HOME/sessions.
 *
 * Usage:
 *   node dsh-herdr.mjs                          # watch ~/.dsh/sessions forever
 *   node dsh-herdr.mjs --sessions-dir /tmp/x/sessions
 *   node dsh-herdr.mjs --once                   # one scan, write state, exit
 *
 * Options:
 *   --sessions-dir <dir>   sessions root (default $DSH_HOME/sessions | ~/.dsh/sessions)
 *   --poll-ms <n>          journal poll interval (default 500)
 *   --rescan-ms <n>        directory rescan interval (default 2500)
 *   --max-age-hours <n>    only watch journals modified within n hours (default 48)
 *   --max-sessions <n>     cap watched/published sessions (default 20)
 *   --state-file <path>    state JSON path (default DSH_HERDR_STATE | /tmp/dsh-herdr-sidecar-state.json)
 *   --no-state             do not write the state file
 *   --app <name>           OSC app name (default dsh-tui)
 *   --no-osc | --osc       force OSC off/on (default auto inside Herdr)
 *   --no-color             disable colors
 *   --verbose              print every journal event type
 *   --once                 one scan: summary + state file write, then exit
 *   -h, --help
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	SessionJournal,
	defaultSessionsDir,
	findSessionJournals,
	shortId,
	truncate,
} from './lib/sessionlog.mjs';
import { OscReporter, isHerdrTerminal, shouldAutoEnableOsc } from './lib/osc.mjs';
import { StateFileWriter, defaultStatePath } from './lib/statefile.mjs';
import { clock, eventLine, makeColors, sessionColor, statusText } from './lib/format.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = 'dsh-herdr';

function usage() {
	return `dsh-herdr — aggregate DSH watcher: live feed + OSC 7501 + state JSON

Usage:
  node dsh-herdr.mjs [options]

Options:
  --sessions-dir <dir>   sessions root (default $DSH_HOME/sessions | ~/.dsh/sessions)
  --poll-ms <n>          journal poll interval (default 500)
  --rescan-ms <n>        directory rescan interval (default 2500)
  --max-age-hours <n>    only watch journals modified within n hours (default 48)
  --max-sessions <n>     cap watched/published sessions (default 20)
  --state-file <path>    state JSON path (default DSH_HERDR_STATE | /tmp/dsh-herdr-sidecar-state.json)
  --no-state             do not write the state file
  --app <name>           OSC app name (default dsh-tui)
  --no-osc / --osc       force OSC off/on (default: auto inside Herdr)
  --no-color             disable colors
  --verbose              print every journal event type
  --once                 one scan: summary + state file write, then exit
  -h, --help

State schema (schemaVersion 1, shared with the dsh-plugin host plugin):
  { schemaVersion, updatedMs, producer, host, sessions: [
      { id, title, status: working|blocked|idle|done, activity, updatedMs,
        blockedReason?, source: "log-tail" } ] }
`;
}

/** @param {string[]} argv */
function parseArgs(argv) {
	const opts = {
		sessionsDir: undefined,
		pollMs: 500,
		rescanMs: 2500,
		maxAgeHours: 48,
		maxSessions: 20,
		stateFile: undefined,
		writeState: true,
		app: process.env.DSH_HERDR_APP ?? 'dsh-tui',
		osc: null,
		color: undefined,
		verbose: false,
		once: false,
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
			case '--sessions-dir': opts.sessionsDir = next(); break;
			case '--poll-ms': opts.pollMs = Number(next()); break;
			case '--rescan-ms': opts.rescanMs = Number(next()); break;
			case '--max-age-hours': opts.maxAgeHours = Number(next()); break;
			case '--max-sessions': opts.maxSessions = Number(next()); break;
			case '--state-file': opts.stateFile = next(); break;
			case '--no-state': opts.writeState = false; break;
			case '--app': opts.app = next(); break;
			case '--osc': opts.osc = true; break;
			case '--no-osc': opts.osc = false; break;
			case '--no-color': opts.color = false; break;
			case '--verbose': opts.verbose = true; break;
			case '--once': opts.once = true; break;
			default: throw new Error(`unknown option ${arg}`);
		}
	}
	if (!Number.isFinite(opts.pollMs) || opts.pollMs < 50) throw new Error('--poll-ms must be >= 50');
	if (!Number.isFinite(opts.rescanMs) || opts.rescanMs < 100) throw new Error('--rescan-ms must be >= 100');
	if (!Number.isFinite(opts.maxSessions) || opts.maxSessions < 1) throw new Error('--max-sessions must be >= 1');
	return opts;
}

/** Resolve and validate the aggregate focus (blocked > working > newest). */
export function deriveAggregate(snapshots) {
	const rank = { blocked: 0, working: 1, idle: 2 };
	const sorted = [...snapshots].sort(
		(a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || (b.updatedMs ?? 0) - (a.updatedMs ?? 0),
	);
	const focus = sorted[0] ?? null;
	const blocked = snapshots.filter((s) => s.status === 'blocked');
	const working = snapshots.filter((s) => s.status === 'working');
	let status = 'idle';
	if (blocked.length > 0) status = 'blocked';
	else if (working.length > 0) status = 'working';
	let msg = focus?.activity ?? '';
	if (status === 'blocked') {
		msg = focus?.activity || (focus?.blockedReason === 'question' ? 'question: waiting' : 'approval: waiting');
		const extra = blocked.length - 1;
		if (extra > 0) msg = `${msg} (+${extra} more blocked)`;
	} else if (status === 'working') {
		const extra = working.length - 1;
		if (extra > 0) msg = `${msg} (+${extra} more working)`;
	}
	return {
		status,
		focus,
		blockedCount: blocked.length,
		workingCount: working.length,
		idleCount: snapshots.filter((s) => s.status === 'idle').length,
		title: focus?.title ?? 'DSH',
		msg,
	};
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		process.stdout.write(usage());
		return;
	}
	const colors = makeColors(process.stdout);
	if (opts.color === false) Object.assign(colors, makeColors({ isTTY: false }));

	const sessionsDir = opts.sessionsDir ?? defaultSessionsDir();
	const herdr = isHerdrTerminal();
	const autoOsc = shouldAutoEnableOsc(process.stdout);
	const oscEnabled = opts.osc === true || (opts.osc !== false && autoOsc);
	const osc = new OscReporter({ enabled: oscEnabled, app: opts.app });
	const statePath = opts.stateFile ?? defaultStatePath();
	const stateWriter = opts.writeState
		? new StateFileWriter({
			path: statePath,
			heartbeatMs: 2500,
			maxSessions: opts.maxSessions,
			host: {
				profile: process.env.DSH_PROFILE ?? null,
				herdr: oscEnabled,
				terminalId: oscEnabled ? process.env.HC_TERMINAL_ID ?? null : null,
			},
		})
		: null;

	process.stdout.write(`${colors.bold('◈ dsh-herdr')} ${colors.gray('— aggregate DSH session watcher')}\n`);
	process.stdout.write(`${colors.gray('sessions')} ${sessionsDir}\n`);
	process.stdout.write(`${colors.gray('state   ')} ${stateWriter ? statePath : colors.gray('disabled')}\n`);
	process.stdout.write(`${colors.gray('herdr   ')} ${oscEnabled ? colors.green(`yes — OSC 7501 app=${opts.app}`) : colors.gray('no (not in a herdr terminal; OSC disabled)')}\n`);

	/** @type {Map<string, SessionJournal>} */
	const journals = new Map();
	/** @type {Map<string, Map<string,{name:string,start:number}>>} */
	const toolCallsByFile = new Map();
	let lastStatusByFile = new Map();
	let aggregateKey = null;

	const scan = () => {
		const maxAgeMs = opts.maxAgeHours > 0 ? opts.maxAgeHours * 3600_000 : 0;
		const found = findSessionJournals(sessionsDir, { maxAgeMs, limit: opts.maxSessions });
		for (const { file } of found) {
			if (!journals.has(file)) {
				journals.set(file, new SessionJournal(file, { staleMs: 15 * 60_000, now: () => Date.now() }));
				toolCallsByFile.set(file, new Map());
			}
		}
		for (const file of [...journals.keys()]) {
			if (!found.some((entry) => entry.file === file)) {
				journals.delete(file);
				toolCallsByFile.delete(file);
			}
		}
		return found;
	};

	const found = scan();
	process.stdout.write(`${colors.gray('found  ')} ${journals.size} session journal(s) in the last ${opts.maxAgeHours}h\n\n`);

	// Initial read of all journals (state only; no history spam), then summary.
	for (const journal of journals.values()) await journal.refresh();
	const printSummary = () => {
		const snapshots = [...journals.values()].map((j) => j.snapshot());
		const ordered = snapshots.sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
		for (const snap of ordered) {
			const color = sessionColor(snap.shortId, colors);
			process.stdout.write(
				`  ${color(shortId(snap.sessionId))} ${statusText(snap.status, colors).padEnd(colors.enabled ? 15 : 8)} `
				+ `${colors.gray(clock(snap.updatedMs || Date.now()))} ${truncate(snap.title, 62)}\n`,
			);
		}
		if (ordered.length > 0) process.stdout.write('\n');
	};
	if (!opts.once) printSummary();

	const writeState = () => {
		if (!stateWriter) return false;
		return stateWriter.update([...journals.values()].map((j) => j.snapshot()));
	};
	const reportOsc = () => {
		const snapshots = [...journals.values()].map((j) => j.snapshot());
		const agg = deriveAggregate(snapshots);
		const key = JSON.stringify([agg.status, agg.title, agg.msg]);
		if (key !== aggregateKey) {
			aggregateKey = key;
			if (!opts.once) {
				const label = agg.status === 'blocked' ? colors.yellow('blocked') : agg.status === 'working' ? colors.cyan('working') : colors.gray('idle');
				process.stdout.write(
					`${colors.gray(`[${clock()}]`)} ● aggregate: ${label} ${colors.gray(`(${agg.blockedCount} blocked, ${agg.workingCount} working, ${agg.idleCount} idle)`)}\n`,
				);
			}
		}
		osc.report({
			state: agg.status,
			kind: agg.status === 'blocked' ? (agg.focus?.blockedReason === 'question' ? 'question' : 'permission') : null,
			title: agg.title,
			msg: agg.msg,
		});
		return agg;
	};

	writeState();
	const firstAgg = reportOsc();

	if (opts.once) {
		process.stdout.write(`${colors.gray('aggregate:')} ${firstAgg.status} — ${truncate(firstAgg.title, 192)}${firstAgg.msg ? ` — ${truncate(firstAgg.msg, 2048)}` : ''}\n`);
		process.stdout.write(`${colors.gray('state write:')} ${stateWriter ? (stateWriter.writes > 0 ? 'ok ' + statePath : 'FAILED ' + stateWriter.lastError) : 'disabled'}\n`);
		osc.close();
		return;
	}

	let stopping = false;
	const stop = () => { stopping = true; };
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);

	let lastScan = Date.now();
	let firstTick = true;
	while (!stopping) {
		await sleep(opts.pollMs);
		if (stopping) break;
		if (Date.now() - lastScan >= opts.rescanMs) {
			lastScan = Date.now();
			const foundNow = scan();
			if (foundNow.length !== journals.size) {
				// A new session appeared: read it immediately so its state is not idle-stale.
				for (const journal of journals.values()) {
					if (!journal._size || journal._size < 0) await journal.refresh();
				}
			}
		}
		let anyChange = false;
		for (const journal of journals.values()) {
			const result = await journal.refresh();
			if (!result.changed) continue;
			anyChange = true;
			const snap = result.snapshot;
			const color = sessionColor(snap.shortId, colors);
			const prefix = color(`[${shortId(snap.sessionId)}]`);
			for (const event of result.events) {
				const line = eventLine(event, colors, { verbose: opts.verbose, toolCalls: toolCallsByFile.get(journal.file) });
				if (!line) continue;
				const at = typeof event.time === 'number' ? event.time : Date.now();
				process.stdout.write(`${prefix} ${colors.gray(clock(at))} ${line}\n`);
			}
			const previous = lastStatusByFile.get(journal.file);
			if (previous !== snap.status) {
				lastStatusByFile.set(journal.file, snap.status);
				if (previous !== undefined && !firstTick) {
					process.stdout.write(`${prefix} ${colors.gray(clock())} ● ${statusText(snap.status, colors)}${snap.activity ? colors.gray(` — ${truncate(snap.activity, 120)}`) : ''}\n`);
				}
			}
		}
		if (firstTick) {
			firstTick = false;
			for (const journal of journals.values()) {
				lastStatusByFile.set(journal.file, journal.snapshot().status);
			}
		}
		writeState();
		if (anyChange) reportOsc();
		else {
			// Heartbeat: OSC reporter has its own heartbeat; state writer too.
			reportOsc();
		}
	}
	process.stdout.write(`\n${colors.gray('dsh-herdr stopped')}\n`);
	osc.close();
	if (stateWriter) {
		// Leave the last document in place (the app shows staleness via updatedMs);
		// removing it would make the panel flicker empty on restarts.
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
	console.error(`dsh-herdr: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
