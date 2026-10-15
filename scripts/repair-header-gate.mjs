// Physical released-v4 JSONL header admission, before any logical-header rebuilding.
// Mirrors session-persistence-jsonl/src/format.ts:isHeaderLine and its v4-only gate.
// That reader's guard is not exported by the built package. The regression fixture
// compares these decisions with the real source reader, not a reconstructed header.
import { isAbsolute } from 'node:path';

export const requiredHeaderKeys = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'];
export const allowedHeaderKeys = new Set([...requiredHeaderKeys, 'cwd', 'parentSession', 'origin', 'agentPreset']);

/** Refuse a physical line that would remain unreadable after an event-only repair. */
export function headerLineRefusal(wire) {
  if (wire === null || typeof wire !== 'object' || Array.isArray(wire)) return 'SKIP writing: the physical header is not an object';
  const stray = Object.keys(wire).filter(key => !allowedHeaderKeys.has(key));
  if (stray.length > 0) return `SKIP writing: the physical header line carries ${stray.join(',')} the read path refuses; run repair-header-fields.mjs first (add --line-only when this log also carries event-level defects)`;
  const missing = requiredHeaderKeys.filter(key => !Object.hasOwn(wire, key));
  if (missing.length > 0) return `SKIP writing: the physical header line lacks ${missing.join(',')}`;
  const natural = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
  if (wire.type !== 'session' || wire.version !== 4 || typeof wire.id !== 'string'
    || !natural(wire.createdAt) || !natural(wire.delegationDepth) || typeof wire.isSeeded !== 'boolean'
    || (wire.cwd !== undefined && (typeof wire.cwd !== 'string' || !isAbsolute(wire.cwd)))
    || (wire.parentSession !== undefined && typeof wire.parentSession !== 'string')
    || (wire.origin !== undefined && wire.origin !== 'subagent')
    || (wire.agentPreset !== undefined && typeof wire.agentPreset !== 'string')) {
    return 'SKIP writing: the physical header line has invalid field values (requires a released-v4 header without coercion)';
  }
  return undefined;
}
