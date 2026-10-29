"use client"

import { useTranslations } from "next-intl"

// Trusted sandbox: author scripts run, popups/forms/modals work, but the frame
// still has an opaque origin (no allow-same-origin) and cannot navigate the top
// window (no allow-top-navigation). Untrusted mode allows only the nonce-bound
// document-context bridge; the CSP still blocks every author script.
const SANDBOX_TRUSTED = "allow-scripts allow-popups allow-forms allow-modals"

/**
 * 唯一的 srcdoc 沙箱显示组件。输入必须是「已处理完毕」的 HTML 字符串
 * （本地 HTML：inlineHtmlResources + withSandboxCsp；Office：watch 快照 +
 * CSP；网页 Reader / 静态页：消毒 + CSP）。本组件只负责渲染与标题，不做
 * 任何来源处理。选区桥由外层 `PreviewSelectionLayer` 认 iframe
 * contentWindow 完成，调用方决定是否包一层。
 */
export function SandboxedHtmlDocument({
  srcDoc,
  title,
  trusted = false,
  onFrame,
}: {
  /** 已带 CSP（含桥 nonce）的完整 HTML。空字符串时不渲染。 */
  srcDoc: string
  /** 无障碍标题（iframe title）。 */
  title: string
  /** 信任开关只影响 sandbox 字符串；CSP 已在 srcDoc 内定型。 */
  trusted?: boolean
  /** 取 iframe 元素引用（选区层坐标换算等场景）。 */
  onFrame?: (frame: HTMLIFrameElement | null) => void
}) {
  const t = useTranslations("Folder.fileWorkspacePanel")

  if (!srcDoc) return null

  return (
    <iframe
      key={trusted ? "trusted" : "strict"}
      title={title || t("htmlPreviewTitle")}
      sandbox={trusted ? SANDBOX_TRUSTED : "allow-scripts"}
      srcDoc={srcDoc}
      ref={onFrame}
      className="absolute inset-0 h-full w-full border-0 bg-white"
    />
  )
}
