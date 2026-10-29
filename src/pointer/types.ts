import type { ComponentType, ReactNode } from "react"

/**
 * 选中出处：身份 + 可选位置 + 原文。
 * 只有设计过的源才带 identity；没有 identity 就只复制内容。
 */

export const BERTH_SOURCE_MIME = "application/x-berth-source+json"
export const BERTH_SOURCE_WEB_MIME = "web application/x-berth-source+json"
export const BERTH_SOURCE_HTML_ATTR = "data-berth-source"
export const BERTH_SOURCE_VERSION = 1 as const

export type SourceIdentity =
  | { type: "file"; path: string }
  | { type: "url"; url: string; title?: string }
  | {
      type: "terminal"
      backendInstanceId: string
      terminalId: string
      pane: {
        session: string
        window: string
        index: number
      }
      cwd?: string
      title?: string
    }

/** HTML/Office 预览里点中的 DOM 节点定位，不是源文件行号。 */
export type SourceElementSpan = {
  unit: "element"
  selector: string
  tagName: string
  ancestorPath?: string[]
  nearbyText?: string[]
  htmlSnippet?: string
}

export type SourceSpan =
  | { unit: "lines"; start: number; end: number }
  | { unit: "page"; page: number }
  /** 预览插件的元素路径（watch/1 的 data-path），可交给该插件的程序按路径读写。 */
  | { unit: "office"; paths: string[] }
  | SourceElementSpan

export type SourceRef = {
  identity: SourceIdentity
  span?: SourceSpan
  excerpt: string
}

export type SourcePayload = {
  v: typeof BERTH_SOURCE_VERSION
  identity: SourceIdentity
  span?: SourceSpan
  excerpt: string
}

export type PointerSelection = {
  source: SourceRef | null
  excerpt: string
  editable: boolean
}

/** 传给动作回调的上下文：选区 + 面板/菜单导航。 */
export type PointerSelectionActionContext = {
  selection: PointerSelection
  /** 打开本动作的面板（主菜单 → 面板） */
  openPanel: () => void
  /** 关闭整个浮动菜单 */
  closeMenu: () => void
  /** 面板 → 返回主菜单 */
  backToMenu: () => void
}

/**
 * 通用选区动作插槽：由业务方（如 PDF 预览）注册，pointer 只提供
 * 统一按钮外壳与面板容器，不感知具体业务。
 */
export type PointerSelectionAction = {
  id: string
  /** 当前选区是否展示该动作 */
  matches: (selection: PointerSelection) => boolean
  /** 按钮标签（调用方提供最终文案/i18n） */
  label: string
  /** 按钮图标 */
  icon: ReactNode
  /** 面板组件（可选）；存在时点击按钮切换到面板 */
  panel?: ComponentType<PointerSelectionActionContext>
  /** 无面板时的点击行为（可选） */
  onActivate?: (ctx: PointerSelectionActionContext) => void
}
