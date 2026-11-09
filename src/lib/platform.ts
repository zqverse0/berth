import { isDesktop, getTransport } from "./transport"
import type { UnsubscribeFn } from "./transport/types"

/**
 * Platform-aware API wrappers for the desktop-only product.
 */

export { isDesktop }

/**
 * True for the local desktop app. Kept as a named helper so call sites that
 * historically distinguished remote-desktop windows keep compiling.
 */
export function isLocalDesktop(): boolean {
  return isDesktop()
}

/**
 * Subscribe to backend events via Tauri listen().
 */
export async function subscribe<T>(
  event: string,
  handler: (payload: T) => void
): Promise<UnsubscribeFn> {
  return getTransport().subscribe(event, handler)
}

/**
 * Open a URL in the default browser.
 */
export async function openUrl(url: string): Promise<void> {
  if (isDesktop()) {
    const { openUrl: tauriOpenUrl } = await import("@tauri-apps/plugin-opener")
    await tauriOpenUrl(url)
  } else {
    window.open(url, "_blank")
  }
}

/**
 * Open a path in the system file manager.
 */
export async function openPath(path: string): Promise<void> {
  if (!isDesktop()) return
  const { openPath: tauriOpenPath } = await import("@tauri-apps/plugin-opener")
  await tauriOpenPath(path)
}

/**
 * Reveal a file/directory in the system file manager.
 */
export async function revealItemInDir(path: string): Promise<void> {
  if (!isDesktop()) return
  const { revealItemInDir: tauriReveal } =
    await import("@tauri-apps/plugin-opener")
  await tauriReveal(path)
}

/** 把本机文件作为系统拖动发起（可拖到文件管理器），拖动结束后返回。需要鼠标还按着。 */
/** 系统剪贴板里的文件（别的应用复制的也算）；不是桌面端或没有文件时为空。 */
export async function readClipboardFiles(): Promise<
  { absPath: string; name: string; kind: "file" | "dir" }[]
> {
  if (!isDesktop()) return []
  return getTransport().call("clipboard_read_files", {})
}

/** 把本机文件写进系统剪贴板，文件管理器能粘贴。 */
export async function writeClipboardFiles(paths: string[]): Promise<void> {
  if (!isDesktop()) return
  await getTransport().call("clipboard_write_files", { paths })
}

export async function startFileDrag(
  path: string,
  imagePngDataUrl: string
): Promise<void> {
  if (!isDesktop()) return
  await getTransport().call("start_file_drag", {
    path,
    imagePng: imagePngDataUrl.split(",")[1],
  })
}

/**
 * Open a native file/directory dialog.
 */
export async function openFileDialog(options?: {
  directory?: boolean
  multiple?: boolean
  title?: string
  defaultPath?: string
}): Promise<string | string[] | null> {
  if (!isDesktop()) return null
  const { open } = await import("@tauri-apps/plugin-dialog")
  return open(options ?? {})
}

/** Native save dialog; returns the chosen path or null (cancelled / web). */
export async function saveFileDialog(options?: {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}): Promise<string | null> {
  if (!isDesktop()) return null
  const { save } = await import("@tauri-apps/plugin-dialog")
  return save(options ?? {})
}

/** 通过当前平台实现显示确认对话框。 */
export async function confirmDialog(message: string): Promise<boolean> {
  if (!isDesktop()) return window.confirm(message)
  const { confirm } = await import("@tauri-apps/plugin-dialog")
  return confirm(message)
}

/**
 * Get the current Tauri window.
 */
export async function getCurrentWindow() {
  if (!isDesktop()) return null
  const { getCurrentWindow: tauriGetCurrentWindow } =
    await import("@tauri-apps/api/window")
  return tauriGetCurrentWindow()
}
