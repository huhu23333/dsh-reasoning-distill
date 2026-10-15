/**
 * The quick-install contract shared by the host runner, the panel and the tests.
 *
 * Installing a companion backend is either a scripted install (the path this
 * repository has actually verified) or a hand-off to an agent working in a workspace
 * of the user's choosing. Both are described here so the panel, the route and the
 * runner cannot drift apart.
 * @module dsh-reasoning-distill/install-shared
 */

/** One companion backend the quick-install flow can offer. */
export interface InstallableBackend {
  /** Stored backend id, matching {@link REWRITE_BACKENDS}. */
  id: string
  /** Whether a scripted installer exists for it. */
  scripted: boolean
}

/**
 * One step the scripted installer reports progress for.
 *
 * The installer prints `##STEP <id>` / `##DONE <id>` / `##FAIL <id> <message>`; the
 * runner translates those into this list, so the panel never parses text itself.
 */
export interface InstallStep {
  id: string
  state: 'pending' | 'running' | 'done' | 'failed'
  /** Failure message, when the step failed. */
  error?: string
}

/** How far one install has come. */
export type InstallPhase = 'running' | 'done' | 'failed' | 'cancelled'

/** The state of one scripted install. */
export interface InstallJob {
  /** Backend being installed. */
  backendId: string
  phase: InstallPhase
  /** Steps in report order; the ones not reached stay pending. */
  steps: InstallStep[]
  /** Recent installer output, oldest first, capped by the runner. */
  log: string[]
  startedAt: number
  endedAt?: number
  /** Failure summary, when the install failed. */
  error?: string
}

/**
 * What the install route answers with.
 *
 * One payload serves both the first open and every poll: the job (absent when nothing
 * was ever started), the backend choices, the step labels and this plugin's checkout —
 * the last one because the agent prompt has to name the real instructions.
 */
export interface InstallStatus {
  job: InstallJob | null
  backends: readonly InstallableBackend[]
  steps: readonly { id: string; label: string }[]
  /** This plugin's checkout, for the agent prompt. */
  repo: string
}

/**
 * The steps the scripted `message-edit` install reports.
 *
 * Ordered: the runner marks a step running when its marker arrives, so an install
 * that dies half way leaves the later steps pending and the panel honest.
 */
export const INSTALL_STEPS: readonly { id: string; label: string }[] = [
  { id: 'resolve', label: '定位 DSH checkout 与 profile' },
  { id: 'install', label: '安装前置插件（官方 CLI 写入 profile）' },
  { id: 'patch', label: '应用本仓库补丁（幂等）' },
  { id: 'verify', label: '校验安装件与 vendor 逐字节一致' },
]

/** Backends the quick-install page lists, with why each is (not) scripted. */
export const INSTALLABLE_BACKENDS: readonly InstallableBackend[] = [
  { id: 'message-edit', scripted: true },
  { id: 'msg-edit', scripted: false },
  { id: 'context-shaping', scripted: false },
]

/** The installable entry for one backend id, when the page knows it. */
export function installableBackend(id: string): InstallableBackend | undefined {
  return INSTALLABLE_BACKENDS.find(item => item.id === id)
}

/**
 * The prompt that seeds the agent route's new session.
 *
 * It names the backend, the documents to read first, the limits of what was ever
 * verified, and what a useful report looks like — the user still decides whether to
 * send it.
 * @param backendId - backend the user picked.
 * @param repo - this plugin's checkout, so the agent reads the real instructions.
 * @returns the prompt text.
 */
export function installPromptFor(backendId: string, repo: string): string {
  const verified = backendId === 'message-edit'
  return [
    `请在本工作区里安装并接入 DSH 的「助手消息改写后端」：${backendId}。`,
    '',
    `第一步先读这两个文件（它们是本仓库唯一的事实来源）：${repo}/README.md 的「后端支持状态」与「安装与修补 message-edit 后端的完整流程」两节，以及 ${repo}/docs/message-edit-client-compat.md。`,
    '',
    verified
      ? '这个后端是本仓库唯一验证过的：请严格按 README 的流程做（装 vendor/dsh-message-edit-0.2.3-patched4.tgz 或原版后跑 scripts/patch-message-edit.py），每步都用 README 给出的校验命令确认。'
      : '注意：这个后端在本仓库里从未安装、修补、探测过，端点契约全是按第三方接口假定写下的，很可能根本装不通。你的任务是「探索并如实汇报」，不是「务必装通」：每一步都要先用它自己的文档或包内容核对假定，对不上就停下来记录，不要伪造成功。',
    '',
    '硬性要求：',
    `1. 只改与该后端安装相关的文件；不要改动本仓库的 scripts/**、src/**、vendor/**（除非你确认那正是修复所需，并在报告里逐条说明）。`,
    `2. 安装走官方 CLI：「pnpm dsh plugin --profile web add <包名或 tgz>」；装完用「node ${repo}/scripts/scan-session-logs.mjs」复检已有会话仍可加载。`,
    `3. 需要重启「dsh web」才生效的步骤，**不要自己重启**，把命令写进报告让用户执行。`,
    '4. 最后给出报告：装了什么包（确切名字与版本）、改了什么、验证了什么（命令与输出要点）、哪些假定没被证实、以及用户下一步该做什么。',
  ].join('\n')
}
