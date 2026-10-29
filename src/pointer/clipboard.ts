import { copyTextToClipboard } from "@/lib/utils"

import {
  parseSourcePayload,
  serializeSourcePlain,
  sourceToPayload,
} from "./serialize"
import {
  BERTH_SOURCE_HTML_ATTR,
  BERTH_SOURCE_MIME,
  BERTH_SOURCE_WEB_MIME,
  type SourceRef,
} from "./types"

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export function encodeSourceHtml(ref: SourceRef): string {
  const json = JSON.stringify(sourceToPayload(ref))
  const encoded = encodeURIComponent(json)
  const excerpt = escapeHtmlText(ref.excerpt)
  return `<span ${BERTH_SOURCE_HTML_ATTR}="${escapeHtmlAttr(encoded)}"></span>${excerpt}`
}

export function parseSourceFromHtml(html: string): SourceRef | null {
  if (!html.includes(BERTH_SOURCE_HTML_ATTR)) return null
  const match = html.match(new RegExp(`${BERTH_SOURCE_HTML_ATTR}="([^"]+)"`))
  if (!match?.[1]) return null
  try {
    const json = decodeURIComponent(
      match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    )
    return parseSourcePayload(JSON.parse(json))
  } catch {
    return null
  }
}

export function parseSourceFromClipboardData(
  data: Pick<DataTransfer, "getData"> | null | undefined
): SourceRef | null {
  if (!data) return null
  for (const type of [BERTH_SOURCE_MIME, BERTH_SOURCE_WEB_MIME]) {
    try {
      const raw = data.getData(type)
      if (!raw) continue
      const parsed = parseSourcePayload(JSON.parse(raw))
      if (parsed) return parsed
    } catch {
      // 下一种 MIME
    }
  }
  const html = data.getData("text/html")
  if (html) return parseSourceFromHtml(html)
  return null
}

function hasUserActivation(): boolean {
  try {
    return Boolean(navigator.userActivation?.isActive)
  } catch {
    return false
  }
}

/**
 * 在点击手势里同步写入 text/plain + text/html。
 * 不走 ClipboardItem 自定义类型：WebKit / Tauri 会抛 NotAllowedError。
 */
function writeViaCopyEvent(plain: string, html: string): boolean {
  if (typeof document === "undefined") return false
  const onCopy = (event: ClipboardEvent) => {
    event.preventDefault()
    event.clipboardData?.setData("text/plain", plain)
    if (html) event.clipboardData?.setData("text/html", html)
  }
  document.addEventListener("copy", onCopy, true)
  const textarea = document.createElement("textarea")
  textarea.value = plain
  textarea.setAttribute("readonly", "")
  textarea.setAttribute("aria-hidden", "true")
  textarea.style.position = "fixed"
  textarea.style.left = "-9999px"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.focus({ preventScroll: true })
  textarea.select()
  try {
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    textarea.remove()
    document.removeEventListener("copy", onCopy, true)
  }
}

export async function copySourceToClipboard(ref: SourceRef): Promise<boolean> {
  if (typeof window === "undefined") return false
  const plain = serializeSourcePlain(ref)
  const html = encodeSourceHtml(ref)
  if (writeViaCopyEvent(plain, html)) return true
  // 异步 Clipboard API 必须有用户激活，否则 WebKit 会打 NotAllowedError。
  if (hasUserActivation()) {
    return copyTextToClipboard(plain)
  }
  return false
}

export async function copyPlainToClipboard(text: string): Promise<boolean> {
  if (typeof window === "undefined") return false
  if (writeViaCopyEvent(text, "")) return true
  if (hasUserActivation()) {
    return copyTextToClipboard(text)
  }
  return false
}

export function copySourceFromMenu(ref: SourceRef): Promise<boolean> {
  return copySourceToClipboard(ref)
}

export function copyPlainFromMenu(text: string): Promise<boolean> {
  return copyPlainToClipboard(text)
}
