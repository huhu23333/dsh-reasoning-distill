import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCopyOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { availableSessionStorage, backendById, httpFailure, isStaleResponse, pendingRewriteOutcome, rememberRewriteOutcome, rewriteApplyOutcome, rewriteRequest, shouldRetrySettle } from './ops.ts'
import { HANDOFF_ROUTE, REPORT_ROUTE, entryInForceHere, type CompressionEntry, type SessionReport } from '../shared.ts'
import { settleHandoff } from './handoff.ts'
import { NS, type Key } from './locales.ts'
import css from './View.module.css'

type Props = PropsRuntime<'conversation.view'> & PropsLocale<typeof NS> & {
  openSession: (id: string) => void
  /**
   * Ask the shell to rebuild this conversation's history window after a write-back, so the
   * rewritten reasoning replaces the superseded text without a page reload. Absent on a shell
   * whose session face exposes no rebuild; the change then shows on the next read.
   */
  refreshTranscript?: (sessionId: string) => void
}
type Translate = Props['t']
type Cached = { report?: SessionReport; loading: boolean; error?: string }

function money(amount: number): string {
  return `¥${(Number.isFinite(amount) ? amount : 0).toFixed(6)}`
}

/**
 * Money with an explicit sign, where **negative means saved** and positive means
 * spent: callers pass the signed delta (cost − saving), so a column of figures
 * reads as one ledger instead of mixing "costs" and "savings".
 * @param value - signed amount of money.
 * @returns the formatted signed amount.
 */
export function signedMoney(value: number): string {
  if (value === 0) return money(0)
  return `${value > 0 ? '+' : '−'}${money(Math.abs(value))}`
}

/** Tokens with the same sign convention as {@link signedMoney}. */
export function signedCount(value: number): string {
  if (value === 0) return count(0)
  return `${value > 0 ? '+' : '−'}${count(Math.abs(value))}`
}

function count(amount: number): string {
  return (Number.isFinite(amount) ? amount : 0).toLocaleString()
}

function TextBlock({ label, value }: { label: string; value: string }) {
  return <details className={css.textBlock}><summary>{label}</summary><pre>{value}</pre></details>
}

function SessionRow({ entry, t, openSession }: { entry: CompressionEntry; t: Translate; openSession: (id: string) => void }) {
  const [copied, setCopied] = useState(false)
  const id = entry.distill.sessionId
  // An id that genuinely cannot be loaded no longer offers a dead button.
  const expired = entry.sessionLive === false
  const label = id === ''
    ? (entry.sessionMissing === true ? t('view.sessionMissing') : t('view.noSession'))
    : expired ? `${id} · ${t('view.sessionExpired')}` : id
  return <div className={css.sessionRow}>
    <div className={css.sessionInfo}><span className={css.muted}>{t('view.turn')} {entry.turn} · {t('view.step')} {entry.step}</span><code title={id}>{label}</code>{entry.distill.error && <span className={css.error}>{t('view.failedRun')}: {entry.distill.error}</span>}</div>
    {id !== '' && <div className={css.actions}>
      <button type="button" className={css.iconButton} title={t('view.copy')} aria-label={t('view.copy')} onClick={() => { void navigator.clipboard.writeText(id).then(() => setCopied(true)).catch(() => setCopied(false)) }}><IconCopyOutlineRegular /></button>
      {copied && <span className={css.muted} role="status">{t('view.copied')}</span>}
      {id !== '' && !expired && <button type="button" className={css.secondary} onClick={() => openSession(id)}>{t('view.open')}</button>}
      {entry.sessionMissing === true && !expired
        && <span className={css.note}>{t('view.auditUndurable')}</span>}
    </div>}
  </div>
}

/**
 * What this entry contributes to the per-request stock right now.
 *
 * A retired or never-adopted entry contributes nothing, so the tokens shown for
 * an entry can never disagree with the money beside them the way a live-only
 * money figure next to a lifetime token count did.
 * @param entry - one compression record.
 * @returns its per-request reduction, or 0 when no request would carry it.
 */
/** Money this rewrite added: its distillation cost plus any cache-break surcharge. */
/** Net money this rewrite changed: positive means it cost more than it removed. */
export function entryNet(entry: CompressionEntry): number {
  return increasedOfEntry(entry) - reducedOfEntry(entry)
}

export function increasedOfEntry(entry: CompressionEntry): number {
  return entry.distill.cost + entry.cacheBreakCost
}

/** Money this rewrite has already removed from requests, frozen rewards included. */
export function reducedOfEntry(entry: CompressionEntry): number {
  return entry.liveSaved + entry.frozenSaved
}

export function stockOfEntry(entry: CompressionEntry, sessionId: string, live?: readonly string[]): number {
  // A rewrite handed off to a branch is in force there, not in the conversation it
  // left: that one keeps the original reasoning, so no request of it carries this.
  if (!entryInForceHere(entry, sessionId)) return 0
  // The engine's set is the authority: a rewrite that compaction removed from the
  // prompt is gone even when the record was never marked inactive (for example a
  // compaction that happened while this plugin was not running).
  if (live !== undefined && !live.includes(entry.id)) return 0
  if (entry.active !== true) return 0
  if (entry.distilledTokens >= entry.originalTokens) return 0
  return entry.savedTokensPerRequest
}

function Entry({ entry, sessionId, t, liveStockIds }: {
  entry: CompressionEntry
  sessionId: string
  t: Translate
  liveStockIds?: readonly string[]
}) {
  const run = entry.distill
  const estimated = run.estimated === true
  // The rewrite moved into the branch this hand-off created: this conversation keeps
  // its pre-compression history, so the entry is an attempt here, never a success.
  const moved = entry.handoff?.state === 'created' && entry.handoff.branchId !== undefined && entry.handoff.branchId !== sessionId
  const notAdopted = entry.failed === true || entry.skipped === true || moved
  const verdict = entry.failed === true ? t('view.abandoned') : moved ? t('view.branchedAway') : t('view.skipped')
  return <details className={css.entry}><summary><span className={css.entryTitle}>{t('view.turn')} {entry.turn} · {t('view.step')} {entry.step}</span><span className={css.muted}>{entry.provider}/{entry.model}</span><span className={css.metric}>{count(entry.originalChars)} {t('view.chars')} · {t('view.estimate')} {count(entry.originalTokens)} {t('view.tokens')}</span>{notAdopted
    ? <span className={css.error}>{verdict} · {t('view.cost')} {money(run.cost)}{estimated ? ` (${t('view.estimated')})` : ''}</span>
    : <span className={`${css.metric} ${entryNet(entry) > 0 ? css.negative : css.positive}`}>{signedMoney(increasedOfEntry(entry))} − {money(reducedOfEntry(entry))} = {signedMoney(entryNet(entry))}</span>}</summary>
    <div className={css.entryBody}>
      {entry.skipped === true && <p role="status" className={css.note}>{t('view.skippedNote')}</p>}
      {moved && <p role="status" className={css.note}>{t('view.branchedAwayNote')}</p>}
      {run.error && <p role="alert" className={css.error}>{t('view.abandoned')}: {run.error}</p>}
      <div className={css.facts}>
        <div><span>{t('view.original')}</span><strong>{count(entry.originalChars)} {t('view.chars')} / {count(entry.originalTokens)} {t('view.tokens')} ({t('view.estimated')})</strong></div>
        <div><span>{t('view.result')}</span><strong>{notAdopted ? verdict : `${count(entry.distilledChars)} ${t('view.chars')} / ${count(entry.distilledTokens)} ${t('view.tokens')} (${t('view.estimated')})`}</strong></div>
        <div><span>{t('view.session')}</span><code>{run.sessionId || (entry.sessionMissing === true ? t('view.sessionMissing') : t('view.noSession'))}</code></div>
        <div><span>{t('view.model')}</span><strong>{run.provider}/{run.model} · {run.effort}</strong></div>
        <div><span>{t('view.input')} / {t('view.cache')} / {t('view.output')}</span><strong>{count(run.inputTokens)} / {count(run.cacheReadTokens)} / {count(run.outputTokens)} token{estimated ? ` (${t('view.estimated')})` : ''}</strong></div>
        <div><span>{t('view.duration')}</span><strong>{count(run.durationMs)} ms</strong></div>
        <div><span>{t('view.cost')}</span><strong>{money(run.cost)}{estimated ? ` (${t('view.estimated')})` : ''}</strong></div>
        <div><span>{t('view.period')}</span><strong>{t(run.period === 'peak' ? 'view.peak' : 'view.off')}</strong></div>
        <div><span>{t('view.avoided')}</span><strong>{signedMoney(-reducedOfEntry(entry))}</strong></div>
        {entry.handoff?.state === 'skipped' && <div><span>交接已跳过</span><strong>{entry.handoff.error ?? ''}</strong></div>}
        {entry.handoff?.state === 'failed' && <div><span>{t('view.branchFailed')}</span><strong className={css.error}>{entry.handoff.error ?? ''} · {t('view.branchKept')}</strong></div>}
        {entry.handoff?.state === 'created' && <div><span>{t('view.branchCreated')}</span><strong>{entry.handoff.branchId ?? ''}</strong></div>}
        <div><span>{t('view.stock')}</span><strong>{t('view.estimate')} {count(stockOfEntry(entry, sessionId, liveStockIds))} token</strong> · <strong>{t('view.estimate')} {signedCount(-entry.savedTokensPerRequest * entry.liveRequests)} {t('view.tokens')} {t('view.lifetime')}</strong></div>
      </div>
      <TextBlock label={t('view.request')} value={run.requestText} />
      <TextBlock label={t('view.result')} value={run.responseText} />
    </div>
  </details>
}

export function ReasoningDistillView({ sessionId, openSession, refreshTranscript, t }: Props) {
  const [cache, setCache] = useState<Record<string, Cached>>({})
  const sequence = useRef(0)
  const applied = useRef(0)
  // The manual refresh calls the live reader rather than re-keying the effect:
  // re-keying would abort the request already in flight.
  const readRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    // One long-lived poll per session: a refresh must never abort the request in
    // flight, or a report slower than the poll interval would never arrive.
    const read = (): void => {
      if (!alive) return
      const request = ++sequence.current
      setCache(current => ({ ...current, [sessionId]: { ...current[sessionId], loading: current[sessionId]?.report === undefined, error: undefined } }))
      fetch(REPORT_ROUTE, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }) }).then(async response => {
        if (!response.ok) throw new Error(await httpFailure(response))
        return await response.json() as SessionReport
      }).then(report => {
        if (!alive || isStaleResponse(request, applied.current)) return
        applied.current = request
        setCache(current => ({ ...current, [sessionId]: { report, loading: false } }))
      }).catch(error => {
        if (!alive || isStaleResponse(request, applied.current)) return
        applied.current = request
        setCache(current => ({ ...current, [sessionId]: { ...current[sessionId], loading: false, error: String(error) } }))
      })
    }
    readRef.current = read
    read()
    const timer = setInterval(read, 4000)
    const onVisible = (): void => { if (document.visibilityState === 'visible') read() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [sessionId])
  const retry = useCallback(() => readRef.current(), [])
  // One follow-up per session: the host creates the branch before the original
  // turn would have called the model, so all that is left here is to go there.
  const openedBranch = useRef(new Set<string>())
  const appliedPending = useRef(new Set<string>())  // keys: `${sessionId}:${entryId}`
  // Entries whose rewrite request is still open: the report polls every few
  // seconds, and a slow backend must not be asked twice for the same entry.
  const applyingPending = useRef(new Set<string>())
  // Attempts whose backend call already succeeded but whose hand-off settle did
  // not: the panel must retry *only* the settle, never the backend request.
  // Keyed to the outcome that still has to be recorded, so a retried settle keeps
  // reporting why the backend (or the request) failed.
  const settlePending = useRef(new Map<string, string | undefined>())
  // When this view mounted, every branch that already existed was old news: only a
  // hand-off that lands while the panel is open may pull the user across, or
  // returning to the original session would bounce them to an old branch forever.
  // The moment this view started showing a session: a hand-off that lands after
  // that belongs to the user's current visit, however long the first report took.
  const viewOpenedAt = useRef<{ sessionId: string; at: number }>({ sessionId: '', at: 0 })
  // The session this view is showing right now: an async backend continuation must
  // not drag the user to another session's branch after they navigated away.
  const showingSession = useRef(sessionId)

  /**
   * Settle one hand-off and say how it went.
   *
   * `settled` means the host cleared that rewrite's pending flag; `refused` means
   * the host answered `{ok:false}` because that attempt is no longer the current
   * one (nothing to retry); `failed` means the request itself did not complete, so
   * the settle is still owed.
   */
  // Stamped when the view starts showing a session, not when its first report
  // arrives: a slow first poll must not make a branch that landed after the tab
  // opened look like history.
  useEffect(() => {
    viewOpenedAt.current = { sessionId, at: Date.now() }
    showingSession.current = sessionId
  }, [sessionId])
  useEffect(() => {
    const current = cache[sessionId]?.report
    if (current === undefined) return
    // The hand-off outcome lives on the entry, so the panel reads it there.
    const createdBranches = current.entries.filter(item => item.handoff?.state === 'created' && item.handoff.branchId !== undefined)
    if (viewOpenedAt.current.sessionId !== current.sessionId) {
      // Only a fallback: the effect above normally stamped this before the first
      // report could arrive.
      viewOpenedAt.current = { sessionId: current.sessionId, at: 0 }
    }
    {
      // Newest by *hand-off time*, not by entry order: an older compression's
      // hand-off can land after a newer one's, and entry order would then open the
      // wrong branch (and redirect a second time on the next poll).
      const fresh = createdBranches
        .filter(item => (item.handoff?.at ?? 0) > viewOpenedAt.current.at)
        .reduce<typeof createdBranches[number] | undefined>(
          (best, item) => best === undefined || (item.handoff?.at ?? 0) > (best.handoff?.at ?? 0) ? item : best,
          undefined,
        )
      const branchId = fresh?.handoff?.branchId
      if (branchId !== undefined) {
        viewOpenedAt.current = { sessionId: current.sessionId, at: fresh?.handoff?.at ?? viewOpenedAt.current.at }
        if (!openedBranch.current.has(branchId)) {
          openedBranch.current.add(branchId)
          openSession(branchId)
          return
        }
      }
    }
    // The engine settles what a delegated conversation owes the moment it is live again -- the panel
    // posted between two of its turns, when there was no session to write into. The open transcript
    // holds the superseded text just as it does after the panel's own apply, so rebuild it here too.
    for (const entry of current.entries) {
      if (entry.inPlaceApplied === undefined) continue
      const settledKey = `${current.sessionId}:engine:${entry.id}`
      if (appliedPending.current.has(settledKey)) continue
      appliedPending.current.add(settledKey)
      refreshTranscript?.(current.sessionId)
    }
    // Settles we still owe are retried first: the host's pending flag may already be
    // gone (its note write failed), and waiting for it to reappear would strand the
    // failure forever.
    for (const owedKey of [...settlePending.current.keys()]) {
      if (!owedKey.startsWith(`${current.sessionId}:`) || applyingPending.current.has(owedKey)) continue
      const owedEntry = owedKey.slice(current.sessionId.length + 1)
      applyingPending.current.add(owedKey)
      void settleHandoff(current, owedEntry, settlePending.current.get(owedKey)).then(({ verdict, recorded }) => {
        applyingPending.current.delete(owedKey)
        if (!shouldRetrySettle(verdict, recorded)) {
          settlePending.current.delete(owedKey)
          appliedPending.current.add(owedKey)
        }
      })
    }
    const pending = current.pendingBranch
    if (pending == null) return
    const attemptKey = `${current.sessionId}:${pending}`
    // In-flight first (dedupe), then an owed settle *before* the applied marker:
    // an attempt can be both applied and awaiting its settle, and the settle must
    // still be retried or the host's pending flag and the failure note would never
    // clear.
    if (applyingPending.current.has(attemptKey)) return
    if (settlePending.current.has(attemptKey)) {
      // The rewrite is already in the history; only the host's pending flag is left.
      applyingPending.current.add(attemptKey)
      void settleHandoff(current, pending, settlePending.current.get(attemptKey)).then(({ verdict, recorded }) => {
        applyingPending.current.delete(attemptKey)
        if (!shouldRetrySettle(verdict, recorded)) {
          settlePending.current.delete(attemptKey)
          appliedPending.current.add(attemptKey)
        }
      })
      return
    }
    if (appliedPending.current.has(attemptKey)) return
    // A branch backend is driven by the host before the next model request; if the
    // panel posted it too, the two non-idempotent requests would create two
    // branches. The panel only ever drives in-place backends.
    if (backendById(current.config.rewriteBackend)?.kind !== 'in-place') return
    // The backend outcome is recorded before settle, so a remount can never
    // interpret an uncleared host marker as permission to POST the rewrite again.
    const saved = pendingRewriteOutcome(availableSessionStorage(), attemptKey)
    if (saved !== undefined) {
      // Another driver — the composer seat — has claimed this attempt: it owns both the POST
      // and the settle, so this panel must not settle it out from under that claim.
      if (saved.claimed !== undefined) return
      settlePending.current.set(attemptKey, saved.error)
      applyingPending.current.add(attemptKey)
      void settleHandoff(current, pending, saved.error).then(({ verdict, recorded }) => {
        applyingPending.current.delete(attemptKey)
        if (!shouldRetrySettle(verdict, recorded)) {
          settlePending.current.delete(attemptKey)
          appliedPending.current.add(attemptKey)
        }
      })
      return
    }
    const entry = current.entries.find(item => item.id === pending)
    if (entry === undefined) return
    // The engine caps the answer at maxOutputChars and replays that stored text;
    // writing the raw response instead would put untruncated content into the
    // history and diverge from both the replacement and the reported savings.
    const request = rewriteRequest(current.config.rewriteBackend, current.sessionId, entry, entry.distilledText)
    if (request === undefined) return
    /** Tell the host how the hand-off went; in-place keeps the turn going. */

    applyingPending.current.add(attemptKey)
    void fetch(request.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
    }).then(async response => {
      const payload: unknown = await response.json().catch(() => null)
      const outcome = rewriteApplyOutcome(response.ok, payload)
      if (!outcome.done) {
        // A backend that refused must not look like a completed hand-off: record
        // why on the entry, and never re-post it (an in-place rewrite is not
        // idempotent). Only an unfinished settle is retried.
        const refusal = outcome.error ?? `HTTP ${response.status}`
        rememberRewriteOutcome(availableSessionStorage(), attemptKey, refusal)
        const { verdict, recorded } = await settleHandoff(current, pending, refusal)
        appliedPending.current.add(attemptKey)
        if (shouldRetrySettle(verdict, recorded)) settlePending.current.set(attemptKey, refusal)
        return
      }
      rememberRewriteOutcome(availableSessionStorage(), attemptKey)
      // The record changed at its own seq, so nothing was appended and this open view still holds
      // the superseded text; ask the shell to rebuild it now rather than at the next reload.
      refreshTranscript?.(current.sessionId)
      const { verdict, recorded } = await settleHandoff(current, pending)
      if (shouldRetrySettle(verdict, recorded)) {
        // Keep the rewrite and retry only the settle on a later poll instead of
        // re-posting a backend request that already succeeded.
        settlePending.current.set(attemptKey, undefined)
      } else {
        appliedPending.current.add(attemptKey)
      }
    }).catch(async (error: unknown) => {
      // The request did not complete, so whether the backend applied the rewrite
      // is unknown. An in-place rewrite is not idempotent, so this attempt is
      // terminal for the backend whatever the settle says: a duplicate mutation is
      // worse than a rewrite that did not land. Only an unfinished *settle* is
      // retried, so the host's pending flag cannot linger and trigger a re-post.
      const detail = error instanceof Error ? error.message : String(error)
      if (pendingRewriteOutcome(availableSessionStorage(), attemptKey) === undefined) {
        rememberRewriteOutcome(availableSessionStorage(), attemptKey, detail)
      }
      const { verdict, recorded } = await settleHandoff(current, pending, detail)
      appliedPending.current.add(attemptKey)
      if (shouldRetrySettle(verdict, recorded)) settlePending.current.set(attemptKey, detail)
    }).finally(() => {
      // Released once the attempt is over: whether to try again is decided by the
      // host's pending flag, not by this marker.
      applyingPending.current.delete(attemptKey)
    })
  }, [cache, sessionId, openSession])
  const current = cache[sessionId]
  const report = current?.report
  // Declared after `report`: referencing it above its declaration is a TDZ throw.
  const activity = (report?.active?.length ?? 0) > 0 || (report?.blockingSince ?? null) !== null
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!activity) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [activity])
  return <ReportBody report={report} loading={current?.loading === true} error={current?.error} now={now} onRefresh={retry} openSession={openSession} t={t} />
}

/**
 * Pure presentation of one session report. Kept separate from the polling shell
 * so it can be server-rendered in tests: a render-time throw here blanks the
 * whole tab, and that has happened twice.
 * @param props - report plus the clock and callbacks the body needs.
 * @returns the panel markup.
 */
export function ReportBody({ report, loading, error, now, onRefresh, openSession, t }: {
  report: SessionReport | undefined
  loading: boolean
  error: string | undefined
  now: number
  onRefresh: () => void
  openSession: (id: string) => void
  t: Translate
}) {
  // Every entry ever recorded, including ones a compaction has since shadowed.
  const stockTokens = report?.stockTokens ?? 0
  const stockSaved = report?.stockSaved ?? 0
  const lifetimeTokens = report?.lifetimeTokens ?? 0
  const activity = (report?.active?.length ?? 0) > 0 || (report?.blockingSince ?? null) !== null
  return <div className={css.page}>
    <header className={css.header}><h2>{t('view.title')}</h2><button type="button" title={t('view.refresh')} aria-label={t('view.refresh')} className={css.iconButton} onClick={onRefresh}><IconRefreshOutlineRegular /></button></header>
    {loading && <p className={css.muted} role="status">{t('view.loading')}</p>}
    {error && <p role="alert" className={css.error}>{t('view.failure')}: {error}</p>}
    {report && <>
      <div className={css.summary}>
        <div><span>{t('view.triggers')}</span><strong>{t('view.succeeded')} {count(report.succeeded)}</strong><small>{t('view.attempts')} {count(report.triggers)} · {t('view.estimate')} {signedCount(-lifetimeTokens)} {t('view.tokens')} {t('view.historical')}</small></div>
        <div><span>{t('view.distillCost')}</span><strong>{signedMoney(report.distillCost)}</strong><small>{report.entries.some(entry => entry.distill.estimated === true) ? `${t('view.estimate')} ` : ''}{count(report.entries.reduce((sum, entry) => sum + entry.distill.inputTokens + entry.distill.cacheReadTokens + entry.distill.cacheWriteTokens + entry.distill.outputTokens, 0))} token</small></div>
        <div><span>{t('view.stock')}</span><strong>{signedMoney(-stockSaved)}</strong><small>{t('view.estimate')} {signedCount(-stockTokens)} {t('view.tokens')} · {t('view.stockNote')}</small></div>
        <div><span>{t('view.savedTotal')}</span><strong>{signedMoney(-report.savedTotal)}</strong><small>{t('view.estimate')} {signedCount(-lifetimeTokens)} {t('view.tokens')} {t('view.lifetime')}</small></div>
        <div><span>{t('view.net')}</span><strong className={report.net < 0 ? css.negative : css.positive}>{signedMoney(-report.net)}</strong><small>{t('view.estimate')} {signedCount(-lifetimeTokens)} {t('view.tokens')} {t('view.lifetime')}</small></div>
      </div>
      <p className={css.note}>{t('view.resetNote')}</p>
      <p className={css.note}>{t('view.stockNote')}</p>
      <p className={css.note}>{t('view.signNote')}</p>

      {activity && <section className={css.section}><h3>{t('view.active')}</h3><p className={css.note}>{t('view.activeHint')}</p>
        {report?.blockingSince != null && <p role="status" className={css.blockedBanner}><span className={css.activityDotBlocked} aria-hidden /><strong>{t('activity.blocked')}</strong> · {t(`activity.reason.${report.blockingReason ?? 'other'}` as 'activity.reason.tool')} · {Math.max(0, Math.round((now - report.blockingSince) / 1000))}s</p>}
        {(report?.active ?? []).map(item => <div key={`${item.startedAt}-${item.turn}-${item.step}`} className={css.activeRow}>
          <span className={css.activityDot} aria-hidden />
          <span>{t('view.turn')} {item.turn} · {t('view.step')} {item.step}</span>
          <span className={css.muted}>{item.provider}/{item.model}</span>
          <span className={css.metric}>{t('view.estimate')} {count(item.originalTokens)} {t('view.tokens')}</span>
          <span className={css.muted}>{item.distiller}</span>
          <span className={css.metric}>{Math.max(0, Math.round((now - item.startedAt) / 1000))}s</span>
        </div>)}
      </section>}
      <section className={css.section}><h3>{t('view.entries')}</h3>{report.entries.length === 0 && <p className={css.muted}>{t('view.empty')}</p>}
        {/* "Why did nothing happen" is the one question the entries cannot answer, and it stays
            worth asking after an earlier step did compress. */}
        {report.lastDecision != null && <p className={css.muted}>{t('view.notTriggered')}: {report.lastDecision.turn}/{report.lastDecision.step} · {t(`view.why.${report.lastDecision.reason}` as Key)}</p>}
        {report.entries.map(entry => <Entry key={entry.id} entry={entry} sessionId={report.sessionId} t={t} liveStockIds={report.stockIds} />)}</section>
      <section className={css.section}><h3>{t('view.sessions')}</h3>{report.entries.map(entry => <SessionRow key={entry.id} entry={entry} t={t} openSession={openSession} />)}</section>
    </>}
  </div>
}
