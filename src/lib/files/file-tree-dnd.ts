/**
 * Shared drag-and-drop contract for the workspace file tree. A single MIME type
 * and payload shape are read by these independent drop targets:
 *  - the tree itself (drop a node onto a directory → move it there),
 *  - the message composer (drop a node onto the input → insert a file reference),
 *  - an open plugin editor page (the host forwards the drop into its iframe;
 *    Excalidraw adds a card linking to the file),
 *  - a workspace pane (open the file there, or paste the path into its terminal).
 *
 * The payload is serialized as JSON on a private MIME type so it can't be
 * confused with an OS file drop (`dataTransfer.files` / the `"Files"` type) or a
 * plain-text drop. A `text/plain` fallback (the absolute path) is set alongside
 * so dropping onto a terminal or a plain text field still yields something
 * useful.
 */

import { detectPlatform } from "@/hooks/use-platform"

/** Private MIME type carrying the JSON {@link FileTreeDragPayload}. Lowercase to
 * match how `DataTransfer.types` normalizes custom types. */
export const FILE_TREE_DND_MIME = "application/x-berth-tree-entry"

/** The five kinds of inline reference the composer can embed — mirrors the
 * tree node kinds it can carry. */
export interface FileTreeDragPayload {
  /** Absolute workspace root path the entry lives under. */
  rootPath: string
  /** Entry path relative to {@link rootPath} (forward slashes). */
  relPath: string
  /** Absolute path of the entry (`rootPath` joined with `relPath`). */
  absPath: string
  /** Leaf name of the entry. */
  name: string
  kind: "file" | "dir"
}

/**
 * The subset of `DataTransfer` the codec touches. Declaring it structurally
 * keeps the helpers unit-testable with a plain mock (jsdom's `DataTransfer` does
 * not implement `setData`/`getData` faithfully).
 */
export interface DragDataLike {
  setData: (format: string, data: string) => void
  getData: (format: string) => string
  readonly types: ReadonlyArray<string>
}

/**
 * Write the payload onto a drag's `dataTransfer`: the private JSON type (read
 * back by our drop targets) plus a `text/plain` absolute-path fallback for
 * foreign drop targets. Callers set `effectAllowed` separately since the tree
 * ("move") and composer ("copy") diverge.
 */
export function writeFileTreeDragData(
  dataTransfer: DragDataLike,
  payload: FileTreeDragPayload
): void {
  dataTransfer.setData(FILE_TREE_DND_MIME, JSON.stringify(payload))
  dataTransfer.setData("text/plain", payload.absPath)
}

/**
 * Whether a drag carries a file-tree payload. Reads `types` (available in
 * `dragover`, unlike `getData`), so a drop target can decide to accept the drop
 * before it lands.
 */
export function hasFileTreeDragType(
  dataTransfer: Pick<DragDataLike, "types"> | null | undefined
): boolean {
  if (!dataTransfer) return false
  // `types` entries are lowercased by the platform; compare accordingly.
  return Array.from(dataTransfer.types).some(
    (type) => type.toLowerCase() === FILE_TREE_DND_MIME
  )
}

/**
 * Parse the file-tree payload from a completed drop, or null when the drag
 * carries none or the JSON is malformed / the wrong shape. Only valid to call in
 * a `drop` handler (where `getData` returns data).
 */
export function readFileTreeDragPayload(
  dataTransfer: DragDataLike | null | undefined
): FileTreeDragPayload | null {
  if (!dataTransfer) return null
  const raw = dataTransfer.getData(FILE_TREE_DND_MIME)
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const candidate = parsed as Record<string, unknown>
  const { rootPath, relPath, absPath, name, kind } = candidate
  if (
    typeof rootPath !== "string" ||
    typeof relPath !== "string" ||
    typeof absPath !== "string" ||
    typeof name !== "string" ||
    (kind !== "file" && kind !== "dir")
  ) {
    return null
  }
  return { rootPath, relPath, absPath, name, kind }
}

/**
 * DOM attribute marking a directory drop zone. Its value is the destination
 * directory path relative to the workspace root (`""` = the root itself).
 */
export const FILE_TREE_DROP_DIR_ATTR = "data-tree-drop-dir"
/**
 * DOM attribute marking the message composer as a drop zone. Its value is the
 * composer's attachment tab id, used to route a dropped entry to that specific
 * session's input.
 */
export const FILE_TREE_DROP_COMPOSER_ATTR = "data-tree-drop-composer"

/**
 * DOM attribute marking a directory of another device's project as a drop zone
 * (`<device id>:<absolute dir on that device>`): a dropped file is transferred
 * there over the device's node connection.
 */
export const FILE_TREE_DROP_DEVICE_ATTR = "data-tree-drop-device"

/** Where a file-tree drag landed, resolved from the element under the drop
 *  point. `dir` moves the entry; `composer` inserts a file reference; `device`
 *  transfers the file to another device. */
export type FileTreeDropZone =
  | { kind: "dir"; destDir: string }
  | { kind: "composer"; tabId: string }
  | { kind: "device"; deviceId: number; dir: string }

/**
 * 桌面端 Tauri 原生拖放事件（Over / Drop）的坐标 → 该点下的元素。macOS（窗口点）与
 * Linux（GTK 逻辑像素）报的已是 CSS 像素；只有 Windows 按物理像素报，需除以 DPR（未实测）。
 */
export function cssDropPoint(position: { x: number; y: number }): {
  x: number
  y: number
} {
  const scale =
    detectPlatform() === "windows" ? window.devicePixelRatio || 1 : 1
  return { x: position.x / scale, y: position.y / scale }
}

export function elementAtDropPosition(position: {
  x: number
  y: number
}): Element | null {
  const { x, y } = cssDropPoint(position)
  return document.elementFromPoint(x, y)
}

/**
 * 对方文件发起的系统拖动用的本机缓存路径（最近一次）。原生拖放事件带着它回到窗口时，
 * 据此认出是自己的拖动而不是系统文件。
 */
let ownNativeDragPath: string | null = null
export function markOwnNativeDrag(path: string): void {
  ownNativeDragPath = path
}
export function isOwnNativeDrag(path: string | undefined): boolean {
  return path !== undefined && path === ownNativeDragPath
}

/** Parse a {@link FILE_TREE_DROP_DEVICE_ATTR} value. */
export function parseDeviceDropZone(
  value: string | null
): { deviceId: number; dir: string } | null {
  const match = value?.match(/^(\d+):(\/.*)$/)
  return match ? { deviceId: Number(match[1]), dir: match[2] } : null
}

/**
 * Resolve the drop zone under `element` by walking up to the nearest marked
 * ancestor: a folder row is itself, a file row is its parent directory, blank
 * tree space is the root. The web path passes the DOM event target; the desktop
 * path hit-tests the drop coordinates, because Tauri's webview consumes the
 * HTML5 `drop` before WebKit dispatches it. Returns null when the point isn't
 * over the tree or a composer.
 */
export function resolveFileTreeDropZone(
  element: Element | null
): FileTreeDropZone | null {
  if (!element) return null
  const device = parseDeviceDropZone(
    element
      .closest(`[${FILE_TREE_DROP_DEVICE_ATTR}]`)
      ?.getAttribute(FILE_TREE_DROP_DEVICE_ATTR) ?? null
  )
  if (device) return { kind: "device", ...device }
  const dirEl = element.closest(`[${FILE_TREE_DROP_DIR_ATTR}]`)
  const composerEl = element.closest(`[${FILE_TREE_DROP_COMPOSER_ATTR}]`)
  const toDir = (el: Element): FileTreeDropZone => ({
    kind: "dir",
    destDir: el.getAttribute(FILE_TREE_DROP_DIR_ATTR) ?? "",
  })
  const toComposer = (el: Element): FileTreeDropZone | null => {
    const tabId = el.getAttribute(FILE_TREE_DROP_COMPOSER_ATTR)
    return tabId ? { kind: "composer", tabId } : null
  }
  // The tree and the composer never nest, but if both matched, prefer the
  // deeper (more specific) zone.
  if (dirEl && composerEl) {
    return composerEl.contains(dirEl) ? toDir(dirEl) : toComposer(composerEl)
  }
  if (dirEl) return toDir(dirEl)
  if (composerEl) return toComposer(composerEl)
  return null
}
