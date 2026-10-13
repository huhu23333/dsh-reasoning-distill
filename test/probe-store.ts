/** Throwaway probe: legacy adoption behaviour, with prints. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const { SidecarStore, dshHome, legacySidecarPath, sidecarPath } = await import('../src/store.ts')
mkdirSync(join(dshHome(), 'reasoning-distill'), { recursive: true })
const legacy = legacySidecarPath('team/a')
console.log('dshHome      :', dshHome())
console.log('legacy(a)    :', legacy)
console.log('legacy(?)    :', legacySidecarPath('team?a'))
console.log('digest(?)    :', sidecarPath('team?a'))
writeFileSync(legacy, JSON.stringify({ version: 1, sessionId: 'team/a', epoch: 0, countedThroughSeq: -1, entries: [{ id: 'foreign-entry' }] }))
const store = new SidecarStore()
const got = await store.load('team?a')
console.log('loaded(?)    :', JSON.stringify({ sessionId: got.sessionId, entries: got.entries.length }))
