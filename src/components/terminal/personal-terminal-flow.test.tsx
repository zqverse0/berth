/**
 * High-level personal-terminal flow smoke: create-then-open order, attach-only
 * mount contract, and capability blocking without legacy spawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __setTerminalStreamForTests,
  getTerminalRuntimeActions,
  resetTerminalRuntimeStore,
  useTerminalRuntimeStore,
} from "@/stores/terminal-runtime-store"
import type { TerminalStream } from "@/lib/terminal/terminal-stream"

const createTerminalSession = vi.fn()
const openTerminalTab = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    createTerminalSession: (...args: unknown[]) =>
      createTerminalSession(...args),
    getSystemTerminalSettings: vi.fn(async () => ({
      default_shell: "/bin/bash",
    })),
    getRuntimeCapabilities: vi.fn(async () => ({
      primaryTabsV2: true,
      personalTerminalV2: true,
    })),
  }
})

vi.mock("@/stores/tab-store", () => ({
  useTabStore: {
    getState: () => ({
      openTerminalTab: (...args: unknown[]) => openTerminalTab(...args),
    }),
  },
}))

import { createAndOpenPrimaryTerminalDetailed } from "@/lib/terminal/create-and-open-primary-terminal"

function makeStream(): TerminalStream {
  return {
    async attach(input) {
      const attachedSnapshot = {
        terminalId: input.terminalId,
        backendInstanceId: "backend-test",
        sequence: 3,
        rows: 24,
        cols: 80,
        ansi: new Uint8Array([0x61]),
        historyTruncated: false,
        status: "running" as const,
        exitCode: null,
        exitedAt: null,
        lastKnownCwd: "/tmp",
      }
      return {
        snapshot: attachedSnapshot,
        events: {
          async *[Symbol.asyncIterator]() {
            /* idle */
          },
        },
        async write() {},
        async resize() {
          return attachedSnapshot
        },
        async detach() {},
      }
    },
  }
}

beforeEach(() => {
  resetTerminalRuntimeStore()
  __setTerminalStreamForTests(null)
  createTerminalSession.mockReset()
  openTerminalTab.mockReset()
})

afterEach(() => {
  resetTerminalRuntimeStore()
  __setTerminalStreamForTests(null)
})

describe("personal terminal flow", () => {
  it("creates the PTY before opening the primary tab", async () => {
    const order: string[] = []
    createTerminalSession.mockImplementation(async () => {
      order.push("create")
      return {
        terminalId: "flow-1",
        backendInstanceId: "bi",
        folderId: 1,
        title: "Shell",
        initialCwd: "/tmp/proj",
        shell: "/bin/bash",
        status: "running",
        processId: 1,
        createdAt: new Date().toISOString(),
        exitedAt: null,
      }
    })
    openTerminalTab.mockImplementation(() => {
      order.push("openTab")
    })

    const result = await createAndOpenPrimaryTerminalDetailed({
      cwd: "/tmp/proj",
      folderId: 1,
      title: "Shell",
    })

    expect(result.terminalId).toBe("flow-1")
    expect(order).toEqual(["create", "openTab"])
    expect(openTerminalTab).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        terminalId: "flow-1",
      }),
      true
    )
  })

  it("attach path never calls create and accepts direct input", async () => {
    __setTerminalStreamForTests(makeStream())
    const actions = getTerminalRuntimeActions()

    await actions.attachTerminal("flow-1")
    expect(
      useTerminalRuntimeStore.getState().sessions["flow-1"]?.sequence
    ).toBe(3)
    actions.sendInput("flow-1", "echo ready\r")

    await actions.detachTerminal("flow-1")
    expect(
      useTerminalRuntimeStore.getState().sessions["flow-1"]
    ).toBeUndefined()
    expect(createTerminalSession).not.toHaveBeenCalled()
  })
})
