import type { Compartment, EditorState } from "@codemirror/state"
import type { EditorDocumentSnapshot } from "./contracts"

export interface EditorDocumentRuntime extends EditorDocumentSnapshot {
  id: string
  appearance: Compartment
  capabilities: Compartment
  language: Compartment
  visuals: Compartment
  callbacks: Compartment
}

/**
 * 将编辑器状态与 React、工作区业务状态分离。
 * 文档 ID 必须使用稳定的标签身份，不能只使用文件路径。
 */
export class EditorDocumentRegistry {
  private readonly documents = new Map<string, EditorDocumentRuntime>()
  private readonly listeners = new Set<() => void>()

  /** 编辑器状态（光标、内容）变化时通知；状态栏据此显示光标位置。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(id: string): EditorDocumentRuntime | undefined {
    return this.documents.get(id)
  }

  set(runtime: EditorDocumentRuntime): void {
    this.documents.set(runtime.id, runtime)
  }

  updateState(id: string, state: EditorState): void {
    const current = this.documents.get(id)
    if (!current) return
    current.state = state
    for (const listener of this.listeners) listener()
  }

  updateScroll(id: string, scrollTop: number): void {
    const current = this.documents.get(id)
    if (current) current.scrollTop = scrollTop
  }

  delete(id: string): void {
    this.documents.delete(id)
  }

  retain(ids: ReadonlySet<string>, prefix?: string): void {
    for (const id of this.documents.keys()) {
      if (prefix && !id.startsWith(prefix)) continue
      if (!ids.has(id)) this.documents.delete(id)
    }
  }

  clear(): void {
    this.documents.clear()
  }

  get size(): number {
    return this.documents.size
  }
}

export const editorDocumentRegistry = new EditorDocumentRegistry()
