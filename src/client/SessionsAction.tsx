/**
 * Compression-session list in the conversation header, parallel to the shipped
 * subagent catalog: same seat family, its own id, its own list of one-shot
 * distillation sessions. The model never sees these sessions; the user opens one
 * to read exactly what was sent to the distiller and what came back.
 * @module dsh-reasoning-distill/client/SessionsAction
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCopyOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { REPORT_ROUTE, type CompressionEntry, type SessionReport } from '../shared.ts'
import { NS } from './locales.ts'
import css from './View.module.css'

/** Injected face and standard props for the header action seat. */
type Props = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS> & {
  /** Session whose compressions are listed. */
  sessionId: string
  /** Reveal one compression session in the main column. */
  openSession: (id: string) => void
}

/** One short money string; the amounts here are fractions of a yuan. */
function money(amount: number): string {
  return `¥${(Number.isFinite(amount) ? amount : 0).toFixed(6)}`
}

/**
 * Header trigger plus its popup list of compression sessions.
 * @param props - header seat props.
 * @returns the trigger, and the popup while it is open.
 */
export function CompressionSessionsAction({ sessionId, openSession, t }: Props) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<CompressionEntry[] | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)
  const [copied, setCopied] = useState('')
  const trigger = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const sequence = useRef(0)

  const load = useCallback((): void => {
    if (sessionId === '') return
    // Responses must not cross sessions: navigating away while a read is in
    // flight would otherwise show one session's compressions beside another's.
    const request = ++sequence.current
    void fetch(REPORT_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as SessionReport
    }).then(report => {
      if (request === sequence.current) setEntries(report.entries)
    }).catch(() => { if (request === sequence.current) setEntries([]) })
  }, [sessionId])

  // One read per session so the trigger can carry a count; refreshed on demand.
  useEffect(() => {
    sequence.current += 1
    setEntries(null)
    load()
  }, [load])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (panel.current?.contains(target) === true || trigger.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const count = entries?.length ?? 0
  const toggle = (): void => {
    const rect = trigger.current?.getBoundingClientRect()
    if (rect !== undefined) setAnchor({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 380)), top: rect.bottom + 6 })
    setOpen(value => !value)
    load()
  }

  return <>
    <button ref={trigger} type="button" className={css.headerTrigger} onClick={toggle}
      title={t('header.title')} aria-label={t('header.title')} aria-expanded={open}>
      {t('header.trigger')}{entries !== null && count > 0 ? ` ${count}` : ''}
    </button>
    {open && anchor !== null && createPortal(
      <div ref={panel} className={css.popup} style={{ left: anchor.left, top: anchor.top }} role="dialog" aria-label={t('header.title')}>
        <div className={css.popupHead}>
          <strong>{t('header.title')}</strong>
          <button type="button" className={css.iconButton} title={t('view.refresh')} aria-label={t('view.refresh')} onClick={load}><IconRefreshOutlineRegular /></button>
        </div>
        {entries === null && <p className={css.muted}>{t('view.loading')}</p>}
        {entries !== null && entries.length === 0 && <p className={css.muted}>{t('header.empty')}</p>}
        <div className={css.popupList}>
          {(entries ?? []).map(entry => {
            const id = entry.distill.sessionId
            // In-memory by design: an id from an earlier run no longer opens.
            const expired = entry.sessionLive === false
            return <div className={css.popupRow} key={entry.id}>
              <div className={css.popupFacts}>
                <span>{t('view.turn')} {entry.turn} · {t('view.step')} {entry.step} · <span className={css.muted}>{entry.provider}/{entry.model}</span></span>
                <span className={css.muted}>{entry.originalTokens} → {entry.distilledTokens} {t('view.tokens')} · {money(entry.distill.cost)}</span>
                <code title={id}>{id === '' ? (entry.sessionMissing === true ? t('view.sessionMissing') : t('view.noSession')) : expired ? `${id} · ${t('view.sessionExpired')}` : id}</code>
                {entry.distill.error !== undefined && <span className={css.error}>{t('view.failedRun')}: {entry.distill.error}</span>}
              </div>
              <div className={css.popupActions}>
                <button type="button" className={css.iconButton} title={t('view.copy')} aria-label={t('view.copy')}
                  disabled={id === ''}
                  onClick={() => { void navigator.clipboard.writeText(id).then(() => setCopied(id)).catch(() => setCopied('')) }}>
                  <IconCopyOutlineRegular />
                </button>
                {id !== '' && !expired && <button type="button" className={css.secondary} onClick={() => { openSession(id); setOpen(false) }}>{t('view.open')}</button>}
              </div>
              {copied === id && id !== '' && <span className={css.muted} role="status">{t('view.copied')}</span>}
            </div>
          })}
        </div>
      </div>,
      document.body,
    )}
  </>
}
