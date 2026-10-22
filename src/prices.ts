/**
 * Price tables shared by the host half and the browser half.
 *
 * This module must stay import-free: the Settings page uses the same shipped
 * defaults to decide whether a model's cost is split into peak / off-peak
 * columns, and pulling the host resolver (which imports schemastery) into the
 * client bundle would break it.
 * @module dsh-reasoning-distill/prices
 */

/** One API price bucket, in currency units per million tokens. */
export interface PriceBucket {
  /** Input billed against a cache hit. */
  hit: number
  /** Input billed without a cache hit. */
  miss: number
  /** Model output (reasoning tokens are output tokens). */
  out: number
}

/** One model's price entry: two columns plus whether the second is used at all. */
export interface ModelPrices {
  /** The price actually used when peak pricing is off. */
  peak: PriceBucket
  /** Second column; only consulted when {@link ModelPrices.peakPricing} is set. */
  off: PriceBucket
  /** Whether this model's cost is attributed across the two columns. Pricing, not model behaviour. */
  peakPricing?: boolean
}

const ZERO: PriceBucket = { hit: 0, miss: 0, out: 0 }

/**
 * Peak prices in 元 per million tokens, from the published DeepSeek price table.
 *
 * The off-peak column is half of these. Kept here rather than in `config.ts` so
 * the browser half can reason about the shipped defaults without importing the
 * host config schema.
 */
export const BUILTIN_PEAK: Record<string, PriceBucket> = {
  'deepseek-flash': { hit: 0.04, miss: 2, out: 8 },
  'deepseek-v4-pro': { hit: 0.3, miss: 9, out: 27 },
}

/** Off-peak is exactly half the peak price in the published table. */
export function half(bucket: PriceBucket): PriceBucket {
  return { hit: bucket.hit / 2, miss: bucket.miss / 2, out: bucket.out / 2 }
}

/**
 * Factory-default price entries: the built-in DeepSeek routes ship enabled with
 * both columns, so their published peak/off-peak pricing applies out of the box.
 * Every other model starts with no entry at all — no prices and no split — until
 * one is added.
 */
export const DEFAULT_PRICE_ENTRIES: Record<string, ModelPrices> = Object.fromEntries(
  Object.entries(BUILTIN_PEAK).map(([model, peak]) => [model, { peak, off: half(peak), peakPricing: true }]),
)

/** Built-in peak prices, exposed to the Settings page. */
export const BUILTIN_PRICES = BUILTIN_PEAK

/**
 * Whether one model's price entry opts into the two-column split.
 *
 * An entry that never states the flag inherits the shipped answer for that
 * model. Without this, a stored price edit (the panel writes sparse fields)
 * would silently turn off off-peak pricing for a built-in model.
 * @param configured - user price entries keyed by model id.
 * @param model - model id.
 * @returns true when the two-column split applies.
 */
export function peakEnabled(
  configured: Record<string, Partial<ModelPrices>> | undefined,
  model: string,
): boolean {
  const stated = configured?.[model]?.peakPricing
  if (typeof stated === 'boolean') return stated
  return DEFAULT_PRICE_ENTRIES[model]?.peakPricing === true
}

/**
 * Resolve the price table for one model.
 *
 * `off` is merged field by field over the shipped half-price so a stored entry
 * that only states one column cannot produce `undefined` prices (which would
 * turn every computed cost into NaN).
 * @param model - model id.
 * @param configured - user overrides keyed by model id.
 * @returns both columns, zero-filled when nothing is known.
 */
export function resolvePrices(
  model: string,
  configured: Record<string, Partial<ModelPrices>> | undefined,
): ModelPrices {
  const user = configured?.[model]
  const builtin = DEFAULT_PRICE_ENTRIES[model]
  const base = BUILTIN_PEAK[model] ?? builtin?.peak ?? ZERO
  const peak: PriceBucket = {
    ...base,
    ...(user?.peak ?? {}),
  }
  const off: PriceBucket = {
    ...half(peak),
    ...(builtin?.off ?? {}),
    ...(user?.off ?? {}),
  }
  return { peak, off, peakPricing: peakEnabled(configured, model) }
}
