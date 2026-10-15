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
export function scriptedSpawner(script: string, cwd: string = process.cwd()): InstallSpawner {
  return backendId => {
    const child = spawn('bash', [script, backendId], { cwd, env: process.env })
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
      onExit: handler => { child.once('close', code => handler(code)) },
      kill: () => { child.kill('SIGTERM') },
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
  private cancelled = false

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
    if (this.job?.phase === 'running') return { ok: false, error: `已有安装在进行中（${this.job.backendId}）` }
    const job: InstallJob = {
      backendId,
      phase: 'running',
      steps: pendingSteps(),
      log: [],
      startedAt: this.now(),
    }
    this.job = job
    this.cancelled = false
    try {
      const child = this.spawner(backendId)
      this.child = child
      child.onLine(line => this.consume(job, line))
      child.onExit(code => this.settle(job, code))
    } catch (error: unknown) {
      job.phase = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      job.endedAt = this.now()
      this.child = undefined
    }
    return { ok: true, job }
  }

  /** Ask the running installer to stop; the panel sees `cancelled` once it is gone. */
  cancel(): boolean {
    if (this.job?.phase !== 'running' || this.child === undefined) return false
    this.cancelled = true
    try {
      this.child.kill()
    } catch {
      // A child that already exited is not an error: the exit handler settles the job.
    }
    return true
  }

  /** Fold one output line into the job. */
  private consume(job: InstallJob, line: string): void {
    const marker = /^##(STEP|DONE|FAIL)\s+(\S+)(?:\s+(.*))?$/.exec(line)
    if (marker === null) {
      job.log.push(line)
      if (job.log.length > INSTALL_LOG_LIMIT) job.log.splice(0, job.log.length - INSTALL_LOG_LIMIT)
      return
    }
    const [, kind, id, rest] = marker
    const step = job.steps.find(candidate => candidate.id === id)
    if (step === undefined) {
      job.log.push(line)
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

  /** Write the terminal state once the child is gone. */
  private settle(job: InstallJob, code: number | null): void {
    this.child = undefined
    if (job.endedAt !== undefined) return
    job.endedAt = this.now()
    if (this.cancelled) {
      job.phase = 'cancelled'
      return
    }
    if (job.phase === 'failed') return
    if (code === 0) {
      job.phase = 'done'
      return
    }
    job.phase = 'failed'
    job.error = job.error ?? `安装器退出码 ${code === null ? '未知' : String(code)}`
  }
}
