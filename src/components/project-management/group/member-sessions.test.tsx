import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import type { FolderDetail } from "@/lib/types"
import type { MemberRow } from "./group-model"
import { MemberSessions } from "./member-sessions"

const runtimeBridgeOperation = vi.hoisted(() => vi.fn())
vi.mock("@/lib/runtime-bridge", () => ({ runtimeBridgeOperation }))
const listProjectSessionOverview = vi.hoisted(() => vi.fn())
const resolveProjectAgentSession = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", () => ({
  listProjectSessionOverview,
  resolveProjectAgentSession,
}))
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({}),
}))
const openSession = vi.hoisted(() => vi.fn())
vi.mock("@/sessions/project/open-project-session", () => ({
  trimSlash: (path: string) => path.replace(/[\\/]+$/, ""),
  useOpenProjectSession: () => openSession,
}))

const row = (member: Partial<MemberRow["member"]>) =>
  ({
    member: {
      name: "dev",
      bodies: [],
      joined_seq: 1,
      joined_at: null,
      leftAt: null,
      ...member,
    },
  }) as MemberRow

function show(target: MemberRow) {
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <MemberSessions row={target} folderId={7} events={[]} />
    </NextIntlClientProvider>
  )
}

describe("MemberSessions", () => {
  it("lists the sessions of the member's Agent and marks the one it runs", async () => {
    const item = (patch: object) => ({
      cwd: "/repo",
      groupDir: "/repo",
      updatedAt: 1000,
      group: "main",
      groupName: "repo",
      origin: "berth",
      liveMember: null,
      ...patch,
    })
    listProjectSessionOverview.mockResolvedValue({
      hasMore: false,
      items: [
        item({
          agent: "claude",
          sessionId: "s1",
          title: "mine",
          liveMember: "dev",
        }),
        item({ agent: "codex", sessionId: "s2", title: "other agent" }),
        item({ agent: "claude", sessionId: "s3", title: "older" }),
      ],
    })
    show(
      row({
        bodies: [
          {
            target_ref: "r",
            agent: "claude",
            cwd: "/repo",
            collect: true,
            derived: false,
            joined_seq: 1,
            joined_at: null,
          },
        ],
      })
    )
    const mine = await screen.findByText("mine")
    expect(mine.parentElement).toHaveTextContent("Running")
    expect(screen.getByText("older")).toBeInTheDocument()
    expect(screen.queryByText("other agent")).toBeNull()
    fireEvent.click(mine)
    expect(openSession).toHaveBeenCalledWith({
      agent: "claude",
      sessionId: "s1",
      cwd: "/repo",
      title: "mine",
    })
  })

  it("shows today's trajectory of the member's sessions above the list", async () => {
    useAppWorkspaceStore.setState({
      allFolders: [
        { id: 7, path: "/repo", kind: "project", project: null },
      ] as unknown as FolderDetail[],
    })
    resolveProjectAgentSession.mockResolvedValue({
      deleted: false,
      sourceAvailable: true,
      conversation: null,
    })
    const item = (patch: object) => ({
      cwd: "/repo",
      groupDir: "/repo",
      updatedAt: Date.now(),
      group: "main",
      groupName: "repo",
      origin: "berth",
      liveMember: null,
      agent: "claude",
      ...patch,
    })
    listProjectSessionOverview.mockResolvedValue({
      hasMore: false,
      items: [
        item({ sessionId: "s1", title: "mine", liveMember: "dev" }),
        item({ sessionId: "s2", title: "someone else" }),
      ],
    })
    show(
      row({
        bodies: [
          {
            target_ref: "r",
            agent: "claude",
            cwd: "/repo",
            collect: true,
            derived: false,
            joined_seq: 1,
            joined_at: null,
          },
        ],
      })
    )
    await screen.findByText("mine")
    const trajectory = await vi.waitFor(() => {
      const element = document.querySelector("[data-member-trajectory]")
      if (!element) throw new Error("no trajectory yet")
      return element
    })
    // 只有这位成员在跑的那个会话成一条泳道。
    expect(trajectory).toHaveTextContent("mine")
    expect(trajectory).not.toHaveTextContent("someone else")
  })
})
