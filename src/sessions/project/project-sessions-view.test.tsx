import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { ProjectSessionsView } from "./project-sessions-view"

const listProjectSessionOverview = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", () => ({ listProjectSessionOverview }))
const runtimeBridgeOperation = vi.hoisted(() => vi.fn())
vi.mock("@/lib/runtime-bridge", () => ({ runtimeBridgeOperation }))
const openBerthSessionTab = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ openBerthSessionTab }),
}))
const openSession = vi.hoisted(() => vi.fn())
vi.mock("@/sessions/project/open-project-session", () => ({
  trimSlash: (path: string) => path.replace(/[\\/]+$/, ""),
  folderIdFor: vi.fn(),
  useOpenProjectSession: () => openSession,
}))
vi.mock("@/hooks/use-agent-profiles", () => ({
  useAgentProfiles: () => ({
    agents: [{ id: "claude", name: "Claude Code", projectType: "claude" }],
  }),
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (select: (state: unknown) => unknown) =>
    select({ allFolders: [{ id: 7, path: "/repo" }] }),
}))
vi.mock("@/lib/terminal/agent-panes", () => ({ useAllAgentPanes: () => [] }))
vi.mock("@/components/layout/aux-panel/aux-panel-session-details-tab", () => ({
  SessionDetailsTab: () => null,
  useFocusedSessionTitle: () => null,
}))
vi.mock("@/components/agents/profile/agent-profile-icon", () => ({
  AgentProfileIcon: () => <span />,
}))
vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => <span /> }))
vi.mock("@/stores/tab-store", () => ({ useTabStore: { getState: vi.fn() } }))

describe("ProjectSessionsView", () => {
  it("lists every Agent's sessions with Berth's merged in, filterable by Agent", async () => {
    listProjectSessionOverview.mockResolvedValue({
      hasMore: false,
      items: [
        {
          agent: "claude",
          sessionId: "s1",
          cwd: "/repo",
          updatedAt: 1000,
          title: "claude work",
          group: "main",
          groupName: "repo",
          groupDir: "/repo",
          origin: "berth",
          liveMember: null,
        },
      ],
    })
    runtimeBridgeOperation.mockResolvedValue({
      ok: true,
      result: [
        { name: "20261030-090000", title: "ask berth", updatedAt: 2000 },
      ],
    })
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <ProjectSessionsView folderId={7} active />
      </NextIntlClientProvider>
    )
    const berth = await screen.findByText("ask berth")
    expect(screen.getByText("claude work")).toBeInTheDocument()
    // 新的在前：Berth 的会话更新。
    const titles = [...document.querySelectorAll("[data-session]")].map((row) =>
      row.getAttribute("data-session")
    )
    expect(titles).toEqual(["20261030-090000", "s1"])

    fireEvent.change(screen.getByRole("combobox", { name: "Agent" }), {
      target: { value: "berth" },
    })
    expect(screen.queryByText("claude work")).toBeNull()
    fireEvent.click(berth)
    expect(openBerthSessionTab).toHaveBeenCalledWith({
      folderId: 7,
      session: "20261030-090000",
      title: "Berth · ask berth",
    })
  })
})
