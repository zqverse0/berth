import { useGroupWorkspaceStore } from "@/stores/group-workspace-store"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"

const listBerthTaskViews = vi.fn()
const assignTask = vi.fn()
const getTaskView = vi.fn()
const readTaskGroup = vi.fn()
const startTask = vi.fn()
const postToMember = vi.fn()
const ensureGroupWatch = vi.fn()
const finishTask = vi.fn()
const terminateTerminalSession = vi.fn()
const requestAgentLaunch = vi.fn()
const setActiveFolderId = vi.fn()
const refreshProjectMembers = vi.fn()
const jump = vi.fn()
const openTaskTab = vi.fn()
const closeFileTab = vi.fn()
const activateFolderWorkspace = vi.fn()
const selectWorkspaceTab = vi.fn()

const folders = [
  { id: 7, path: "/repo" },
  { id: 8, path: "/repo-demo" },
]

vi.mock("@/lib/agent/berth-tasks", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listBerthTaskViews: (...args: unknown[]) => listBerthTaskViews(...args),
  getTaskView: (...args: unknown[]) => getTaskView(...args),
}))
vi.mock("@/lib/agent/berth-group", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assignTask: (...args: unknown[]) => assignTask(...args),
  readTaskGroup: (...args: unknown[]) => readTaskGroup(...args),
  startTask: (...args: unknown[]) => startTask(...args),
  postToMember: (...args: unknown[]) => postToMember(...args),
  ensureGroupWatch: (...args: unknown[]) => ensureGroupWatch(...args),
  finishTask: (...args: unknown[]) => finishTask(...args),
  listExpertConfigs: () =>
    Promise.resolve({
      ok: true,
      result: {
        experts: [
          {
            id: "dev",
            name: "Dev",
            config: {
              agent: "claude",
              inputs: {},
              provider: null,
              model: null,
            },
          },
        ],
      },
    }),
  openExpertDm: (_folderId: number, expert: string) =>
    Promise.resolve({ ok: true, result: { name: `dm-${expert}` } }),
}))
vi.mock("@/lib/api", () => ({
  terminateTerminalSession: (...args: unknown[]) =>
    terminateTerminalSession(...args),
  listModelProviders: () => Promise.resolve([]),
}))
vi.mock("@/lib/terminal/agent-panes", () => ({
  useAllAgentPanes: () => [
    {
      descriptor: { terminalId: "t2", targetRef: "ref-2" },
      state: "idle",
      since: 5_000,
    },
    {
      descriptor: { terminalId: "t1", targetRef: "ref-1" },
      state: "attention",
      since: 5_000,
    },
  ],
  useAgentPaneStore: (select: (state: { seen: object }) => unknown) =>
    select({ seen: {} }),
  onAgentChanged: () => () => {},
}))
vi.mock("@/components/project-management/group/pane-actions", () => ({
  usePaneActions: () => ({ jump, interrupt: vi.fn() }),
}))
vi.mock("@/hooks/use-agent-profiles", () => ({
  useAgentProfiles: () => ({ agents: [{ id: "claude", name: "Claude Code" }] }),
}))
// 只需要 trimSlash；真模块会连带加载整个 workspace-runtime
vi.mock("@/sessions/project/open-project-session", () => ({
  trimSlash: (path: string) => path.replace(/[\\/]+$/, ""),
  folderIdFor: vi.fn(),
  useOpenProjectSession: () => vi.fn(),
}))
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({
    openFilePreview: vi.fn(),
    openCommitDiff: vi.fn(),
    openTaskTab,
    closeFileTab,
  }),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = () => ({
    allFolders: folders,
    // 正看着任务的 worktree 项目：收尾后应回到主项目。
    activeFolderId: 8,
    setActiveFolderId,
    refreshProjectMembers,
  })
  const useAppWorkspaceStore = (
    select: (s: ReturnType<typeof state>) => unknown
  ) => select(state())
  useAppWorkspaceStore.getState = state
  return { useAppWorkspaceStore }
})
vi.mock("@/stores/tab-store", () => ({
  useTabStore: { getState: () => ({ activateFolderWorkspace }) },
}))
vi.mock("@/stores/workspace-layout-store", () => ({
  useWorkspaceLayoutStore: {
    getState: () => ({
      selectWorkspaceTab,
      activeTabByPane: { conversation: null },
    }),
  },
}))
vi.mock("@/stores/agent-launch-store", () => ({
  requestAgentLaunch: (...args: unknown[]) => requestAgentLaunch(...args),
}))
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <pre>{children}</pre>
  ),
}))
vi.mock("@/components/agents/profile/agent-profile-icon", () => ({
  AgentProfileIcon: () => <span />,
}))
vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => <span /> }))

import { useExpertCatalog } from "@/components/project-management/group/expert-editor"
import { GroupPanel } from "./group-panel"

function view(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    result: {
      taskDirName: "10-01-demo",
      title: "Ship it",
      priority: "P0",
      state: "running",
      prd: "/repo/.berth/tasks/10-01-demo/prd.md",
      prdText: "# PRD body",
      branch: "demo",
      baseBranch: "dev",
      worktree: "/repo-demo",
      dirtyFiles: 2,
      behind: 3,
      diffstat: " 1 file changed, 1 insertion(+)",
      acceptance: { done: 1, total: 2, items: [] },
      steps: [
        {
          text: "S1 do it",
          checked: false,
          id: "S1",
          state: "committed",
          commit: null,
        },
      ],
      currentStep: null,
      commits: [{ hash: "abc1234", subject: "feat: x", step: "S1" }],
      unlinkedCommits: 0,
      ...extra,
    },
  }
}

const body = (ref: string) => ({
  target_ref: ref,
  agent: "claude",
  cwd: "/repo-demo",
  collect: true,
  derived: true,
  joined_seq: 2,
  joined_at: 2_000,
})

const member = {
  name: "claude-1",
  bodies: [body("ref-1")],
  joined_seq: 2,
  joined_at: 2_000,
  leftAt: null,
}

function group(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    result: {
      name: "10-01-demo",
      nextAfter: 4,
      members: [member],
      delivery: { "3": "queued" },
      events: [
        {
          schema_version: 1,
          seq: 1,
          timestamp_ms: 1_000,
          kind: "system",
          event: "started",
          author: "berth",
          branch: "demo",
          base: "dev",
        },
        {
          schema_version: 1,
          seq: 2,
          timestamp_ms: 2_000,
          kind: "joined",
          author: "claude-1",
        },
        {
          schema_version: 1,
          seq: 3,
          timestamp_ms: 3_000,
          kind: "message",
          author: "user",
          to: "claude-1",
          text: "please do S1",
        },
        {
          schema_version: 1,
          seq: 4,
          timestamp_ms: 4_000,
          kind: "message",
          author: "claude-1",
          to: "user",
          source: "transcript",
          text: "S1 done",
          digest: "S1 done\n\n新提交：\nabc1234 feat: x",
          commits: ["abc1234 feat: x"],
          diffstat: "1 file changed",
        },
      ],
      ...extra,
    },
  }
}

function renderDetail(folderId = 7) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <GroupPanel folderId={folderId} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  useGroupWorkspaceStore.setState({
    folderId: null,
    group: null,
    focusedMember: null,
  })
  for (const mock of [
    getTaskView,
    listBerthTaskViews,
    assignTask,
    readTaskGroup,
    startTask,
    postToMember,
    ensureGroupWatch,
    requestAgentLaunch,
    setActiveFolderId,
    refreshProjectMembers,
    finishTask,
    terminateTerminalSession,
    jump,
    openTaskTab,
    closeFileTab,
    activateFolderWorkspace,
    selectWorkspaceTab,
  ]) {
    mock.mockReset()
  }
  listBerthTaskViews.mockResolvedValue({
    ok: true,
    result: {
      tasks: [
        { ...view().result, group: "10-01-demo" },
        {
          ...view().result,
          taskDirName: "other",
          title: "Other",
          group: "main",
          branch: null,
          worktree: null,
          state: "planning",
        },
      ],
    },
  })
  ensureGroupWatch.mockResolvedValue({ ok: true, result: { running: true } })
  terminateTerminalSession.mockResolvedValue(undefined)
})

describe("GroupPanel", () => {
  it("opens on the group chat and says unaddressed messages are only recorded", async () => {
    listBerthTaskViews.mockResolvedValue({ ok: true, result: { tasks: [] } })
    readTaskGroup.mockResolvedValue(group())
    renderDetail()
    await waitFor(() =>
      expect(readTaskGroup).toHaveBeenCalledWith(7, 0, undefined, "main")
    )
    // 首页就是群聊：没有成员条，输入框提示不指定收件人只记录。
    expect(await screen.findByText("please do S1")).toBeVisible()
    expect(document.querySelector("[data-group-chats]")).toBeNull()
    expect(
      screen.getByPlaceholderText(/^Type @ to pick who answers/)
    ).toBeVisible()
  })
  it("shows the group timeline with delivery state, members and its tasks", async () => {
    getTaskView.mockResolvedValue(view())
    readTaskGroup.mockResolvedValue(group())
    renderDetail()
    await openChat("all")
    expect(await screen.findByText("please do S1")).toBeVisible()
    expect(screen.getAllByText("Queued").length).toBeGreaterThan(0)
    expect(screen.getByText("S1 done")).toBeVisible()
    expect(document.querySelector('[data-member="claude-1"]')).toBeNull()
    expect(screen.getAllByText("feat: x").length).toBeGreaterThan(0)
    await waitFor(() => expect(ensureGroupWatch).toHaveBeenCalledWith(7))
  })

  /** 侧栏选成员：「all」是群聊，成员名是单聊，收件人跟随当前会话。 */
  async function openChat(member: string) {
    await waitFor(() =>
      expect(useGroupWorkspaceStore.getState().group).not.toBeNull()
    )
    act(() =>
      useGroupWorkspaceStore
        .getState()
        .setFocusedMember(member === "all" ? null : member)
    )
  }

  it("sends a 1:1 message to the member whose chat is open", async () => {
    getTaskView.mockResolvedValue(view())
    readTaskGroup.mockResolvedValue(group())
    postToMember.mockResolvedValue({ ok: true, result: {} })
    renderDetail()
    await openChat("claude-1")
    const input = screen.getByPlaceholderText("Message claude-1…")
    fireEvent.change(input, { target: { value: "merge it" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(postToMember).toHaveBeenCalledWith(
        7,
        "10-01-demo",
        "claude-1",
        "merge it",
        expect.stringMatching(/^gui-/),
        undefined
      )
    )
    expect(screen.queryByTitle("Jump to its terminal")).toBeNull()
  })

  it("sends a group message once without a recipient", async () => {
    getTaskView.mockResolvedValue(view())
    readTaskGroup.mockResolvedValue(
      group({
        members: [
          member,
          {
            ...member,
            name: "codex-1",
            bodies: [body("ref-2")],
            joined_seq: 5,
          },
        ],
      })
    )
    postToMember.mockResolvedValue({ ok: true, result: {} })
    renderDetail()
    await openChat("all")
    const input = await screen.findByPlaceholderText(
      /^Type @ to pick who answers/
    )
    fireEvent.change(input, { target: { value: "sync up" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(postToMember).toHaveBeenCalledTimes(1))
    expect(postToMember.mock.calls[0][2]).toBeUndefined()
  })

  it("keeps member display labels in messages and recipient selection", async () => {
    readTaskGroup.mockResolvedValue(
      group({ members: [{ ...member, label: "front" }] })
    )
    renderDetail()
    await openChat("claude-1")
    expect(screen.getByRole("button", { name: "Send to front" })).toBeVisible()
    expect(document.querySelector('[data-member="claude-1"]')).toBeNull()
  })
  it("addresses the composer to a member focused from the sidebar", async () => {
    readTaskGroup.mockResolvedValue(group())
    renderDetail()
    await openChat("all")
    await screen.findByText("please do S1")
    act(() => useGroupWorkspaceStore.getState().setFocusedMember("claude-1"))
    expect(
      screen.getByRole("button", { name: "Send to claude-1" })
    ).toBeVisible()
  })

  it("chats with an expert in its own ledger, not in the group", async () => {
    useExpertCatalog.setState({
      catalog: {
        home: "/home",
        experts: [
          {
            id: "dev",
            expert: {
              name: "Dev",
              prompt: "",
              skills: [],
              mcp: [],
              plugins: [],
            },
            promptText: null,
            modified: null,
            error: null,
            issues: [],
          },
        ],
        skills: [],
        mcp: [],
        plugins: [],
        invalid: { skills: [], mcp: [], plugins: [] },
      },
    })
    readTaskGroup.mockImplementation((_folder, _after, _page, name) =>
      Promise.resolve(
        name === "dm-dev"
          ? group({ name: "dm-dev", members: [], events: [], delivery: {} })
          : group()
      )
    )
    postToMember.mockResolvedValue({ ok: true, result: {} })
    renderDetail()
    await openChat("all")
    await screen.findByText("please do S1")
    act(() => useGroupWorkspaceStore.getState().setFocusedMember("dev"))
    await waitFor(() =>
      expect(readTaskGroup).toHaveBeenCalledWith(7, 0, undefined, "dm-dev")
    )
    // 群里的消息不出现在私聊里；侧栏仍停在原来的群。
    await waitFor(() => expect(screen.queryByText("please do S1")).toBeNull())
    expect(useGroupWorkspaceStore.getState().group).toBe("10-01-demo")
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "just us" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send to Dev" }))
    await waitFor(() =>
      expect(postToMember).toHaveBeenCalledWith(
        7,
        "dm-dev",
        "dev",
        "just us",
        expect.any(String),
        undefined
      )
    )
    useExpertCatalog.setState({ catalog: null })
  })

  it("opens a focused member on its messages with its member actions", async () => {
    readTaskGroup.mockResolvedValue(group())
    renderDetail()
    await openChat("all")
    await screen.findByText("please do S1")
    act(() => useGroupWorkspaceStore.getState().setFocusedMember("claude-1"))
    expect(await screen.findByText("please do S1")).toBeVisible()
    expect(
      document.querySelector('[data-acp-actions="claude-1"]')
    ).not.toBeNull()
    expect(screen.queryByRole("tab", { name: "Messages" })).toBeNull()
  })

  it("replies to A while viewing B without changing the recipient or losing the quote", async () => {
    const result = group({
      members: [
        member,
        { ...member, name: "codex-1", bodies: [body("ref-2")], joined_seq: 5 },
      ],
    })
    result.result.events.push({
      schema_version: 1,
      seq: 5,
      timestamp_ms: 5000,
      kind: "message",
      author: "codex-1",
      to: "user",
      text: "B report",
    })
    readTaskGroup.mockResolvedValue(result)
    postToMember.mockResolvedValue({ ok: true, result: {} })
    renderDetail()
    await openChat("all")
    await screen.findByText("B report")
    fireEvent.click(document.querySelector('[data-reply-seq="4"]')!)
    act(() => useGroupWorkspaceStore.getState().setFocusedMember("codex-1"))
    expect(screen.queryByText("please do S1")).toBeNull()
    expect(
      screen.getByRole("button", { name: "Send to claude-1" })
    ).toBeVisible()
    expect(screen.getByText("Quoting claude-1")).toBeVisible()
    const input = screen.getByRole("textbox", { name: "" })
    fireEvent.change(input, { target: { value: "continue A" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(postToMember).toHaveBeenCalledWith(
        7,
        "10-01-demo",
        "claude-1",
        "continue A",
        expect.stringMatching(/^gui-/),
        4
      )
    )
  })

  it("forwards an answer to another member as a quote", async () => {
    readTaskGroup.mockResolvedValue(
      group({
        members: [
          member,
          {
            ...member,
            name: "codex-1",
            bodies: [body("ref-2")],
            joined_seq: 5,
          },
        ],
      })
    )
    postToMember.mockResolvedValue({ ok: true, result: {} })
    renderDetail()
    await openChat("all")
    await screen.findByText("S1 done")
    const trigger = document.querySelector<HTMLElement>('[data-more-seq="4"]')!
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole("menuitem", { name: "@codex-1" }))
    expect(screen.getByText("Quoting claude-1")).toBeVisible()
    const input = screen.getByRole("textbox", { name: "" })
    fireEvent.change(input, { target: { value: "review this" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(postToMember).toHaveBeenCalledWith(
        7,
        "10-01-demo",
        "codex-1",
        "review this",
        expect.stringMatching(/^gui-/),
        4
      )
    )
  })

  it("shows who is waiting for you above the composer", async () => {
    // 会话交给了终端 t1，那个终端在等你。
    readTaskGroup.mockResolvedValue(
      group({ members: [{ ...member, handedTo: "t1" }] })
    )
    renderDetail()
    await openChat("all")
    await screen.findByText("S1 done")
    const live = document.querySelector('[data-live-member="claude-1"]')!
    expect(live).toHaveAttribute("data-live-state", "attention")
    expect(live).toHaveTextContent("Waiting for you")
    fireEvent.click(screen.getByRole("button", { name: "Handle" }))
    expect(jump).toHaveBeenCalled()
  })

  it("does not add a second member list or search field inside the group page", async () => {
    readTaskGroup.mockResolvedValue(group())
    renderDetail()
    await openChat("all")
    await screen.findByText("S1 done")
    expect(document.querySelector("[data-focus-member]")).toBeNull()
    expect(document.querySelector("[data-member]")).toBeNull()
    expect(screen.queryByRole("textbox", { name: "Search Agents…" })).toBeNull()
  })
  it("uses the existing toolbar for filtering without a separate All messages row", async () => {
    readTaskGroup.mockResolvedValue(group())
    renderDetail()
    await openChat("all")
    await screen.findByText("S1 done")
    const main = document.querySelector("[data-group-panel] main")!
    expect(main.querySelector("[data-group-member-bar]")).toBeNull()
    expect(main.querySelector("[data-group-timeline]")).not.toBeNull()
    expect(screen.queryByText("All messages")).toBeNull()
    await openChat("claude-1")
    expect(useGroupWorkspaceStore.getState().focusedMember).toBe("claude-1")
    fireEvent.click(document.querySelector("[data-group-back]")!)
    expect(useGroupWorkspaceStore.getState().focusedMember).toBeNull()
  })
  it("loads the page before the earliest message when scrolling back", async () => {
    readTaskGroup.mockImplementation((_folder, _after, page) =>
      Promise.resolve(
        page
          ? group({
              more: false,
              events: [
                {
                  schema_version: 1,
                  seq: 0.5,
                  timestamp_ms: 500,
                  kind: "message",
                  author: "user",
                  to: "claude-1",
                  text: "older ask",
                },
              ],
            })
          : group({ more: true })
      )
    )
    // 群数据按项目缓存在模块里：用没读过的项目，从第一页读起。
    renderDetail(9)
    await screen.findByText("please do S1")
    fireEvent.click(document.querySelector("[data-group-older]")!)
    await waitFor(() =>
      expect(readTaskGroup).toHaveBeenCalledWith(
        9,
        0,
        { before: 1, limit: 200 },
        // 群页把读到的群设为选中，之后按它读。
        "10-01-demo"
      )
    )
    expect(await screen.findByText("older ask")).toBeVisible()
    expect(document.querySelector("[data-group-older]")).toBeNull()
  })
})
