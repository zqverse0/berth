import { describe, expect, it } from "vitest"
import type { AgentPaneRow } from "@/lib/terminal/agent-panes"
import { deviceFolderId } from "@/lib/transport/device"
import type { TerminalDescriptor } from "@/lib/types"
import {
  buildSidebarSessions,
  sessionTitle,
  switcherOrder,
} from "./sidebar-sessions"

function d(
  id: string,
  folderId: number | null,
  extra: Partial<TerminalDescriptor> = {}
): TerminalDescriptor {
  return {
    terminalId: id,
    backendInstanceId: "b",
    folderId,
    title: "",
    initialCwd: folderId == null ? "/tmp/x" : `/p/${folderId}`,
    shell: "/bin/bash",
    status: "running",
    processId: 1,
    createdAt: "",
    exitedAt: null,
    ...extra,
  }
}

function pane(
  descriptor: TerminalDescriptor,
  state: AgentPaneRow["state"]
): AgentPaneRow {
  return { descriptor, state, since: 1 }
}

describe("sessionTitle", () => {
  it("prefers the terminal title, then tab title, command, directory", () => {
    const desc = d("t", 1, { cwd: "/p/1/src", foregroundCommand: "bash" })
    expect(
      sessionTitle("Pi · barrier", { ...desc, title: "重构 transport" })
    ).toBe("重构 transport")
    expect(sessionTitle(" Pi · barrier ", desc)).toBe("Pi · barrier")
    // 前台就是 shell 本身时不算命令
    expect(sessionTitle(null, desc)).toBe("src")
    expect(sessionTitle(null, { ...desc, foregroundCommand: "pnpm" })).toBe(
      "pnpm"
    )
    expect(sessionTitle(null, null)).toBe("Terminal")
  })
})

describe("buildSidebarSessions", () => {
  const folders = [
    { id: 1, path: "/p/1" },
    { id: 2, path: "/p/1/wt" },
    { id: deviceFolderId(3, 7), path: "/remote" },
  ]

  it("one row per session, placed in the deepest project, with status", () => {
    const agent = d("a", 1, { agentId: "claude", cwd: "/p/1/wt/src" })
    const remote = d("r", deviceFolderId(3, 7), { agentId: "x" })
    const sessions = buildSidebarSessions({
      tabs: [
        { id: "tab-a", kind: "terminal", folderId: 1, terminalId: "a" },
        { id: "conv", kind: "conversation", folderId: 1, title: "对话" },
      ],
      panes: [pane(agent, "attention"), pane(remote, "working")],
      inventory: [d("gone", 1, { status: "exited" })],
      folders,
      seen: {},
      detachedDevice: () => 0,
    })
    expect(
      sessions.map((s) => [s.id, s.device, s.folderId, s.dot, s.tabId])
    ).toEqual([
      ["tab-a", 0, 2, "attention", "tab-a"],
      ["terminal:r", 3, deviceFolderId(3, 7), "working", null],
      ["conv", 0, 1, null, "conv"],
    ])
  })

  it("seen attention and plain shells show no dot", () => {
    const [agent, shell] = buildSidebarSessions({
      tabs: [],
      panes: [
        pane(d("a", 1, { agentId: "x" }), "attention"),
        pane(d("s", 1), "working"),
      ],
      inventory: [],
      folders,
      seen: { a: 1 },
      detachedDevice: () => 0,
    })
    expect([agent.dot, shell.dot]).toEqual([null, null])
  })

  it("terminals of removed projects are unassigned, not guessed by cwd", () => {
    const [stale, home] = buildSidebarSessions({
      tabs: [],
      panes: [],
      inventory: [
        d("stale", 99, { initialCwd: "/p/1/sub" }),
        d("ssh", null, { initialCwd: "/data/remote/4" }),
      ],
      folders,
      seen: {},
      detachedDevice: (desc) => (desc.initialCwd === "/data/remote/4" ? 4 : 0),
    })
    expect([stale.folderId, stale.device]).toEqual([null, 0])
    expect([home.folderId, home.device]).toEqual([null, 4])
    expect(home.descriptor?.terminalId).toBe("ssh")
  })
})

describe("switcherOrder", () => {
  it("puts the previously used session first, then running ones, current last", () => {
    const s = (
      tabId: string | null,
      dot: "attention" | "working" | null = null
    ) => ({
      tabId,
      dot,
    })
    const order = switcherOrder(
      [s("idle"), s("cur"), s(null, "working"), s("prev"), s("older")],
      ["cur", "prev", "older"],
      "cur"
    )
    expect(order.map((x) => x.tabId)).toEqual([
      "prev",
      "older",
      null,
      "idle",
      "cur",
    ])
  })
})
