import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { useGroupWorkspaceStore } from "@/stores/group-workspace-store"
import { useStatusBarLaunchStore } from "@/stores/agent-launch-store"

const mocks = vi.hoisted(() => ({
  listGroups: vi.fn(),
  readGroup: vi.fn(),
  jump: vi.fn(),
  moveWorkspaceTab: vi.fn(),
  panes: [] as unknown[],
  events: [] as unknown[],
  delivery: {} as Record<string, string>,
  members: [] as unknown[],
  showHome: vi.fn(),
  refresh: vi.fn(),
  settings: vi.fn(),
  configs: [] as unknown[],
  agents: [] as unknown[],
  experts: [] as unknown[],
}))
// 交接另有实现与测试；这里只看专家栏。
vi.mock("../group/acp-handoff", () => ({ handoffAcpMember: vi.fn() }))
vi.mock("@/components/layout/sidebar/agent-launch", () => ({
  // 设置区只看它收到的专家与提交：启动栏本身另有测试。
  AgentLaunchShelfContent: ({
    expert,
    launch,
  }: {
    expert?: string
    launch?: (choice: unknown) => Promise<void>
  }) => (
    <button
      type="button"
      data-launch-expert={expert}
      onClick={() =>
        void launch?.({
          agentLaunchInputs: { expert },
          providerId: 3,
          modelId: "m",
        })
      }
    >
      join
    </button>
  ),
}))
vi.mock("../group/expert-editor", () => ({
  useExperts: () => ({ catalog: { experts: mocks.experts } }),
  useExpertCatalog: (select: (state: unknown) => unknown) =>
    select({ catalog: { experts: mocks.experts } }),
  ExpertCreateForm: () => null,
}))
// 群页另有测试；这里只要群列表。
vi.mock("../group/group-switcher", () => ({
  GroupList: () => <p>group list</p>,
  useChatGroupList: () => [
    { name: "main", title: null, cwd: "/repo/group-dir", members: [] },
  ],
  useChatGroups: { getState: () => ({ reload: vi.fn() }) },
}))
vi.mock("@/lib/workspace/project-home", () => ({
  showProjectHome: () => mocks.showHome(),
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
  listExpertConfigs: () =>
    Promise.resolve({ ok: true, result: { experts: mocks.configs } }),
  setExpertConfig: (...args: unknown[]) => mocks.settings(...args),
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
      allFolders: [{ id: 7, path: "/repo/berth-dev", name: "berth-dev" }],
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
      refresh: mocks.refresh,
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
  useAgentProfiles: () => ({ agents: mocks.agents }),
}))
import { GroupMembersPanel } from "./group-members-panel"
import { ChatSettings } from "../group/expert-settings"
import { SidebarHeader } from "@/components/layout/sidebar/sidebar-header"

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SidebarHeader title="Group" />
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
  mocks.showHome.mockReset()
  mocks.settings.mockReset().mockResolvedValue({ ok: true, result: {} })
  mocks.configs = []
  mocks.agents = [{ id: "tool", name: "Test Agent" }]
  mocks.experts = []
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
  it("lists every expert with the agent and model it uses", async () => {
    mocks.experts = [
      { id: "agent-1", expert: { name: "Front" } },
      { id: "dev", expert: { name: "Dev" } },
      { id: "writer", expert: { name: "Writer" } },
    ]
    mocks.configs = [
      {
        id: "dev",
        name: "Dev",
        config: { agent: "tool", inputs: {}, provider: 3, model: "m" },
      },
      { id: "writer", name: "Writer", config: null },
    ]
    mocks.members = [{ ...(mocks.members[0] as object), expertName: "Front" }]
    renderPanel()
    // 不在群里的专家也列出：配了的显示 Agent · 模型，没配的提示选 Agent。
    expect(await screen.findByText("Test Agent · m")).toBeVisible()
    expect(screen.getByText("Dev")).toBeVisible()
    // agent-1 在群里但也还没配。
    expect(screen.getAllByText("No agent chosen")).toHaveLength(2)
    expect(
      [...document.querySelectorAll("[data-member]")].map((row) =>
        row.getAttribute("data-member")
      )
    ).toEqual(["agent-1", "dev", "writer"])
    // 点不在群里的专家：首页与它单聊（发消息时后端让它入群）。
    fireEvent.click(screen.getByText("Writer"))
    expect(useGroupWorkspaceStore.getState().focusedMember).toBe("writer")
  })

  it("saves an expert's agent and model from the chat's settings", async () => {
    mocks.agents = [
      { id: "tool", name: "Test Agent", acp: true },
      { id: "other", name: "Other", acp: true },
    ]
    mocks.experts = [{ id: "dev", expert: { name: "Dev" } }]
    mocks.configs = [
      {
        id: "dev",
        name: "Dev",
        config: { agent: "tool", inputs: {}, provider: 1, model: "a" },
      },
    ]
    renderPanel()
    await screen.findByText("Test Agent · a")
    // 侧栏行不再展开设置，挪到了单聊顶栏。
    expect(document.querySelector("[data-member-sessions-toggle]")).toBeNull()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChatSettings
          folderId={7}
          expert="dev"
          row={null}
          events={[]}
          onSaved={vi.fn()}
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(document.querySelector("[data-chat-settings]")!)
    // 缺省现在用的 Agent；换了提示开新会话。不在这份对话里没有会话列表。
    const select = document.querySelector<HTMLSelectElement>(
      "[data-expert-settings-agent]"
    )!
    expect(select.value).toBe("tool")
    expect(screen.queryByText("sessions of dev")).toBeNull()
    fireEvent.change(select, { target: { value: "other" } })
    expect(screen.getByText(/starts a new session/)).toBeVisible()
    fireEvent.click(document.querySelector("[data-launch-expert='dev']")!)
    await vi.waitFor(() =>
      expect(mocks.settings).toHaveBeenCalledWith(7, "dev", "other", {
        inputs: { expert: "dev" },
        provider: 3,
        model: "m",
      })
    )
  })

  it("opens a private chat as a terminal with the expert in the group's directory", async () => {
    mocks.experts = [{ id: "agent-1", expert: { name: "Front" } }]
    mocks.members[0] = { ...(mocks.members[0] as object), expertName: "Front" }
    renderPanel()
    fireEvent.pointerDown(
      document.querySelector("[data-member-menu='agent-1']")!,
      { button: 0, ctrlKey: false }
    )
    fireEvent.click(await screen.findByText("Chat in a terminal"))
    const shelf = useStatusBarLaunchStore.getState()
    expect(shelf.activeLaunchAgentId).toBe("tool")
    expect(shelf.launchPreset).toEqual({
      expert: "agent-1",
      folderId: 7,
      workingDirectory: "/repo/group-dir",
    })
  })

  it("shows the delegation a member is working on under its name", () => {
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
    // 已完成的委托不显示，进行中的写在成员名下。
    const card = document.querySelector("[data-member='agent-1']")!
    expect(card).toHaveTextContent("↳ do S1")
    expect(card).not.toHaveTextContent("done one")
  })
  it("shows members that are not experts after the experts", async () => {
    renderPanel()
    expect(await screen.findByText("Frontend")).toBeVisible()
    expect(screen.getByText("#agent-1")).toBeVisible()
    // 成员名不是专家 id（spawn 的 worker、旧成员）：只显示它在用的 Agent。
    expect(screen.getByText("Test Agent")).toBeVisible()
    expect(screen.queryByText("other")).not.toBeInTheDocument()
    expect(mocks.listGroups).not.toHaveBeenCalled()
    // 点成员：首页切到与它单聊。
    fireEvent.click(screen.getByText("Frontend"))
    expect(useGroupWorkspaceStore.getState().focusedMember).toBe("agent-1")
    expect(mocks.showHome).toHaveBeenCalledTimes(1)
  })
  it("lists a member's sessions in the chat's settings", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChatSettings
          folderId={7}
          expert={null}
          row={{
            member: mocks.members[0] as never,
            pane: null,
            status: "idle",
            unread: false,
            lastActivity: null,
          }}
          events={[]}
          onSaved={vi.fn()}
        />
      </NextIntlClientProvider>
    )
    expect(screen.queryByText("sessions of agent-1")).toBeNull()
    fireEvent.click(document.querySelector("[data-chat-settings]")!)
    expect(screen.getByText("sessions of agent-1")).toBeVisible()
  })
  it("loads checkout members without selecting or opening a group", () => {
    useGroupWorkspaceStore.setState({ folderId: null, group: null })
    renderPanel()
    expect(screen.getByText("Frontend")).toBeVisible()
    expect(
      screen.queryByText("Open a group from Tasks to view its Agent members.")
    ).not.toBeInTheDocument()
    expect(mocks.readGroup).toHaveBeenCalledWith(7, true)
    expect(mocks.showHome).not.toHaveBeenCalled()
  })
  it("ignores a stale selection from another folder", () => {
    useGroupWorkspaceStore.setState({ folderId: 8, group: "other" })
    renderPanel()
    expect(screen.getByText("Frontend")).toBeVisible()
    expect(mocks.readGroup).toHaveBeenCalledWith(7, true)
  })
  it("jumps to the terminal its session was handed to", async () => {
    mocks.members = [{ ...(mocks.members[0] as object), handedTo: "t1" }]
    renderPanel()
    await screen.findByText("Frontend")
    fireEvent.click(
      screen.getByRole("button", { name: "Jump to its terminal" })
    )
    expect(mocks.jump).toHaveBeenCalledTimes(1)
    expect(useGroupWorkspaceStore.getState().previewTabId).toBe("terminal:t1")
  })
  it("hides members that left without deleting their linked history", () => {
    mocks.members = [{ ...(mocks.members[0] as object), leftAt: 5_000 }]
    mocks.events = [{ author: "agent-1", session_id: "native-1" }]
    renderPanel()
    expect(screen.queryByText("Frontend")).not.toBeInTheDocument()
    expect(mocks.events).toHaveLength(1)
  })
  it("searches existing members", () => {
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
    expect(mocks.jump).not.toHaveBeenCalled()
  })
  it("lists groups and experts in one column without idle status or lead", () => {
    mocks.members = [{ ...(mocks.members[0] as object), busy: true }]
    renderPanel()
    expect(document.querySelector("[data-member-lead]")).toBeNull()
    expect(document.querySelector('[data-member-action="lead"]')).toBeNull()
    expect(screen.queryAllByRole("tab")).toHaveLength(0)
    expect(screen.getByText("group list")).toBeVisible()
    expect(screen.getByRole("button", { name: /Experts/ })).toBeVisible()
    // 空闲的专家不显示状态。
    expect(screen.queryByText("Idle")).toBeNull()
  })
})
