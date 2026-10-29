import type { EditorState } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"

export interface EditorAppearance {
  fontFamily: string
  fontSize: number
  fontLigatures: boolean
  wordWrap: boolean
}

export interface EditorCapabilities {
  lineNumbers?: boolean
  readOnly?: boolean
  search?: boolean
  /** Vim 键位（个人偏好）；只读时不挂 */
  vim?: boolean
}

export interface EditorDocumentSnapshot {
  state: EditorState
  scrollTop: number
}

export interface EditorHandle {
  focus(): void
  getContent(): string
  replaceContent(content: string): void
  revealLine(lineNumber: number): number | null
  openSearch(): void
  getView(): EditorView | null
}
