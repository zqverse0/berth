import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { resetTabStore, useTabStore } from "@/stores/tab-store"
import {
  resetTerminalRuntimeStore,
  useTerminalRuntimeStore,
} from "@/stores/terminal-runtime-store"

import {
  bindTerminalPointer,
  readTerminalSourceIdentity,
  selectionFromTerminal,
  terminalPaneSession,
} from "./terminal"

function resetStores() {
  resetTerminalRuntimeStore()
  resetTabStore()
}

describe("terminalPaneSession", () => {
  it("uses the folder id for project terminals", () => {
    expect(terminalPaneSession({ folderId: 7, terminalId: "term-1" })).toBe("7")
  })

  it("mirrors the personal terminald session name", () => {
    expect(
      terminalPaneSession({ folderId: null, terminalId: "ab/cd.ef" })
    ).toBe("berth-terminal-ab_cd_ef")
  })
})

describe("readTerminalSourceIdentity", () => {
  beforeEach(resetStores)
  afterEach(resetStores)

  it("returns null until a backend id exists", () => {
    expect(readTerminalSourceIdentity("term-1")).toBeNull()
  })

  it("points at the terminald backend, window name, and pane 0", () => {
    useTerminalRuntimeStore.setState({
      sessions: {
        "term-1": {
          terminalId: "term-1",
          backendInstanceId: "backend-a",
          lastKnownCwd: "/repo",
        },
      },
    } as never)
    useTabStore.setState({
      rawTabs: [
        {
          kind: "terminal",
          id: "terminal:term-1",
          terminalId: "term-1",
          backendInstanceId: "backend-a",
          folderId: 7,
          title: "codex",
          initialCwd: "/repo",
          shell: "/bin/bash",
          detachedFolderLabel: null,
          detachedFolderPath: null,
          isPinned: true,
        },
      ],
    })

    expect(readTerminalSourceIdentity("term-1")).toEqual({
      type: "terminal",
      backendInstanceId: "backend-a",
      terminalId: "term-1",
      pane: { session: "7", window: "term-1", index: 0 },
      cwd: "/repo",
      title: "codex",
    })
  })
})

describe("selectionFromTerminal", () => {
  it("keeps the excerpt and identity without making the surface editable", () => {
    const identity = {
      type: "terminal" as const,
      backendInstanceId: "backend-a",
      terminalId: "term-1",
      pane: { session: "7", window: "term-1", index: 0 },
    }
    expect(selectionFromTerminal({ excerpt: "npm test", identity })).toEqual({
      excerpt: "npm test",
      editable: false,
      source: { identity, excerpt: "npm test" },
    })
    expect(selectionFromTerminal({ excerpt: "   ", identity })).toBeNull()
  })
})

describe("bindTerminalPointer", () => {
  it("reports xterm selection onto an owned pointer surface", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    let selection = "ls"
    const listeners: Array<() => void> = []
    const reports: unknown[] = []
    const dispose = bindTerminalPointer({
      host,
      term: {
        getSelection: () => selection,
        onSelectionChange: (listener) => {
          listeners.push(listener)
          return { dispose: () => undefined }
        },
      },
      getIdentity: () => ({
        type: "terminal",
        backendInstanceId: "backend-a",
        terminalId: "term-1",
        pane: { session: "7", window: "term-1", index: 0 },
      }),
      getPointer: () => ({
        reportSelection: (value) => {
          reports.push(value)
        },
      }),
    })

    expect(host.getAttribute("data-pointer-surface")).toBe("")
    expect(reports[0]).toMatchObject({ excerpt: "ls" })
    selection = "npm test"
    listeners[0]?.()
    expect(reports[reports.length - 1]).toMatchObject({ excerpt: "npm test" })
    host.dispatchEvent(
      new PointerEvent("pointerdown", { button: 2, bubbles: true })
    )
    expect(reports[reports.length - 1]).toMatchObject({ excerpt: "npm test" })
    dispose()
    expect(reports[reports.length - 1]).toBeNull()
    host.remove()
  })
})
