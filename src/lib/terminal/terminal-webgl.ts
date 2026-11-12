import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm"

/**
 * 可见终端用 WebGL 渲染，DOM 渲染器兜底。
 *
 * - 只给可见终端挂 WebglAddon；隐藏超过 RELEASE_DELAY_MS 才释放，来回切 tab 不反复重建上下文。
 * - 同时持有的上下文不超过 MAX_CONTEXTS（WebKit 约 16 个上限），满了先淘汰最久没显示的隐藏终端；
 *   全是可见终端时新来的留在 DOM。
 * - 初始化失败：本终端本次挂载留在 DOM；全局累计 MAX_INIT_FAILURES 次后所有终端退回 DOM。
 * - 上下文丢失（休眠唤醒、显卡重置）：退回 DOM，仍可见就稍后重试；同一终端丢失
 *   MAX_CONTEXT_LOSSES 次后本次挂载不再重试。
 * - 排查用：localStorage `berth.terminal.renderer` 设为 `dom` 强制 DOM。
 */

export type WebglAddonLike = ITerminalAddon & {
  onContextLoss: (listener: () => void) => IDisposable
  clearTextureAtlas: () => void
}

type WebglTerminal = Pick<Terminal, "loadAddon">

export interface TerminalWebglController {
  setVisible: (visible: boolean) => void
  /** 字体、字号、缩放、DPR 变化后清字形图集并整屏重画。 */
  refreshAtlas: () => void
  dispose: () => void
}

const RELEASE_DELAY_MS = 5000
const CONTEXT_LOSS_RETRY_MS = 2000
const MAX_CONTEXTS = 6
const MAX_INIT_FAILURES = 3
const MAX_CONTEXT_LOSSES = 3
const DEBUG_RENDERER_KEY = "berth.terminal.renderer"

interface Slot {
  visible: boolean
  lastVisibleAt: number
  release: () => void
}

const holders = new Set<Slot>()
let initFailures = 0

let addonModule: Promise<() => WebglAddonLike> | null = null
function loadWebglAddon(): Promise<() => WebglAddonLike> {
  addonModule ??= import("@xterm/addon-webgl").then(
    ({ WebglAddon }) =>
      () =>
        new WebglAddon() as unknown as WebglAddonLike,
    (error) => {
      addonModule = null
      throw error
    }
  )
  return addonModule
}

function forcedDom(): boolean {
  try {
    return localStorage.getItem(DEBUG_RENDERER_KEY) === "dom"
  } catch {
    return false
  }
}

/** 腾出一个上下文名额；全是可见终端时返回 false。 */
function reserveContext(): boolean {
  if (holders.size < MAX_CONTEXTS) return true
  let oldest: Slot | null = null
  for (const slot of holders) {
    if (slot.visible) continue
    if (!oldest || slot.lastVisibleAt < oldest.lastVisibleAt) oldest = slot
  }
  oldest?.release()
  return oldest !== null
}

export function createTerminalWebglController(
  term: WebglTerminal,
  options: { createAddon?: () => Promise<() => WebglAddonLike> } = {}
): TerminalWebglController {
  const createAddon = options.createAddon ?? loadWebglAddon
  let addon: WebglAddonLike | null = null
  let contextLossListener: IDisposable | null = null
  let loading = false
  let disposed = false
  let initFailed = false
  let contextLosses = 0
  let releaseTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const slot: Slot = { visible: false, lastVisibleAt: 0, release: () => {} }

  // 字体晚于图集加载完时，图集里是回退字体的字形，必须重建
  const fonts = typeof document === "undefined" ? undefined : document.fonts
  const onFontsLoaded = () => addon?.clearTextureAtlas()
  fonts?.addEventListener("loadingdone", onFontsLoaded)

  function release() {
    if (releaseTimer !== null) clearTimeout(releaseTimer)
    releaseTimer = null
    holders.delete(slot)
    contextLossListener?.dispose()
    contextLossListener = null
    const current = addon
    addon = null
    try {
      current?.dispose()
    } catch (error) {
      console.warn("[TerminalWebgl] dispose failed", error)
    }
  }
  slot.release = release

  function canUseWebgl() {
    return (
      !disposed &&
      !initFailed &&
      contextLosses < MAX_CONTEXT_LOSSES &&
      initFailures < MAX_INIT_FAILURES &&
      !forcedDom()
    )
  }

  async function acquire() {
    if (addon || loading || !slot.visible || !canUseWebgl()) return
    if (!reserveContext()) return
    loading = true
    holders.add(slot)
    let next: WebglAddonLike | null = null
    try {
      const make = await createAddon()
      // 等模块期间被淘汰、隐藏或销毁：放弃这次
      if (disposed || !slot.visible || addon || !holders.has(slot)) {
        holders.delete(slot)
        return
      }
      next = make()
      term.loadAddon(next)
      addon = next
      contextLossListener = next.onContextLoss(onContextLoss)
    } catch (error) {
      console.warn("[TerminalWebgl] falling back to DOM renderer", error)
      holders.delete(slot)
      initFailed = true
      initFailures++
      try {
        next?.dispose()
      } catch {
        // 半初始化的 addon 释放失败不影响 DOM 渲染
      }
    } finally {
      loading = false
    }
  }

  function onContextLoss() {
    contextLosses++
    release()
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = null
      void acquire()
    }, CONTEXT_LOSS_RETRY_MS)
  }

  return {
    setVisible(visible) {
      if (disposed) return
      slot.visible = visible
      if (visible) {
        slot.lastVisibleAt = performance.now()
        if (releaseTimer !== null) clearTimeout(releaseTimer)
        releaseTimer = null
        void acquire()
        return
      }
      if (addon && releaseTimer === null) {
        releaseTimer = setTimeout(release, RELEASE_DELAY_MS)
      }
    },
    refreshAtlas() {
      addon?.clearTextureAtlas()
    },
    dispose() {
      disposed = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryTimer = null
      fonts?.removeEventListener("loadingdone", onFontsLoaded)
      release()
    },
  }
}

export function __resetTerminalWebglForTests(): void {
  holders.clear()
  initFailures = 0
  addonModule = null
}
