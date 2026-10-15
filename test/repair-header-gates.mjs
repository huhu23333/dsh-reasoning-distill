// Run: node --experimental-transform-types test/repair-header-gates.mjs [host checkout]
// End-to-end script admission: no real user logs are read or changed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkout = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'otherProject/deepseek-harness'));
const { SessionLogScanner } = await import(pathToFileURL(path.join(checkout, 'packages/session/session-persistence-jsonl/src/format.ts')).href);
const root = fs.mkdtempSync(path.resolve(repo, '..', 'astra-header-probe-'));
const header = { type: 'session', version: 4, id: 'session-header-probe', createdAt: 1, isSeeded: false, delegationDepth: 0 };
let failures = 0;
let count = 0;
const check = (label, pass) => { count++; console.log(`${pass ? 'ok' : 'FAIL'} ${label}`); if (!pass) failures++; };
try {
  // A minimal unknown ignorable event is valid; the repair's job is only to mark it.
  const event = { type: 'astra/probe', seq: 0, time: 1, data: {} };
  for (const variant of ['valid', 'isSeeded', 'version', 'delegationDepth']) {
    for (const script of ['repair-plugin-events', 'repair-header-fields']) {
      const candidate = { ...header, ...(variant === 'valid' ? {} : { [variant]: variant === 'version' ? 3 : variant === 'isSeeded' ? 'false' : null }) };
      let hostAccepts = true;
      try { new SessionLogScanner(Buffer.from(`${JSON.stringify(candidate)}\n`), 'strict'); } catch { hostAccepts = false; }
      check(`host header verdict ${variant}/${script}`, hostAccepts === (variant === 'valid'));
      const dir = path.join(root, `${script}-${variant}`);
      fs.mkdirSync(dir);
      const wire = script === 'repair-header-fields' ? { ...candidate, seedLength: 0 } : candidate;
      const events = script === 'repair-header-fields' ? [] : [event];
      const file = path.join(dir, 'session.v4.jsonl.zstd');
      const bytes = zstdCompressSync(Buffer.from([wire, ...events].map(row => JSON.stringify(row)).join('\n') + '\n'));
      fs.writeFileSync(file, bytes);
      const out = execFileSync(process.execPath, [path.join(repo, 'scripts', `${script}.mjs`), '--apply', '--root', dir,
        '--host', path.join(checkout, 'packages/core/session/lib/index.js')], { encoding: 'utf8' });
      const changed = !bytes.equals(fs.readFileSync(file));
      check(`${script} ${variant}: ${out.trim().split('\n').at(-1)}`, changed === (variant === 'valid'));
      check(`${script} ${variant}: backup follows admission`, fs.readdirSync(dir).filter(name => name.includes('.bak-')).length === (variant === 'valid' ? 1 : 0));
    }
  }
} finally {
  // Only remove the mkdtemp directory created above, after verifying its absolute parent/name.
  assert.equal(path.dirname(root), path.dirname(repo));
  assert.ok(path.basename(root).startsWith('astra-header-probe-'));
  const resolved = fs.realpathSync(root);
  assert.equal(path.dirname(resolved), fs.realpathSync(path.dirname(repo)));
  assert.ok(path.basename(resolved).startsWith('astra-header-probe-'));
  fs.rmSync(resolved, { recursive: true });
}
console.log(`${count} checks, ${failures} failures`);
process.exitCode = failures === 0 ? 0 : 1;
