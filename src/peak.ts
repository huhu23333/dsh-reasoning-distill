/**
 * Peak / off-peak attribution.
 *
 * Published DeepSeek pricing has two windows: Beijing 09:00–12:00 and
 * 14:00–18:00 on working days are peak, everything else (nights, weekends and
 * statutory holidays) bills at the off-peak rate, which is half.
 *
 * `dsh-whale-widget` owns an equivalent implementation, but it exports no
 * service and no functions and serves its data only through a browser-
 * authenticated route, so there is no supported channel to query. When the
 * user selects the `whale` source this module reads the widget's constants out
 * of its installed bundle on a best-effort basis and falls back to the built-in
 * rules if anything does not parse — the Settings page always says which source
 * ended up in force.
 * @module dsh-reasoning-distill/peak
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Config, PriceBucket, ModelPrices } from './config.ts'
import { BUILTIN_HOLIDAYS, resolvePrices } from './config.ts'
import { dshHome } from './store.ts'

/** Peak windows in Beijing wall-clock hours, half-open `[start, end)`. */
const BUILTIN_PEAK_HOURS: readonly (readonly [number, number])[] = [[9, 12], [14, 18]]

/** One resolved peak-window source. */
export interface PeakSource {
  /** `builtin` or `whale`. */
  id: string
  /** Human-readable label for the UI. */
  label: string
  /** Detail line for the UI, e.g. why the fallback happened. */
  detail: string
  /** Whether this instant bills as peak. */
  isPeak(time: number): boolean
}

/** Constants recovered from the whale widget's bundle. */
interface WhaleConstants {
  path: string
  peakHours: readonly (readonly [number, number])[]
  holidays: readonly string[]
}

let whaleCache: WhaleConstants | null | undefined

/** Beijing calendar fields for one instant. */
function beijing(time: number): { day: number; hour: number; date: string } {
  const shifted = new Date(time + 8 * 3600 * 1000)
  return {
    day: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    date: shifted.toISOString().slice(0, 10),
  }
}

/**
 * Parse the peak windows out of one bundle's source.
 * @param source - bundle text.
 * @returns the windows, or undefined when the shape is unrecognised.
 */
function parsePeakHours(source: string): readonly (readonly [number, number])[] | undefined {
  // The array is pretty-printed multi-line, so the first `]` closes the first
  // pair, not the array — anchor the capture on the closing line instead.
  const match = /const\s+PEAK_HOURS\s*=\s*\[([\s\S]{0,300}?)\n\]/.exec(source)
  if (match === null) return undefined
  const pairs = [...match[1]!.matchAll(/\[\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\]/g)]
    .map(pair => [Number(pair[1]), Number(pair[2])] as const)
  if (pairs.length === 0) return undefined
  if (pairs.some(([start, end]) => !(start >= 0 && start < 24 && end > start && end <= 24))) return undefined
  return pairs
}

/**
 * Parse the holiday list out of one bundle's source.
 * @param source - bundle text.
 * @returns Beijing dates, possibly empty.
 */
function parseHolidays(source: string): readonly string[] | undefined {
  const match = /const\s+HOLIDAY_VALLEY\s*=\s*\{([\s\S]{0,4000}?)\n\}/.exec(source)
  if (match === null) return undefined
  return [...match[1]!.matchAll(/'(\d{4}-\d{2}-\d{2})'\s*:/g)].map(entry => entry[1]!)
}

/**
 * Best-effort read of the whale widget's constants from whichever profile has it.
 * @returns parsed constants, or null when the widget is absent or unreadable.
 */
function readWhale(): WhaleConstants | null {
  if (whaleCache !== undefined) return whaleCache
  whaleCache = null
  try {
    const profiles = join(dshHome(), 'profiles')
    for (const profile of readdirSync(profiles)) {
      const bundle = join(profiles, profile, 'node_modules', 'dsh-whale-widget', 'lib', 'index.js')
      let source: string
      try {
        source = readFileSync(bundle, 'utf8')
      } catch {
        continue
      }
      const peakHours = parsePeakHours(source)
      if (peakHours === undefined) continue
      whaleCache = { path: bundle, peakHours, holidays: parseHolidays(source) ?? [] }
      break
    }
  } catch {
    whaleCache = null
  }
  return whaleCache
}

/**
 * Whether the whale widget is installed, for the Settings page.
 * @returns presence and the bundle path that was read.
 */
export function whaleStatus(): { detected: boolean; detail: string; holidays: number } {
  const found = readWhale()
  if (found === null) return { detected: false, detail: '', holidays: 0 }
  return { detected: true, detail: found.path, holidays: found.holidays.length }
}

/**
 * Resolve the peak source the configuration asks for.
 * @param config - live plugin configuration.
 * @returns the source in force, with a label naming the fallback when it applied.
 */
export function resolvePeakSource(config: Config): PeakSource {
  const holidays = new Set(config.holidays.get() ?? BUILTIN_HOLIDAYS)
  const wantsWhale = config.peakSource.get() === 'whale'
  const found = wantsWhale ? readWhale() : null
  if (found !== null) {
    const days = new Set(found.holidays)
    const hours = found.peakHours
    return {
      id: 'whale',
      label: 'dsh-whale-widget',
      detail: `${found.peakHours.length} 个时段 · ${found.holidays.length} 个节假日 · ${found.path}`,
      isPeak: (time: number): boolean => {
        const bj = beijing(time)
        if (bj.day === 0 || bj.day === 6) return false
        if (days.has(bj.date)) return false
        return hours.some(([start, end]) => bj.hour >= start && bj.hour < end)
      },
    }
  }
  const detail = wantsWhale
    ? '未找到 dsh-whale-widget 的峰谷常量，已回退到内置固定时窗。'
    : '内置固定时窗：北京时间 9–12、14–18 为峰时；周末与节假日全天谷价。'
  return {
    id: 'builtin',
    label: '内置固定时窗',
    detail,
    isPeak: (time: number): boolean => {
      const bj = beijing(time)
      if (bj.day === 0 || bj.day === 6) return false
      if (holidays.has(bj.date)) return false
      return BUILTIN_PEAK_HOURS.some(([start, end]) => bj.hour >= start && bj.hour < end)
    },
  }
}

/** Which price column one instant belongs to, given the configuration. */
export type PricePeriod = 'peak' | 'off'

/**
 * Attribute one instant to a price column.
 *
 * Whether peak pricing applies is a per-model decision, so the caller passes
 * that model's flag: with it off there is a single column, the first one always
 * applies, and the second is never consulted.
 * @param time - epoch milliseconds of the billed request.
 * @param peakPricing - that model's peak-pricing setting.
 * @param config - live plugin configuration.
 * @param source - resolved source, reused across one computation.
 * @returns the column to price with.
 */
export function periodFor(time: number, peakPricing: boolean, config: Config, source?: PeakSource): PricePeriod {
  if (!peakPricing) return 'peak'
  const resolved = source ?? resolvePeakSource(config)
  return resolved.isPeak(time) ? 'peak' : 'off'
}

/**
 * Whether one model's price entry opts into the two-column split.
 * @param configured - user price entries keyed by model id.
 * @param model - model id.
 * @returns true when that entry set `peakPricing`.
 */
export function peakEnabled(
  configured: Record<string, Partial<ModelPrices>> | undefined,
  model: string,
): boolean {
  return configured?.[model]?.peakPricing === true
}

/**
 * Pick the bucket of one resolved price table for a period.
 * @param prices - resolved table.
 * @param period - attributed column.
 * @returns the bucket to apply.
 */
export function bucketFor(prices: ModelPrices, period: PricePeriod): PriceBucket {
  return period === 'peak' ? prices.peak : prices.off
}

/** Convenience wrapper: resolved prices plus the attributed bucket. */
export function priceAt(
  model: string,
  configured: Record<string, Partial<ModelPrices>> | undefined,
  time: number,
  config: Config,
  source?: PeakSource,
): { bucket: PriceBucket; period: PricePeriod } {
  const period = periodFor(time, peakEnabled(configured, model), config, source)
  return { bucket: bucketFor(resolvePrices(model, configured), period), period }
}
