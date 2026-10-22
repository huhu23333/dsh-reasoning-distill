/**
 * The scripted backend installer.
 *
 * One installer runs at a time, in a child process of the host, so closing the
 * settings page (or opening it again) neither stops it nor loses its progress: the
 * panel polls {@link InstallRunner.status}. Cancelling kills the process; the panel
 * then reads the cancelled state.
 *
 * The child speaks a tiny line protocol (`##STEP <id>` / `##DONE <id>` /
 * `##FAIL <id> <message>`); everything else is kept as log output. Parsing lives here,
 * not in the panel, so both agree on what a step is.
 * @module dsh-reasoning-distill/install
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { INSTALL_STEPS, type InstallJob, type InstallStep } from './install-shared.ts'

/** One running installer process, injectable so tests never spawn anything. */
export interface InstallProcess {
  /** Called for every complete output line. */
  onLine(handler: (line: string) => void): void
  /** Called once the process is gone. */
  onExit(handler: (code: number | null) => void): void
  /**
   * Called when the process fails outside its own output — a `bash` that is
   * missing or not executable, say — so the failure never surfaces as the host's
   * unhandled `error` event. Optional: a fake that cannot fail need not report.
   */
  onError?(handler: (error: Error) => void): void
  /** Ask the process to stop. */
  kill(): void
}

/** Starts the installer for one backend. */
export type InstallSpawner = (backendId: string) => InstallProcess

/**
 * The installer script this package ships.
 * @param here - this module's URL; defaults to the built bundle's own location.
 * @returns the absolute path of the script.
 */
export function installerScript(here: string = import.meta.url): string {
  return fileURLToPath(new URL('../scripts/install-backend.sh', here))
}

/**
 * This plugin's checkout, as the host sees it.
 *
 * The agent route tells the user's agent where to read the real instructions, so the
 * path has to come from the running bundle rather than from a guess about cwd.
 * @param here - this module's URL; defaults to the built bundle's own location.
 * @returns the absolute plugin root.
 */
export function pluginRoot(here: string = import.meta.url): string {
  return fileURLToPath(new URL('..', here))
}

/**
 * The real spawner: run the shipped installer under bash and stream its lines.
 *
 * The child inherits the host's environment so `DSH_HOME`, `DSH_PROFILE` and
 * `DSH_CHECKOUT` keep whatever the host was started with, and it runs in the
 * checkout the host itself runs from.
 * @param script - absolute path of the installer.
 * @param cwd - working directory for the child; the current one by default.
 * @returns a spawner the runner can drive.
 */
export interface SpawnerOptions {
  /** Working directory for the installer; the current one by default. */
  cwd?: string
  /** Environment for the installer; the host's own by default. */
  env?: NodeJS.ProcessEnv
}

/** How long the installer's process tree gets between SIGTERM and SIGKILL. */
const CANCEL_GRACE_MS = 5_000

export function scriptedSpawner(script: string, options: SpawnerOptions = {}): InstallSpawner {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  return backendId => {
    // The installer drives node/pnpm/python children. Without a process group,
    // killing bash leaves them running while the panel says "cancelled".
    const detached = process.platform !== 'win32'
    const child = spawn('bash', [script, backendId], { cwd, env, detached })
    let escalation: ReturnType<typeof setTimeout> | undefined
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // fall through to the direct child
        }
      }
      try { child.kill(signal) } catch { /* already gone */ }
    }
    return {
      onLine: handler => {
        let buffer = ''
        const drain = (chunk: Buffer): void => {
          buffer += chunk.toString('utf8')
          let cut = buffer.indexOf('\n')
          while (cut >= 0) {
            handler(buffer.slice(0, cut))
            buffer = buffer.slice(cut + 1)
            cut = buffer.indexOf('\n')
          }
        }
        child.stdout.on('data', drain)
        child.stderr.on('data', drain)
      },
      onExit: handler => {
        child.once('close', code => {
          if (escalation !== undefined) clearTimeout(escalation)
          handler(code)
        })
      },
      // A spawn that never got its program running reports through `error` and may
      // still emit `close` afterwards; both end up in the runner's single terminal
      // step, which settles the job only once.
      onError: handler => {
        child.once('error', error => {
          if (escalation !== undefined) clearTimeout(escalation)
          handler(error)
        })
      },
      kill: () => {
        signalGroup('SIGTERM')
        escalation ??= setTimeout(() => signalGroup('SIGKILL'), CANCEL_GRACE_MS)
        escalation.unref?.()
      },
    }
  }
}

/** How many output lines a job keeps; the panel shows a bounded tail. */
export const INSTALL_LOG_LIMIT = 400

/** Fresh step list for one job: everything pending until the child says otherwise. */
function pendingSteps(): InstallStep[] {
  return INSTALL_STEPS.map(step => ({ id: step.id, state: 'pending' as const }))
}

/**
 * Drive one scripted install and remember how far it got.
 *
 * Deliberately process-wide state: the install outlives the page that started it, and
 * the route plus every panel read the same job.
 */
export class InstallRunner {
  private job: InstallJob | undefined
  private child: InstallProcess | undefined
  private readonly cancelled = new WeakSet<InstallJob>()

  /**
   * @param spawner - starts the installer child.
   * @param now - clock, injectable for tests.
   */
  constructor(private readonly spawner: InstallSpawner, private readonly now: () => number = Date.now) {}

  /** The running or last finished install, for a panel that just opened. */
  status(): InstallJob | undefined {
    return this.job
  }

  /**
   * Start one install.
   * @param backendId - backend to install.
   * @returns the started job, or why it could not start.
   */
  start(backendId: string): { ok: true; job: InstallJob } | { ok: false; error: string } {
    if (this.job !== undefined && this.job.endedAt === undefined) return { ok: false, error: `已有安装在进行中（${this.job.backendId}）` }
    const job: InstallJob = {
      backendId,
      phase: 'running',
      steps: pendingSteps(),
      log: [],
      startedAt: this.now(),
    }
    this.job = job
    try {
      const child = this.spawner(backendId)
      this.child = child
      child.onLine(line => this.consume(job, line))
      child.onExit(code => this.settle(job, code))
      child.onError?.(error => this.settle(job, null, error))
    } catch (error: unknown) {
      // A spawner that throws synchronously fails the same way an asynchronous
      // `error` event does, so it ends through that one terminal step too.
      this.settle(job, null, error)
    }
    return { ok: true, job }
  }

  /** Ask the running installer to stop; the panel sees `cancelled` once it is gone. */
  cancel(): boolean {
    if (this.job === undefined || this.job.endedAt !== undefined || this.child === undefined) return false
    this.cancelled.add(this.job)
    try {
      this.child.kill()
    } catch {
      // A child that already exited is not an error: the exit handler settles the job.
    }
    return true
  }

  /** Append one log line, keeping the bounded tail. */
  private pushLog(job: InstallJob, line: string): void {
    job.log.push(line)
    if (job.log.length > INSTALL_LOG_LIMIT) job.log.splice(0, job.log.length - INSTALL_LOG_LIMIT)
  }

  /** Fold one output line into the job. */
  private consume(job: InstallJob, line: string): void {
    if (job.endedAt !== undefined) return
    const marker = /^##(STEP|DONE|FAIL)\s+(\S+)(?:\s+(.*))?$/.exec(line)
    if (marker === null) {
      this.pushLog(job, line)
      return
    }
    const [, kind, id, rest] = marker
    const step = job.steps.find(candidate => candidate.id === id)
    if (step === undefined) {
      // An unknown step id (script/plugin version skew) still has to obey the
      // cap: serializing an unbounded log on every poll would grow the host.
      this.pushLog(job, line)
      return
    }
    if (kind === 'STEP') step.state = 'running'
    if (kind === 'DONE') step.state = 'done'
    if (kind === 'FAIL') {
      step.state = 'failed'
      step.error = rest === undefined || rest === '' ? '步骤失败' : rest
      job.phase = 'failed'
      job.error = `${id}: ${step.error}`
    }
  }

  /**
   * Write the terminal state once the child is gone.
   *
   * `close`, `error` and cancellation can reach this for one job, so it is the
   * only place that ends a job: it writes nothing once the job has already ended
   * and never lets a spawn failure pass as a successful exit.
   *
   * Only the job that is still current unregisters its child, and only when this call
   * is the one that ends it. A failed spawn reports `error` first and `close`
   * afterwards; its late close must not clear a successor's child. `##FAIL` is
   * only a failure verdict, not proof the process exited: it retains the slot
   * and remains cancellable until settlement. Cancellation belongs to this
   * job, never to whichever job happens to be current when a callback arrives.
   * @param job - job to end.
   * @param code - exit code, or null when the child never ran.
   * @param error - the spawn failure to report, when there was one.
   */
  private settle(job: InstallJob, code: number | null, error?: unknown): void {
    if (job.endedAt !== undefined) return
    if (this.job === job) this.child = undefined
    job.endedAt = this.now()
    if (this.cancelled.has(job)) {
      // A cancel request must not rewrite a result the script already produced:
      // keep an explicit failure, and treat "all steps done" as done.
      if (job.phase === 'failed') return
      if (job.steps.every(step => step.state === 'done')) {
        job.phase = 'done'
        return
      }
      job.phase = 'cancelled'
      return
    }
    if (job.phase === 'failed') return
    if (code === 0 && error === undefined) {
      job.phase = 'done'
      return
    }
    job.phase = 'failed'
    job.error = job.error ?? (error === undefined
      ? `安装器退出码 ${code === null ? '未知' : String(code)}`
      : error instanceof Error ? error.message : String(error))
  }
}
