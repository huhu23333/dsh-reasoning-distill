/** Throwaway probe: verify whale detection against the real DSH home. */
const { whaleStatus, resolvePeakSource } = await import('../src/peak.ts')
const status = whaleStatus()
console.log('whaleStatus:', JSON.stringify(status))
const fake = (peakSource: string): never => ({
  holidays: { get: () => [] },
  peakSource: { get: () => peakSource },
  peakPricing: { get: () => true },
  prices: { get: () => ({}) },
}) as never
for (const source of ['builtin', 'whale']) {
  const resolved = resolvePeakSource(fake(source))
  const wed10 = Date.UTC(2026, 9, 14, 2)
  const sun10 = Date.UTC(2026, 9, 18, 2)
  console.log(`${source} -> id=${resolved.id} label=${resolved.label} | 周三10点=${resolved.isPeak(wed10)} 周日10点=${resolved.isPeak(sun10)}`)
  console.log('  detail:', resolved.detail.slice(0, 120))
}
