import { isTerminalTab } from "@/lib/workspace/primary-tabs"
import { useTabStore } from "@/stores/tab-store"
import { useTerminalRuntimeStore } from "@/stores/terminal-runtime-store"

import type { PointerSelection, SourceIdentity, SourceRef } from "../types"

type TerminalIdentity = Extract<SourceIdentity, { type: "terminal" }>

export type TerminalSelectionApi = {
  getSelection: () => string
  onSelectionChange: (listener: () => void) => { dispose: () => void }
}

export type TerminalPointerApi = {
  reportSelection: (selection: PointerSelection | null) => void
}

/** 与 terminald `folder_session_name` / `terminal_session_name` 对齐。 */
export function terminalPaneSession(input: {
  folderId: number | null | undefined
  terminalId: string
}): string {
  if (input.folderId != null) return String(input.folderId)
  const component = Array.from(input.terminalId, (character) =>
    /[A-Za-z0-9_-]/.test(character) ? character : "_"
  ).join("")
  return `berth-terminal-${component}`
}

export function readTerminalSourceIdentity(
  terminalId: string
): TerminalIdentity | null {
  const session = useTerminalRuntimeStore.getState().sessions[terminalId]
  const tab = useTabStore
    .getState()
    .rawTabs.find(
      (candidate) =>
        isTerminalTab(candidate) &&
        candidate.terminalId === terminalId &&
        (!session?.backendInstanceId ||
          candidate.backendInstanceId === session.backendInstanceId)
    )
  const backendInstanceId =
    session?.backendInstanceId ||
    (tab && isTerminalTab(tab) ? tab.backendInstanceId : "")
  if (!backendInstanceId.trim() || !terminalId.trim()) return null
  const folderId = tab && isTerminalTab(tab) ? tab.folderId : null
  const cwd =
    session?.lastKnownCwd ||
    (tab && isTerminalTab(tab)
      ? (tab.lastKnownCwd ?? tab.initialCwd)
      : undefined)
  const title = tab && isTerminalTab(tab) ? tab.title : undefined
  return {
    type: "terminal",
    backendInstanceId,
    terminalId,
    pane: {
      session: terminalPaneSession({ folderId, terminalId }),
      window: terminalId,
      index: 0,
    },
    ...(cwd?.trim() ? { cwd: cwd.trim() } : {}),
    ...(title?.trim() ? { title: title.trim() } : {}),
  }
}

export function selectionFromTerminal(input: {
  excerpt: string
  identity: TerminalIdentity | null
}): PointerSelection | null {
  const excerpt = input.excerpt.replace(/\r\n?/g, "\n")
  if (!excerpt.trim()) return null
  const source: SourceRef | null = input.identity
    ? { identity: input.identity, excerpt }
    : null
  return { excerpt, editable: false, source }
}

/**
 * 把 xterm 选区报到 pointer。右键菜单仍由 PointerProvider 统一弹出。
 */
export function bindTerminalPointer(options: {
  host: HTMLElement
  term: TerminalSelectionApi
  getIdentity: () => TerminalIdentity | null
  getPointer: () => TerminalPointerApi | null
}): () => void {
  const { host, term, getIdentity, getPointer } = options
  host.setAttribute("data-pointer-surface", "")

  const report = () => {
    const pointer = getPointer()
    if (!pointer) return
    pointer.reportSelection(
      selectionFromTerminal({
        excerpt: term.getSelection(),
        identity: getIdentity(),
      })
    )
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 2) return
    report()
  }

  const change = term.onSelectionChange(report)
  host.addEventListener("pointerdown", onPointerDown, true)
  report()

  return () => {
    change.dispose()
    host.removeEventListener("pointerdown", onPointerDown, true)
    getPointer()?.reportSelection(null)
  }
}
