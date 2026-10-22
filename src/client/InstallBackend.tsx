/**
 * The quick-install page for a companion backend.
 *
 * Reachable from the backend section of this plugin's Settings card. It offers the two
 * install routes — the repository's own script, or an agent working in a Workspace the
 * user picks — with the trade-off of each stated beside it.
 *
 * The scripted install runs in the host process, so this panel is only a view: it polls
 * the install route, which means closing the page (or reloading it) neither stops the
 * install nor loses its progress, and Cancel is a request to the same route.
 * @module dsh-reasoning-distill/client/InstallBackend
 */
import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { INSTALL_ROUTE } from '../shared.ts'
import { INSTALLABLE_BACKENDS, INSTALL_STEPS, installPromptFor, type InstallJob, type InstallStatus } from '../install-shared.ts'
import { currentInstallBridge } from './install-bridge.ts'
import { NS, type Key } from './locales.ts'
import css from './Settings.module.css'

/** Translate bound to this plugin's namespace. */
type Translate = PropsLocale<typeof NS>['t']

/** How often the panel asks the host how far the install got. */
const POLL_MS = 1000

/** How many installer lines the page shows; the runner keeps more. */
const LOG_LINES = 24

/** Props of the quick-install page. */
export interface InstallBackendProps {
  /** Whether the page is on screen. */
  open: boolean
  /** Leave the page; a running install keeps going. */
  onClose: () => void
  /** Translator bound to this plugin's namespace. */
  t: Translate
}

/** The localized label of one step id, falling back to its raw id. */
function stepLabel(id: string, t: Translate): string {
  const key = `install.step.${id}`
  try {
    return t(key as Key)
  } catch {
    return id
  }
}

/**
 * Mark one step in words.
 * @param state - step state from the host.
 * @param t - translator.
 * @returns the glyph and text shown for that step.
 */
export function stepMark(state: InstallJob['steps'][number]['state'], t: Translate): string {
  if (state === 'done') return `✅ ${t('install.stepDone')}`
  if (state === 'failed') return `❌ ${t('install.stepFailed')}`
  if (state === 'running') return `⏳ ${t('install.stepRunning')}`
  return `• ${t('install.stepPending')}`
}

/** The one-line verdict for a settled job. */
export function jobVerdict(job: InstallJob, t: Translate): string {
  if (job.phase === 'done') return t('install.result.ok')
  if (job.phase === 'cancelled') return t('install.result.cancelled')
  if (job.phase === 'failed') return `${t('install.result.failed')}：${job.error ?? ''}`
  return t('install.result.running')
}

/**
 * The quick-install page.
 * @param props - open flag, close callback and translator.
 * @returns the page, or nothing while it is closed.
 */
export function InstallBackendPanel({ open, onClose, t }: InstallBackendProps) {
  const [backendId, setBackendId] = useState(INSTALLABLE_BACKENDS[0]?.id ?? '')
  const [mode, setMode] = useState<'script' | 'agent'>('script')
  const [status, setStatus] = useState<InstallStatus | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [copied, setCopied] = useState(false)
  const bridge = currentInstallBridge()
  const workspaces = bridge?.workspaces() ?? []

  // One read on open covers a job started before the page was closed: the state lives
  // in the host, not here.
  useEffect(() => {
    if (!open) return
    let alive = true
    const read = (): void => {
      fetch(INSTALL_ROUTE).then(async response => response.ok ? await response.json() as InstallStatus : null)
        .then(data => {
          if (!alive || data === null) return
          setStatus(data)
          setError('')
        })
        .catch(() => { if (alive) setError(t('install.statusFailed')) })
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [open, t])

  if (!open) return null
  const backends = status?.backends ?? INSTALLABLE_BACKENDS
  const steps = status?.steps ?? INSTALL_STEPS
  const job = status?.job ?? null
  // A ##FAIL verdict can arrive before the child exits; only settlement releases it.
  const running = job !== null && job.endedAt === undefined
  const chosen = backends.find(item => item.id === backendId) ?? backends[0]

  /** Ask the host to start the scripted install. */
  const start = async (): Promise<void> => {
    setNotice('')
    try {
      const response = await fetch(INSTALL_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', backendId }),
      })
      const body = await response.json() as { job?: InstallJob; error?: string }
      if (!response.ok) {
        setError(body.error ?? `HTTP ${String(response.status)}`)
        return
      }
      setError('')
      setStatus(current => current === null ? current : { ...current, job: body.job ?? null })
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** Ask the host to stop the running install. */
  const cancel = async (): Promise<void> => {
    try {
      const response = await fetch(INSTALL_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      })
      const body = await response.json() as { job?: InstallJob; error?: string }
      if (!response.ok) {
        setError(body.error ?? `HTTP ${String(response.status)}`)
        return
      }
      setStatus(current => current === null ? current : { ...current, job: body.job ?? null })
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** The prompt the agent route would seed, or an empty string while the host is unknown. */
  const agentPrompt = status === null ? '' : installPromptFor(backendId, status.repo) ?? ''
  // Whether the shell offered what the agent route needs to try opening a Session. A packaged
  // desktop build may publish neither, so this only decides whether that button is offered —
  // never whether the prompt itself is shown.
  const canOpenSession = bridge !== undefined && workspaces.length > 0 && status !== null

  /** Seed a new Session in the chosen Workspace with the agent prompt. */
  const useAgent = (): void => {
    if (!canOpenSession || bridge === undefined || workspaceId === '') return
    bridge.startSession(workspaceId, agentPrompt)
    setNotice(t('install.agentStarted'))
  }

  /** Copy the prompt so it can be pasted into any session by hand. */
  const copyPrompt = async (): Promise<void> => {
    setNotice('')
    try {
      await navigator.clipboard.writeText(agentPrompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError(t('install.copyFailed'))
    }
  }

  return <div className={css.modalBackdrop} role="dialog" aria-modal="true">
    <div className={css.modal}>
      <header className={css.modalHead}>
        <h3>{t('install.title')}</h3>
        <button type="button" className={css.secondary} onClick={onClose}>{t('install.close')}</button>
      </header>
      <div className={css.modalBody}>
        <h4>{t('install.stepBackend')}</h4>
        <div className={css.checks}>
          {backends.map(item => <label key={item.id} className={css.inline}>
            <input type="radio" name="install-backend" checked={item.id === backendId} disabled={running}
              onChange={() => { setBackendId(item.id); setError(''); setNotice('') }} />
            <span>{item.id}</span>
          </label>)}
        </div>
        {chosen !== undefined && <p className={css.note}>{t(`install.note.${chosen.id}` as Key)}</p>}

        <h4>{t('install.stepMode')}</h4>
        <div className={css.modeCards}>
          <label className={css.modeCard}>
            <input type="radio" name="install-mode" checked={mode === 'script'} onChange={() => setMode('script')} />
            <strong>{t('install.mode.script')}</strong>
            <span className={css.note}>{t('install.mode.script.pros')}</span>
            <span className={css.error}>{t('install.mode.script.cons')}</span>
          </label>
          <label className={css.modeCard}>
            <input type="radio" name="install-mode" checked={mode === 'agent'} onChange={() => setMode('agent')} />
            <strong>{t('install.mode.agent')}</strong>
            <span className={css.note}>{t('install.mode.agent.pros')}</span>
            <span className={css.error}>{t('install.mode.agent.cons')}</span>
          </label>
        </div>

        {mode === 'script' && <div className={css.installBlock}>
          <div className={css.actions}>
            <button type="button" className={css.primary} disabled={running} onClick={() => { void start() }}>{t('install.start')}</button>
            <button type="button" className={css.secondary} disabled={!running} onClick={() => { void cancel() }}>{t('install.cancel')}</button>
          </div>
          {job !== null && <div className={css.installProgress}>
            <p role="status" className={job.phase === 'failed' ? css.error : css.note}>{jobVerdict(job, t)}</p>
            <ul className={css.steps}>
              {job.steps.map(step => <li key={step.id}>
                <span>{stepMark(step.state, t)}</span>
                <span>{stepLabel(step.id, t)}</span>
                {step.error !== undefined && <strong className={css.error}>{step.error}</strong>}
              </li>)}
            </ul>
            {job.log.length > 0 && <details className={css.logBox} open={job.phase === 'failed'}>
              <summary>{t('install.log')}</summary>
              <pre className={css.log}>{job.log.slice(-LOG_LINES).join('\n')}</pre>
            </details>}
          </div>}
        </div>}

        {mode === 'agent' && <div className={css.installBlock}>
          <h4>{t('install.agentWorkspace')}</h4>
          {bridge === undefined && <p className={css.note}>{t('install.agentNoShell')}</p>}
          {bridge !== undefined && workspaces.length === 0 && <p className={css.note}>{t('install.agentNoWorkspace')}</p>}
          {canOpenSession && <label className={css.field}>
            <span>{t('install.agentWorkspace')}</span>
            <select value={workspaceId} onChange={event => { setWorkspaceId(event.target.value); setNotice('') }}>
              <option value="">{t('install.agentPick')}</option>
              {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.label}</option>)}
            </select>
          </label>}
          {canOpenSession && <div className={css.actions}>
            <button type="button" className={css.primary} disabled={workspaceId === ''} onClick={useAgent}>{t('install.agentGo')}</button>
          </div>}
          {canOpenSession && <p className={css.note}>{t('install.agentHint')}</p>}
          {/* The prompt is ALWAYS on screen and copyable. Opening a Session is a shell capability
              this panel cannot verify: a shell may accept the call without opening anything, and
              then a success notice would be the only thing the user gets. */}
          {agentPrompt === '' && status !== null && <p className={css.note}>{t('install.promptUnavailable')}</p>}
          {agentPrompt !== '' && <>
            <p className={css.note}>{t('install.agentCopyHint')}</p>
            <textarea className={css.prompt} readOnly value={agentPrompt} onFocus={event => event.currentTarget.select()} />
            <div className={css.actions}>
              <button type="button" className={css.secondary}
                onClick={() => { void copyPrompt() }}>{copied ? t('install.copied') : t('install.copyPrompt')}</button>
            </div>
          </>}
        </div>}

        {error !== '' && <p role="alert" className={css.error}>{error}</p>}
        {notice !== '' && <p role="status" className={css.note}>{notice}</p>}
      </div>
    </div>
  </div>
}
