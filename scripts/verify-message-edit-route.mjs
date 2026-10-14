#!/usr/bin/env node
// Acceptance probe for the message-edit timeline route.
//
// Usage: node scripts/verify-message-edit-route.mjs <loaded-session-id> [unloaded-session-id]
// Run after restarting dsh web (the server bundle is only read at host startup).
//
// A loaded session must answer 200 with a complete, byte-bounded payload and no
// error field; an unloaded session must answer 200 with empty arrays plus a notice
// instead of the old 409 error body.
const base = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
const [loaded, unloaded] = process.argv.slice(2);
if (loaded === undefined) {
  console.error('usage: node scripts/verify-message-edit-route.mjs <loaded-session-id> [unloaded-session-id]');
  process.exit(2);
}

const FIELDS = ['messages', 'retryableTurns', 'versions', 'undoStack', 'redoSessionIds'];
let failures = 0;

async function probe(sessionId, kind) {
  const started = process.hrtime.bigint();
  const response = await fetch(`${base}/message-edit?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  const text = await response.text();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const bytes = Buffer.byteLength(text, 'utf8');
  const label = `${kind} ${sessionId} status=${String(response.status)} time=${ms.toFixed(1)}ms bytes=${String(bytes)}`;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    console.log(`FAIL ${label} (not JSON: ${text.slice(0, 120)})`);
    failures += 1;
    return;
  }
  if (response.status !== 200) {
    console.log(`FAIL ${label} body=${text.slice(0, 160)}`);
    failures += 1;
    return;
  }
  if (typeof body.error === 'string') {
    console.log(`FAIL ${label} error=${body.error}`);
    failures += 1;
    return;
  }
  const missing = FIELDS.filter(field => !Array.isArray(body[field]));
  if (missing.length > 0) {
    console.log(`FAIL ${label} missing arrays: ${missing.join(', ')}`);
    failures += 1;
    return;
  }
  if (kind === 'unloaded' && typeof body.notice !== 'string') {
    console.log(`FAIL ${label} an unloaded session must carry a notice`);
    failures += 1;
    return;
  }
  console.log(
    `ok   ${label} messages=${String(body.messages.length)} retryableTurns=${String(body.retryableTurns.length)} versions=${String(body.versions.length)}` +
    (kind === 'unloaded' ? ` notice="${String(body.notice)}"` : ''),
  );
}

await probe(loaded, 'loaded');
if (unloaded !== undefined) await probe(unloaded, 'unloaded');
console.log(failures === 0 ? 'ROUTE ACCEPTANCE PASSED' : `ROUTE ACCEPTANCE FAILED (${String(failures)})`);
process.exit(failures === 0 ? 0 : 1);
