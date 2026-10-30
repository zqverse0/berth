import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { MemberRow } from "./group-model"
import { MemberSessions } from "./member-sessions"

const runtimeBridgeOperation = vi.hoisted(() => vi.fn())
vi.mock("@/lib/runtime-bridge", () => ({ runtimeBridgeOperation }))
const listProjectSessionOverview = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", () => ({ listProjectSessionOverview }))
const openBerthSessionTab = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ openBerthSessionTab }),
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
  it("lists Berth's sessions with the current one marked and opens one as a tab", async () => {
    runtimeBridgeOperation.mockResolvedValue({
      ok: true,
      result: [
        { name: "20261030-090000", title: "what changed?", updatedAt: 2000 },
        { name: "20261029-100000", title: null, updatedAt: 1000 },
      ],
    })
    show(row({ name: "berth", builtin: true }))
    const current = await screen.findByText("what changed?")
    expect(current.parentElement).toHaveTextContent("Current")
    fireEvent.click(current)
    expect(openBerthSessionTab).toHaveBeenCalledWith({
      folderId: 7,
      session: "20261030-090000",
      title: "Berth · what changed?",
    })
  })

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
})
