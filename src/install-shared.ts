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
 * that dies half way leaves the later steps pending and the panel honest. One list serves every
 * backend, and a backend with nothing to do for a step reports that step done rather than skipping
 * it: the in-place install has no companion package, so its `install` step says exactly that.
 */
export const INSTALL_STEPS: readonly { id: string; label: string }[] = [
  { id: 'resolve', label: '定位 DSH checkout 与 profile' },
  { id: 'install', label: '安装前置插件（官方 CLI 写入 profile）' },
  { id: 'patch', label: '应用本仓库补丁（幂等）' },
  { id: 'verify', label: '校验安装件与 vendor 逐字节一致' },
]

/**
 * Backends the quick-install page lists.
 *
 * Both are installable, and each installs what it actually needs: `message-edit` is a companion
 * package the page adds to the profile and then patches, while `in-place` is this plugin's own
 * backend whose entire prerequisite is a patch to the host, so its quick install *is* that patch.
 */
export const INSTALLABLE_BACKENDS: readonly InstallableBackend[] = [
  { id: 'message-edit' },
  { id: 'in-place' },
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
  if (backendId === 'in-place') {
    return [
      '请为这台机器上的 DSH 打上「原位改写」后端的宿主补丁：这个后端内置在本插件里，安装就是打补丁，不需要安装任何伴随包。',
      '',
      '宿主源码位置因机器而异，**不要假设任何目录布局**：补丁脚本自己定位，你只需要执行它。',
      '',
      `第一步先读 ${repo}/README.md 的「内置原位后端（in-place）与宿主补丁」一节，那里有这 14 处编辑改了什么、以及怎么回退。`,
      '',
      `定位（只打印，不改任何文件）：node ${repo}/scripts/dsh-inplace-patch.mjs --locate`,
      `打补丁并校验构建：node ${repo}/scripts/dsh-inplace-patch.mjs --apply --build`,
      `复核：node ${repo}/scripts/dsh-inplace-patch.mjs --check（打全输出 PATCHED，未打输出 NOT PATCHED 且退出码 1）`,
      '',
      '定位顺序：--checkout > $DSH_HOST_CHECKOUT > $DSH_CHECKOUT > 从当前工作目录向上找到第一个含 packages/core/session/src/surface.ts 的目录 > 从 @deepseek-ai/dsh-session 反解出的包目录向上找。全部找不到时会列出试过哪些路径并退出 1 —— 这时请用 `--checkout <这台机器上 DSH 源码的实际目录>` 重跑，不要猜、也不要把路径写死进任何文件。',
      '',
      '脚本的行为契约：逐条字面编辑，任何一处锚点对不上就整体拒绝、不做部分写入；写入失败回滚；目标文件里有**别人**的未提交改动就拒绝（--force 可越过，但除非你确认那正是修复所需，否则不要用）。',
      '',
      '硬性要求：',
      '1. 不要手工编辑宿主源码：只通过该脚本打补丁，这样 --revert 才能逐字节回到 HEAD。',
      '2. 想验证「改动扛得住重启」，按脚本头部说明把 probe-inplace-durability.mjs 复制进 checkout 运行（它用临时目录，不留残留）。',
      '3. 需要重启「dsh web」才生效：**不要自己重启**，把命令写进报告让用户执行。',
      '4. 最后给出报告：--locate 定位到的 checkout、--check 前后输出、tsc -b 是否通过、哪些假定没被证实、以及用户下一步该做什么。',
      '',
      `回退：node ${repo}/scripts/dsh-inplace-patch.mjs --revert --build`,
    ].join('\n')
  }
  return [
    `请在本工作区里安装并接入 DSH 的「助手消息改写后端」：${backendId}。`,
    '',
    `第一步先读 ${repo}/README.md 的「助手消息改写后端」一节（含「旧后端 \`message-edit\`（保留兼容，不推荐）」与「（旧）\`message-edit\` 后端安装流程」）——它是这条流程的事实来源。`,
    '',
    '注意这是**旧后端（不推荐）**：每压缩一次就多一个分支会话（会堆满对话/归档列表），且要额外安装并修补 `dsh-message-edit`。请严格按 README 的流程做（装 vendor/dsh-message-edit-0.2.3-patched4.tgz 或原版后跑 scripts/patch-message-edit.py），每步都用 README 给出的校验命令确认。',
    '',
    '硬性要求：',
    `1. 只改与该后端安装相关的文件；不要改动本仓库的 scripts/**、src/**、vendor/**（除非你确认那正是修复所需，并在报告里逐条说明）。`,
    `2. 安装走官方 CLI：「pnpm dsh plugin --profile web add <包名或 tgz>」；装完用「node ${repo}/scripts/scan-session-logs.mjs」复检已有会话仍可加载。`,
    `3. 需要重启「dsh web」才生效的步骤，**不要自己重启**，把命令写进报告让用户执行。`,
    '4. 最后给出报告：装了什么包（确切名字与版本）、改了什么、验证了什么（命令与输出要点）、哪些假定没被证实、以及用户下一步该做什么。',
  ].join('\n')
}
