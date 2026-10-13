/**
 * Offline test stub for `@deepseek-ai/schemastery`.
 *
 * `src/config.ts` builds its schema at module load, so the smoke test needs a
 * chainable stand-in. The smoke test supplies a hand-built live configuration
 * and never relies on this schema producing values.
 * @module dsh-reasoning-distill/test/stubs/schemastery
 */

/** Chainable no-op schema node. */
class Schema {
  /** Declare a default value. */
  default(_value: unknown): this { return this }
  /** Mark the field as a live settings field. */
  volatile(): this { return this }
  /** Mark the field as required. */
  required(): this { return this }
  /** Declare a dictionary of this shape. */
  dict(): this { return this }
}

/** Build one schema node of any kind. */
function node(): Schema {
  return new Schema()
}

const z = {
  object: node,
  string: node,
  boolean: node,
  number: node,
  array: node,
  dict: node,
  literal: node,
}

export default z
export { z }
