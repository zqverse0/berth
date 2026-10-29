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
const refreshWorktreeFamily = vi.fn()
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
}))
const enableBerth = vi.fn()
const getBerthStatus = vi.fn()
vi.mock("@/lib/agent/berth-project", () => ({
  enableBerth: (...args: unknown[]) => enableBerth(...args),
  getBerthStatus: (...args: unknown[]) => getBerthStatus(...args),
}))
vi.mock("@/lib/api", () => ({
  terminateTerminalSession: (...args: unknown[]) =>
    terminateTerminalSession(...args),
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
    refreshWorktreeFamily,
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
      history: [],
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

function renderDetail() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <GroupPanel folderId={7} />
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
    refreshWorktreeFamily,
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
  it("reads an empty group directly without an anchor task", async () => {
    listBerthTaskViews.mockResolvedValue({ ok: true, result: { tasks: [] } })
    readTaskGroup.mockResolvedValue(group())
    renderDetail()
    await waitFor(() => expect(readTaskGroup).toHaveBeenCalledWith(7, 0))
    expect(await screen.findByText(/Started · branch demo/)).toBeVisible()
  })
  it("shows the group timeline with delivery state, members and its tasks", async () => {
    getTaskView.mockResolvedValue(view())
    readTaskGroup.mockResolvedValue(group())
    renderDetail()
    expect(await screen.findByText("please do S1")).toBeVisible()
    expect(screen.getByText("Queued")).toBeVisible()
    expect(screen.getByText("S1 done")).toBeVisible()
    expect(document.querySelector('[data-member="claude-1"]')).toBeNull()
    expect(screen.getAllByText("feat: x").length).toBeGreaterThan(0)
    await waitFor(() => expect(ensureGroupWatch).toHaveBeenCalledWith(7))
  })

  /** 收件人只在输入框左下角的 @ 菜单里选。 */
  async function pickRecipient(name: string) {
    const trigger = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-composer-to]")
      expect(found).not.toBeNull()
      return found!
    })
    fireEvent.keyDown(trigger, { key: "Enter" })
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name }))
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    })
  }

  it("requires explicit selection even for the only member", async () => {
    getTaskView.mockResolvedValue(view())
    readTaskGroup.mockResolvedValue(group())
    postToMember.mockResolvedValue({ ok: true, result: {} })
    renderDetail()
    const input = await screen.findByPlaceholderText(/Pick recipients/)
    fireEvent.change(input, { target: { value: "merge it" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(postToMember).not.toHaveBeenCalled()
    await pickRecipient("claude-1")
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

  it("sends one message to every member as a single batch", async () => {
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
    await pickRecipient("Everyone")
    const input = screen.getByPlaceholderText(/Message everyone/)
    fireEvent.change(input, { target: { value: "sync up" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(postToMember).toHaveBeenCalledTimes(2))
    const [first, second] = postToMember.mock.calls
    expect([first[2], second[2]].sort()).toEqual(["claude-1", "codex-1"])
    expect(first[4]).toBe(second[4])
  })

  it("keeps member display labels in messages and recipient selection", async () => {
    readTaskGroup.mockResolvedValue(
      group({ members: [{ ...member, label: "front" }] })
    )
    renderDetail()
    await pickRecipient("front")
    expect(screen.getByRole("button", { name: "Send to front" })).toBeVisible()
    expect(document.querySelector('[data-member="claude-1"]')).toBeNull()
  })
  it("addresses the composer to a member focused from the sidebar", async () => {
    readTaskGroup.mockResolvedValue(group())
    renderDetail()
    await screen.findByText("please do S1")
    act(() => useGroupWorkspaceStore.getState().setFocusedMember("claude-1"))
    expect(
      screen.getByRole("button", { name: "Send to claude-1" })
    ).toBeVisible()
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
    await screen.findByText("S1 done")
    const trigger = document.querySelector<HTMLElement>(
      '[data-forward-seq="4"]'
    )!
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
    readTaskGroup.mockResolvedValue(group())
    renderDetail()
    await screen.findByText("S1 done")
    const live = document.querySelector('[data-live-member="claude-1"]')!
    expect(live).toHaveAttribute("data-live-state", "attention")
    expect(live).toHaveTextContent("Waiting for you")
    expect(live).toHaveTextContent("1 queued")
    fireEvent.click(screen.getByRole("button", { name: "Handle" }))
    expect(jump).toHaveBeenCalled()
  })

  it("does not add a second member list or search field inside the group page", async () => {
    readTaskGroup.mockResolvedValue(group())
    renderDetail()
    await screen.findByText("S1 done")
    expect(document.querySelector("[data-focus-member]")).toBeNull()
    expect(document.querySelector("[data-member]")).toBeNull()
    expect(screen.queryByRole("textbox", { name: "Search Agents…" })).toBeNull()
  })
  it("uses the existing toolbar for filtering without a separate All messages row", async () => {
    readTaskGroup.mockResolvedValue(group())
    renderDetail()
    await screen.findByText("S1 done")
    const main = document.querySelector("[data-group-panel] main")!
    expect(main.querySelector("[data-group-member-bar]")).toBeNull()
    expect(main.querySelector("[data-group-timeline]")).not.toBeNull()
    expect(screen.queryByText("All messages")).toBeNull()
    act(() => useGroupWorkspaceStore.getState().setFocusedMember("claude-1"))
    expect(screen.getByText(/Related to claude-1/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "All messages" }))
    expect(useGroupWorkspaceStore.getState().focusedMember).toBeNull()
    expect(screen.getByText(/Started · branch demo/)).toBeVisible()
    expect(screen.queryByText(/Related to claude-1/)).toBeNull()
  })
  it("offers the enable button instead of an error when Berth is not initialized", async () => {
    readTaskGroup.mockResolvedValue({
      ok: false,
      error: { message: "本项目未启用 Berth" },
    })
    getBerthStatus.mockResolvedValue({ ok: true, result: { enabled: false } })
    enableBerth.mockResolvedValue({ ok: true, result: {} })
    renderDetail()
    const button = await screen.findByRole("button", { name: "Enable Berth" })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    readTaskGroup.mockResolvedValue(group())
    fireEvent.click(button)
    await waitFor(() => expect(enableBerth).toHaveBeenCalledWith(7))
    expect(await screen.findByText(/Started · branch demo/)).toBeVisible()
  })
})
