import { useAppUiStore } from "@/stores/app-ui-store"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { useGroupWorkspaceStore } from "@/stores/group-workspace-store"

const mocks = vi.hoisted(() => ({
  listGroups: vi.fn(),
  readGroup: vi.fn(),
  jump: vi.fn(),
  moveWorkspaceTab: vi.fn(),
  panes: [] as unknown[],
  events: [] as unknown[],
  delivery: {} as Record<string, string>,
  members: [] as unknown[],
}))
// 成员的会话列表另有测试；这里只看成员栏。
vi.mock("../group/member-sessions", () => ({
  MemberSessions: ({ row }: { row: { member: { name: string } } }) => (
    <p>sessions of {row.member.name}</p>
  ),
}))
vi.mock("@/lib/agent/berth-group", async (original) => ({
  ...(await original<object>()),
  listGroups: (...args: unknown[]) => mocks.listGroups(...args),
}))
// 只需要 trimSlash；真模块会连带加载整个 workspace-runtime
vi.mock("@/sessions/project/open-project-session", () => ({
  trimSlash: (path: string) => path.replace(/[\\/]+$/, ""),
  folderIdFor: vi.fn(),
  useOpenProjectSession: () => vi.fn(),
}))
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({}),
}))
vi.mock("@/components/project-management/group/pane-actions", () => ({
  usePaneActions: () => ({ jump: mocks.jump }),
}))
vi.mock("@/lib/terminal/agent-panes", () => ({
  useAllAgentPanes: () => mocks.panes,
  useAgentPaneStore: (select: (state: unknown) => unknown) =>
    select({ seen: {} }),
}))
vi.mock("@/stores/workspace-layout-store", () => ({
  useWorkspaceLayoutStore: {
    getState: () => ({
      moveWorkspaceTab: mocks.moveWorkspaceTab,
      activeTabByPane: { conversation: null },
    }),
  },
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (select: (state: unknown) => unknown) =>
    select({
      allFolders: [{ id: 7, path: "/repo/berth-dev", parent_id: null }],
    }),
}))
vi.mock("@/components/project-management/group/use-task-group", () => ({
  useTaskGroup: (...args: unknown[]) => {
    mocks.readGroup(...args)
    return {
      name: "main",
      env: { worktree: "/repo/berth-dev" },
      loaded: true,
      error: null,
      events: mocks.events,
      delivery: mocks.delivery,
      members: mocks.members,
    }
  },
}))

vi.mock("@/lib/transport/launchbar", () => ({
  launchbar: () =>
    Promise.resolve({
      type: "file",
      file: {
        agent: "tool",
        diagnostics: [],
        config: { version: 1, items: [] },
      },
    }),
}))
vi.mock("@/hooks/use-agent-profiles", async (original) => ({
  ...(await original<object>()),
  useAgentProfiles: () => ({ agents: [{ id: "tool", name: "Test Agent" }] }),
}))
import { GroupMembersPanel } from "./group-members-panel"

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <GroupMembersPanel folderId={7} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  mocks.listGroups.mockResolvedValue({
    ok: true,
    result: { groups: ["main", "other"] },
  })
  mocks.readGroup.mockReset()
  mocks.jump.mockReset().mockReturnValue("terminal:t1")
  useAppUiStore.setState({ auxView: "terminals" })
  mocks.panes = [
    {
      descriptor: { terminalId: "t1", targetRef: "pane-ref" },
      state: "working",
      since: 0,
    },
  ]
  mocks.events = []
  mocks.members = [
    {
      name: "agent-1",
      label: "Frontend",
      bodies: [{ target_ref: "pane-ref", agent: "tool" }],
      leftAt: null,
      joined_seq: 1,
    },
  ]
  mocks.delivery = {}
  useGroupWorkspaceStore.setState({
    folderId: 7,
    group: "main",
    previewTabId: null,
    emptyMember: null,
    focusedMember: null,
  })
})

describe("GroupMembersPanel", () => {
  it("lists delegations in progress", () => {
    const at = { timestamp_ms: 1_000 }
    mocks.events = [
      { ...at, seq: 1, kind: "joined", author: "agent-1" },
      {
        ...at,
        seq: 2,
        kind: "message",
        author: "user",
        to: "agent-1",
        text: "done one",
      },
      {
        ...at,
        seq: 3,
        kind: "message",
        author: "user",
        to: "agent-1",
        text: "do S1",
      },
      {
        ...at,
        seq: 4,
        kind: "message",
        author: "agent-1",
        to: "user",
        source: "transcript",
        reply_to: 2,
      },
      {
        ...at,
        seq: 5,
        kind: "system",
        event: "commits",
        commits: ["abc1234 feat: x"],
        head: "abc1234",
      },
    ]
    mocks.delivery = { 2: "delivered", 3: "delivered" }
    renderPanel()
    // 已完成的委托不列，进行中的点开看收件人的相关消息。
    const rows = document.querySelectorAll("[data-active-delegation]")
    expect(
      [...rows].map((row) => row.getAttribute("data-active-delegation"))
    ).toEqual(["3"])
    fireEvent.click(rows[0])
    expect(useGroupWorkspaceStore.getState().focusedMember).toBe("agent-1")
  })
  it("shows the current checkout members, not group navigation", async () => {
    renderPanel()
    expect(await screen.findByText("Frontend")).toBeVisible()
    expect(screen.getByText("#agent-1")).toBeVisible()
    expect(screen.getByText(/^Test Agent ·/)).toBeVisible()
    expect(screen.queryByText("other")).not.toBeInTheDocument()
    expect(mocks.listGroups).not.toHaveBeenCalled()
    // 点成员：切到辅助面板的群组并只看它的消息。
    fireEvent.click(screen.getByText("Frontend"))
    expect(useGroupWorkspaceStore.getState().focusedMember).toBe("agent-1")
    expect(useAppUiStore.getState().auxView).toBe("group")
  })
  it("expands a member card into its sessions", async () => {
    renderPanel()
    await screen.findByText("Frontend")
    expect(screen.queryByText("sessions of agent-1")).toBeNull()
    fireEvent.click(
      document.querySelector('[data-member-sessions-toggle="agent-1"]')!
    )
    expect(screen.getByText("sessions of agent-1")).toBeVisible()
  })
  it("loads checkout members without selecting or opening a group", () => {
    useGroupWorkspaceStore.setState({ folderId: null, group: null })
    renderPanel()
    expect(screen.getByText("Frontend")).toBeVisible()
    expect(screen.getByText("berth-dev")).toBeVisible()
    expect(
      screen.queryByText("Open a group from Tasks to view its Agent members.")
    ).not.toBeInTheDocument()
    expect(mocks.readGroup).toHaveBeenCalledWith(7, true)
    expect(useAppUiStore.getState().auxView).toBe("terminals")
  })
  it("ignores a stale selection from another folder", () => {
    useGroupWorkspaceStore.setState({ folderId: 8, group: "other" })
    renderPanel()
    expect(screen.getByText("Frontend")).toBeVisible()
    expect(mocks.readGroup).toHaveBeenCalledWith(7, true)
  })
  it("prefers the running terminal", async () => {
    mocks.panes = [
      {
        descriptor: { terminalId: "t1", targetRef: "pane-ref" },
        state: "working",
        since: 0,
      },
    ]
    renderPanel()
    await screen.findByText("Frontend")
    fireEvent.click(
      screen.getByRole("button", { name: "Jump to its terminal" })
    )
    expect(mocks.jump).toHaveBeenCalledTimes(1)
    expect(useGroupWorkspaceStore.getState().previewTabId).toBe("terminal:t1")
  })
  it("hides offline members without deleting their linked history", () => {
    mocks.panes = []
    mocks.events = [{ author: "agent-1", session_id: "native-1" }]
    renderPanel()
    expect(screen.queryByText("Frontend")).not.toBeInTheDocument()
    expect(mocks.events).toHaveLength(1)
  })
  it("hides exited members immediately, before the watcher records their departure", () => {
    mocks.panes = [
      {
        descriptor: { terminalId: "t1", targetRef: "pane-ref" },
        state: "exited",
        since: 0,
      },
    ]
    renderPanel()
    expect(screen.queryByText("Frontend")).not.toBeInTheDocument()
  })
  it("searches existing members and clears the message filter with All messages", () => {
    // 在群成员多于 3 个才显示搜索框。
    mocks.members = [
      ...mocks.members,
      ...[2, 3, 4].map((n) => ({
        name: `agent-${n}`,
        bodies: [{ target_ref: `ref-${n}`, agent: "tool" }],
        leftAt: null,
        joined_seq: n,
      })),
    ]
    mocks.panes = [
      ...mocks.panes,
      ...[2, 3, 4].map((n) => ({
        descriptor: { terminalId: `t${n}`, targetRef: `ref-${n}` },
        state: "idle",
        since: 0,
      })),
    ]
    useGroupWorkspaceStore.setState({ focusedMember: "agent-1" })
    renderPanel()
    expect(screen.getAllByTitle("Show only its messages")[0]).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    const input = screen.getByRole("textbox", { name: "Search Agents…" })
    fireEvent.change(input, { target: { value: "missing" } })
    expect(screen.queryByText("Frontend")).toBeNull()
    expect(screen.getByText("No matching Agents")).toBeVisible()
    fireEvent.change(input, { target: { value: "agent-1" } })
    expect(screen.getByText("Frontend")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "All messages" }))
    expect(useGroupWorkspaceStore.getState().focusedMember).toBeNull()
    expect(mocks.jump).not.toHaveBeenCalled()
  })
})
