/**
 * Composer-toolbar activity chip: says why the next request has not been sent
 * yet while a reasoning compression is holding a step, and stays visible (in a
 * quieter form) while a compression runs without blocking anything.
 * @module dsh-reasoning-distill/client/ActivityChip
 */

import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { availableSessionStorage, claimRewriteAttempt, isStaleResponse, owedInPlaceEntries, rememberRewriteOutcome, rewriteApplyOutcome, rewriteRequest } from './ops.ts'
import { settleHandoff } from './handoff.ts'
import { REPORT_ROUTE, type BlockingReason, type CompressionEntry, type SessionReport } from '../shared.ts'
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

/**
 * Whether following a branch also archives the conversation it replaced.
 *
 * The switch is plugin configuration (@link Config.archiveSuperseded, on by default)
 * and reaches this seat through the report's config block, so the value in force when
 * the branch appears is the one that decides. Archiving only hides the conversation
 * from the list: it stays recoverable from the archive.
 * @param report - the report just read, or null when the read failed.
 * @returns whether the superseded conversation should be archived.
 */
export function shouldArchiveSuperseded(report: SessionReport | null): boolean {
  return report?.config.archiveSuperseded === true
}

/** Props of the composer activity seat. */
type Props = PropsRuntime<'conversation.input.activity'> & PropsLocale<typeof NS> & {
  /** Session whose compressions are shown. */
  sessionId: string
  /** Select one conversation through the UI navigation service. */
  openSession: (id: string) => void
  /**
   * Ask the shell to rebuild this conversation's history window after a write-back, so the
   * rewritten reasoning replaces the superseded text without a page reload. Absent on a shell
   * whose session face exposes no rebuild; the change then shows on the next read.
   */
  refreshTranscript?: (sessionId: string) => void
  /** Hide one conversation from the list, once its branch is on screen. */
  archiveSession: (id: string) => void
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

/**
 * The newest created hand-off that landed after this seat started showing the
 * session, or undefined when none did. A branch that predates the current view is
 * history: it must never redirect a user who is simply browsing.
 * @param report - the report just read, or null when the read failed.
 * @param sessionId - the session this seat currently shows.
 * @param stamped - when that session started being shown.
 * @returns the branch to follow and its hand-off time.
 */
export function freshHandoff(
  report: SessionReport | null,
  sessionId: string,
  stamped: { sessionId: string; at: number },
): { branchId: string; at: number } | undefined {
  if (report === null || stamped.sessionId !== sessionId) return undefined
  let best: { branchId: string; at: number } | undefined
  for (const entry of report.entries) {
    const handoff = entry.handoff
    if (handoff?.state !== 'created' || handoff.branchId === undefined) continue
    const at = handoff.at ?? 0
    if (at <= stamped.at) continue
    if (best === undefined || at > best.at) best = { branchId: handoff.branchId, at }
  }
  return best
}

export function CompressionActivity({ sessionId, openSession, archiveSession, refreshTranscript, onActiveChange, t }: Props) {
  const [live, setLive] = useState<Live>(IDLE)
  const [now, setNow] = useState(() => Date.now())
  const sequence = useRef(0)
  const applied = useRef(0)
  // Stamped when this seat starts showing a session, not when its first report
  // arrives: browsing history must never redirect to an old hand-off.
  const followedAt = useRef<{ sessionId: string; at: number }>({ sessionId: '', at: 0 })
  const followed = useRef(new Set<string>())
  /** In-place rewrites this mount has already sent. */
  const applyingInPlace = useRef(new Set<string>())

  useEffect(() => {
    followedAt.current = { sessionId, at: Date.now() }
  }, [sessionId])

  /**
   * Follow the newest hand-off that landed after this session was opened: show its
   * branch, then archive the conversation the branch replaced when the configuration
   * asks for it (default on). The engine defers the branch to idle, so this seat —
   * not the report panel — has to be the follower: the panel is only mounted while
   * the user looks at it.
   */
  const follow = (report: SessionReport | null): void => {
    const fresh = freshHandoff(report, sessionId, followedAt.current)
    if (fresh === undefined) return
    followedAt.current = { sessionId, at: fresh.at }
    if (followed.current.has(fresh.branchId)) return
    followed.current.add(fresh.branchId)
    openSession(fresh.branchId)
    if (shouldArchiveSuperseded(report)) archiveSession(sessionId)
  }


  /**
   * Write back the rewrites an in-place backend owes.
   *
   * The host cannot send these itself — an in-place backend's route sits behind the
   * browser's credentials — and it keeps one pending marker per session, so a series of
   * compressions used to leave every rewrite but the newest unwritten. This seat is mounted
   * whenever the conversation is, so it drives them entry by entry from the report, claiming
   * each attempt in browser storage first so the report panel cannot send it too.
   * @param report - the session's latest report.
   */
  const applyInPlace = (report: SessionReport | null): void => {
    for (const entry of owedInPlaceEntries(report)) {
      if (report === null) return
      const key = sessionId + ':' + entry.id
      if (applyingInPlace.current.has(key)) continue
      // Asked for before the claim: a backend this plugin cannot drive yet owes nothing, and
      // claiming an attempt that will never be sent would strand the entry for a whole TTL.
      const request = rewriteRequest(report.config.rewriteBackend, report.sessionId, entry, entry.distilledText)
      if (request === undefined) continue
      if (!claimRewriteAttempt(availableSessionStorage(), key, Date.now())) continue
      applyingInPlace.current.add(key)
      void fetch(request.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      }).then(async response => {
        const payload: unknown = await response.json().catch(() => null)
        const outcome = rewriteApplyOutcome(response.ok, payload)
        if (!outcome.done) {
          // Released so a later poll retries, and remembered so the panel reports the refusal
          // instead of writing the rewrite a second time.
          applyingInPlace.current.delete(key)
          rememberRewriteOutcome(availableSessionStorage(), key, outcome.error)
          return
        }
        rememberRewriteOutcome(availableSessionStorage(), key)
        // The record changed at its own seq, so nothing was appended and this open view still holds
        // the superseded text; ask the shell to rebuild it now rather than at the next reload.
        refreshTranscript?.(report.sessionId)
        await settleHandoff(report, entry.id)
      }).catch(() => {
        applyingInPlace.current.delete(key)
        rememberRewriteOutcome(availableSessionStorage(), key, 'the rewrite request failed')
      })
    }
  }

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
        follow(report)
        applyInPlace(report)
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
