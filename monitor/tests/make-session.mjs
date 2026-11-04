#!/usr/bin/env node
/**
 * Test fixture helper: write / append DSH session journal frames.
 *
 * A real DSH journal is JSONL compressed as a sequence of zstd frames (one per
 * append). These helpers create the same layout so the monitor can be tested
 * deterministically without a host or a model turn.
 *
 * Usage:
 *   node make-session.mjs init   <journal> <sessionId> [cwd] [title]
 *   node make-session.mjs append <journal> <event-json>
 *   node make-session.mjs event  <journal> <type> [data-json] [seq]
 *
 * Examples:
 *   node tests/make-session.mjs init /tmp/s/session.v4.jsonl.zstd demo-0001 /tmp/work "demo"
 *   node tests/make-session.mjs event /tmp/s/session.v4.jsonl.zstd turn/start '{"turn":1}' 10
 *   node tests/make-session.mjs event /tmp/s/session.v4.jsonl.zstd session/title '{"title":"Fix the build"}' 11
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const [command, journalArg, ...rest] = process.argv.slice(2);
if (!command || !journalArg) {
	console.error('usage: make-session.mjs init|append|event <journal> ...');
	process.exit(2);
}
const journal = resolve(journalArg);
mkdirSync(dirname(journal), { recursive: true });

/** Append one JSON line as its own zstd frame (matches a live host append). */
function appendLine(line) {
	const frame = zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'));
	appendFileSync(journal, frame);
}

switch (command) {
	case 'init': {
		const [sessionId = 'demo-session', cwd = '/tmp/work', title = 'Fixture session'] = rest;
		const now = Date.now();
		const header = {
			type: 'session',
			version: 4,
			id: sessionId,
			createdAt: now,
			cwd,
			isSeeded: false,
			origin: 'user',
			agentPreset: 'standard',
		};
		writeFileSync(journal, zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')));
		appendLine(JSON.stringify({ type: 'session/title', seq: 0, time: now, data: { title, source: { kind: 'fallback' } } }));
		console.log(`initialized ${journal}`);
		break;
	}
	case 'append': {
		if (rest.length !== 1) throw new Error('append needs exactly one JSON argument');
		appendLine(rest[0]);
		console.log('appended');
		break;
	}
	case 'event': {
		const [type, dataJson = '{}', seqArg] = rest;
		const seq = seqArg === undefined ? Date.now() % 100000 : Number(seqArg);
		const event = { type, seq, time: Date.now(), data: JSON.parse(dataJson) };
		appendLine(JSON.stringify(event));
		console.log(`appended ${type} seq=${seq}`);
		break;
	}
	default:
		throw new Error(`unknown command ${command}`);
}
