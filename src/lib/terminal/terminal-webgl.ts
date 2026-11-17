import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm"

/**
 * 可见终端用 WebGL 渲染，DOM 渲染器兜底。
 *
 * - 只给可见终端挂 WebglAddon；隐藏后保留，直到上下文名额不够才被淘汰，来回切 tab 不重建。
 * - 同时持有的上下文不超过 MAX_CONTEXTS（WebKit 约 16 个上限），满了先淘汰最久没显示的隐藏终端；
 *   全是可见终端时新来的留在 DOM。
 * - 释放时 dispose 后再 loseContext：addon-webgl 0.19 的 dispose 不释放 GL 上下文（xterm.js#6068），
 *   不手动释放会累积到上限，浏览器转而挤掉正在显示的终端。
 * - 字形图集防花屏（xterm.js#6038 / #6014，7.0 前的稳定版都有）：
 *   - 同字体、主题、DPR 的终端共用一张图集，图集页数到上限会合并页面，合并后取错字形。
 *     页数接近上限时把所有终端的 addon 一起换新：图集按终端引用计数，全部释放后才销毁，
 *     新 addon 从空图集开始，屏幕按 xterm buffer 重画。
 *   - 单个终端清图集会让共用图集的其他终端取到错位字形，所以清图集一律全部终端同帧一起清。
 *   - 休眠唤醒后驱动可能静默弄坏纹理且不发 contextlost，靠计时器断档检测后全部清图集。
 * - 初始化失败：本终端本次挂载留在 DOM；全局累计 MAX_INIT_FAILURES 次后所有终端退回 DOM。
 * - 上下文丢失（显卡重置）：退回 DOM，仍可见就稍后重试；同一终端丢失
 *   MAX_CONTEXT_LOSSES 次后本次挂载不再重试。
 * - 排查用：localStorage `berth.terminal.renderer` 设为 `dom` 强制 DOM。
 */

export type WebglAddonLike = ITerminalAddon & {
  onContextLoss: (listener: () => void) => IDisposable
  onAddTextureAtlasCanvas: (
    listener: (canvas: HTMLCanvasElement) => void
  ) => IDisposable
  onRemoveTextureAtlasCanvas: (
    listener: (canvas: HTMLCanvasElement) => void
  ) => IDisposable
  clearTextureAtlas: () => void
}

type WebglTerminal = Pick<Terminal, "loadAddon"> & { element?: HTMLElement }

export interface TerminalWebglController {
  setVisible: (visible: boolean) => void
  /** 字体、字号、缩放、DPR 变化后清字形图集并整屏重画（所有 WebGL 终端同帧一起清）。 */
  refreshAtlas: () => void
  dispose: () => void
}

const CONTEXT_LOSS_RETRY_MS = 2000
const MAX_CONTEXTS = 6
const MAX_INIT_FAILURES = 3
const MAX_CONTEXT_LOSSES = 3
/** 拿不到 GL 参数时按 WebKit 常见的 16 个纹理单元算。 */
const DEFAULT_MAX_ATLAS_PAGES = 16
/** 离合并阈值还差几页就整体换新。 */
const ATLAS_RECYCLE_HEADROOM = 2
const WAKE_CHECK_MS = 15_000
/** 计时器两次触发间隔超过这个值，视为休眠唤醒。 */
const WAKE_GAP_MS = 60_000
const DEBUG_RENDERER_KEY = "berth.terminal.renderer"

interface Slot {
  visible: boolean
  lastVisibleAt: number
  addon: () => WebglAddonLike | null
  release: () => void
  reacquire: () => void
}

const holders = new Set<Slot>()
let initFailures = 0

// 已挂上的 addon 报告过的图集页（不含每张图集建好时的首页）；同一页会经每个共用终端各报一次
const atlasPages = new Set<HTMLCanvasElement>()
let maxAtlasPages = 0
let recycleTimer: ReturnType<typeof setTimeout> | null = null
let clearTimer: ReturnType<typeof setTimeout> | null = null
let wakeTimer: ReturnType<typeof setInterval> | null = null
let lastWakeTick = 0

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

function listCanvases(term: WebglTerminal): HTMLCanvasElement[] {
  return Array.from(term.element?.querySelectorAll("canvas") ?? [])
}

/** loadAddon 后新出现、不是 xterm 2D 图层的 canvas 就是 WebGL 画布。 */
function findGlContext(
  before: HTMLCanvasElement[],
  after: HTMLCanvasElement[]
): WebGL2RenderingContext | null {
  for (const canvas of after) {
    if (before.includes(canvas)) continue
    if (Array.from(canvas.classList).some((name) => name.endsWith("-layer")))
      continue
    const gl = canvas.getContext("webgl2")
    if (gl) return gl
  }
  return null
}

/** 与 addon-webgl 的合并阈值一致：min(32, MAX_TEXTURE_IMAGE_UNITS)，至少 4。 */
function readMaxAtlasPages(gl: WebGL2RenderingContext | null) {
  if (maxAtlasPages || !gl) return
  const units =
    Number(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)) ||
    DEFAULT_MAX_ATLAS_PAGES
  maxAtlasPages = Math.max(4, Math.min(32, units))
}

function onAtlasPageAdded(canvas: HTMLCanvasElement) {
  atlasPages.add(canvas)
  const limit = maxAtlasPages || DEFAULT_MAX_ATLAS_PAGES
  if (atlasPages.size + 1 < limit - ATLAS_RECYCLE_HEADROOM) return
  // 不能在 addon 自己的绘制过程里 dispose
  recycleTimer ??= setTimeout(recycleAll, 0)
}

/** 全部释放让共享图集销毁，可见的随即用新 addon 从空图集重建。 */
function recycleAll() {
  recycleTimer = null
  const slots = Array.from(holders).filter((slot) => slot.addon())
  for (const slot of slots) slot.release()
  atlasPages.clear()
  for (const slot of slots) slot.reacquire()
}

/** 先全部清完再重画（重画由各渲染器排到下一帧），没有终端会按马上又被清掉的图集建模型。 */
function clearAllAtlases() {
  clearTimer = null
  for (const slot of holders) {
    try {
      slot.addon()?.clearTextureAtlas()
    } catch (error) {
      // 半死的上下文清不动不影响其他终端
      console.warn("[TerminalWebgl] clearTextureAtlas failed", error)
    }
  }
}

function scheduleClearAll() {
  clearTimer ??= setTimeout(clearAllAtlases, 0)
}

function syncWakeWatch() {
  if (holders.size > 0 && wakeTimer === null) {
    lastWakeTick = Date.now()
    wakeTimer = setInterval(() => {
      const now = Date.now()
      if (now - lastWakeTick > WAKE_GAP_MS) scheduleClearAll()
      lastWakeTick = now
    }, WAKE_CHECK_MS)
  } else if (holders.size === 0 && wakeTimer !== null) {
    clearInterval(wakeTimer)
    wakeTimer = null
  }
}

// 字体晚于图集加载完时，图集里是回退字体的字形，必须重建；全局只挂一次
if (typeof document !== "undefined") {
  document.fonts?.addEventListener("loadingdone", scheduleClearAll)
}

export function createTerminalWebglController(
  term: WebglTerminal,
  options: { createAddon?: () => Promise<() => WebglAddonLike> } = {}
): TerminalWebglController {
  const createAddon = options.createAddon ?? loadWebglAddon
  let addon: WebglAddonLike | null = null
  let gl: WebGL2RenderingContext | null = null
  let listeners: IDisposable[] = []
  let loading = false
  let disposed = false
  let initFailed = false
  let contextLosses = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const slot: Slot = {
    visible: false,
    lastVisibleAt: 0,
    addon: () => addon,
    release,
    reacquire: () => void acquire(),
  }

  function release() {
    holders.delete(slot)
    syncWakeWatch()
    for (const listener of listeners) listener.dispose()
    listeners = []
    const current = addon
    const currentGl = gl
    addon = null
    gl = null
    try {
      current?.dispose()
    } catch (error) {
      console.warn("[TerminalWebgl] dispose failed", error)
    }
    try {
      currentGl?.getExtension("WEBGL_lose_context")?.loseContext()
    } catch {
      // 上下文已经丢了
    }
  }

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
    syncWakeWatch()
    let next: WebglAddonLike | null = null
    try {
      const make = await createAddon()
      // 等模块期间被淘汰、隐藏或销毁：放弃这次
      if (disposed || !slot.visible || addon || !holders.has(slot)) {
        holders.delete(slot)
        syncWakeWatch()
        return
      }
      next = make()
      const before = listCanvases(term)
      term.loadAddon(next)
      addon = next
      gl = findGlContext(before, listCanvases(term))
      readMaxAtlasPages(gl)
      listeners = [
        next.onContextLoss(onContextLoss),
        next.onAddTextureAtlasCanvas(onAtlasPageAdded),
        next.onRemoveTextureAtlasCanvas((canvas) => atlasPages.delete(canvas)),
      ]
    } catch (error) {
      console.warn("[TerminalWebgl] falling back to DOM renderer", error)
      holders.delete(slot)
      syncWakeWatch()
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
      if (!visible) return
      slot.lastVisibleAt = performance.now()
      void acquire()
    },
    refreshAtlas() {
      if (addon) scheduleClearAll()
    },
    dispose() {
      disposed = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryTimer = null
      release()
    },
  }
}

export function __resetTerminalWebglForTests(): void {
  holders.clear()
  initFailures = 0
  addonModule = null
  atlasPages.clear()
  maxAtlasPages = 0
  if (recycleTimer !== null) clearTimeout(recycleTimer)
  if (clearTimer !== null) clearTimeout(clearTimer)
  if (wakeTimer !== null) clearInterval(wakeTimer)
  recycleTimer = null
  clearTimer = null
  wakeTimer = null
}
