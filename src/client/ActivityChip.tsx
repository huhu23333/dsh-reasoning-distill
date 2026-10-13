/**
 * Composer-toolbar activity chip: says why the next request has not been sent
 * yet while a reasoning compression is holding a step, and stays visible (in a
 * quieter form) while a compression runs without blocking anything.
 * @module dsh-reasoning-distill/client/ActivityChip
 */

import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { isStaleResponse } from './ops.ts'
import { REPORT_ROUTE, type BlockingReason, type SessionReport } from '../shared.ts'
import { NS } from './locales.ts'
import css from './View.module.css'

/** The slice of a report this chip cares about. */
export interface Live {
  count: number
  /** When the wait began, or null when nothing is blocked. */
  blockingSince: number | null
  reason: BlockingReason | null
  /** Start of the earliest running compression. */
  startedAt: number | null
}

export const IDLE: Live = { count: 0, blockingSince: null, reason: null, startedAt: null }

/** Props of the composer activity seat. */
type Props = PropsRuntime<'conversation.input.activity'> & PropsLocale<typeof NS> & {
  /** Session whose compressions are shown. */
  sessionId: string
}

/**
 * Live compression indicator beside the submit button.
 * @param props - seat props.
 * @returns the chip, or nothing while the plugin is idle.
 */
/**
 * What the chip should show after one poll.
 *
 * A failed or unknown-session read returns the idle state rather than the
 * previous one: otherwise a chip that once showed a compression would keep
 * claiming it is running — and keep the host's activity seat expanded — after
 * the engine went idle.
 * @param report - the report just read, or null when the read failed.
 * @returns the state to display.
 */
export function liveAfterReport(report: SessionReport | null): Live {
  if (report === null) return IDLE
  const active = report.active ?? []
  return {
    count: active.length,
    blockingSince: report.blockingSince ?? null,
    reason: report.blockingReason ?? null,
    startedAt: active.length === 0 ? null : Math.min(...active.map(item => item.startedAt)),
  }
}

export function CompressionActivity({ sessionId, onActiveChange, t }: Props) {
  const [live, setLive] = useState<Live>(IDLE)
  const [now, setNow] = useState(() => Date.now())
  const sequence = useRef(0)
  const applied = useRef(0)


  useEffect(() => {
    // A chip describing the previous session must not stand in for this one: the
    // status is cleared up front and every read is ordered, so a late or failed
    // response cannot resurrect a stale "busy" state.
    setLive(IDLE)
    if (sessionId === '') return
    let alive = true
    const read = (): void => {
      const request = ++sequence.current
      void fetch(REPORT_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).then(async response => response.ok ? await response.json() as SessionReport : null).then(report => {
        if (!alive || isStaleResponse(request, applied.current)) return
        applied.current = request
        setLive(liveAfterReport(report))
      }).catch(() => {
        // A read that failed says nothing about the compression, so the chip goes
        // back to silence instead of staying expanded on a stale "busy". An older
        // failure landing after a newer success must not silence that success.
        if (!alive || isStaleResponse(request, applied.current)) return
        applied.current = request
        setLive(IDLE)
      })
    }
    read()
    const timer = setInterval(read, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [sessionId])

  const busy = live.blockingSince !== null || live.count > 0
  // Declared after `busy`: reading it in a dependency array above its
  // declaration is a temporal-dead-zone throw during render.
  // The host only hides the standard controls and gives the activity seat its
  // expanded width while the callback reports true, so a blocked compression has
  // to claim that space or its reason gets truncated beside the normal controls.
  useEffect(() => {
    onActiveChange?.(busy)
  }, [busy, onActiveChange])
  useEffect(() => () => { onActiveChange?.(false) }, [onActiveChange])
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [busy])

  if (!busy) return null
  const since = live.blockingSince ?? live.startedAt ?? now
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  const blocked = live.blockingSince !== null
  const why = blocked
    ? t(`activity.reason.${live.reason ?? 'other'}` as 'activity.reason.tool')
    : t('activity.idleRun')
  return <div className={css.activity} role="status" title={why}>
    <span className={blocked ? css.activityDotBlocked : css.activityDot} aria-hidden />
    <span className={css.activityLabel}>{blocked ? t('activity.blocked') : t('activity.compressing')} · {seconds}s</span>
    <span className={css.activityWhy}>{why}</span>
  </div>
}
