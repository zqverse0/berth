import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { TaskWorkspaceTab } from "@/lib/files/file-workspace-tab"

const getTaskView = vi.fn()
const readTaskGroup = vi.fn()
const startTask = vi.fn()
const postToMember = vi.fn()
const ensureGroupWatch = vi.fn()
const finishTask = vi.fn()
const changeTaskState = vi.fn()
const saveTask = vi.fn()
const listGroups = vi.fn()
const assignTask = vi.fn()
const terminateTerminalSession = vi.fn()
const requestAgentLaunch = vi.fn()
const setActiveFolderId = vi.fn()
const refreshWorktreeFamily = vi.fn()
const jump = vi.fn()
const openTaskTab = vi.fn()
const closeFileTab = vi.fn()
const activateFolderWorkspace = vi.fn()
const selectWorkspaceTab = vi.fn()
const readFileForEdit = vi.fn()
const openFilePreview = vi.fn()
const openCommitDiff = vi.fn()
const openSession = vi.fn()

const folders = [
  { id: 7, path: "/repo" },
  { id: 8, path: "/repo-demo" },
]

vi.mock("./task-schedule", () => ({ TaskSchedule: () => null }))
vi.mock("@/sessions/project/open-project-session", () => ({
  useOpenProjectSession: () => openSession,
}))
vi.mock("@/lib/agent/berth-tasks", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTaskView: (...args: unknown[]) => getTaskView(...args),
  changeTaskState: (...args: unknown[]) => changeTaskState(...args),
  saveTask: (...args: unknown[]) => saveTask(...args),
}))
// 正文编辑器（CodeMirror）在 jsdom 里换成只显示正文的桩。
vi.mock("./task-body-editor", () => ({
  TaskBodyEditor: ({ body }: { body: string }) => (
    <div data-testid="task-body-editor">{body}</div>
  ),
}))
vi.mock("@/lib/agent/berth-group", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readTaskGroup: (...args: unknown[]) => readTaskGroup(...args),
  startTask: (...args: unknown[]) => startTask(...args),
  postToMember: (...args: unknown[]) => postToMember(...args),
  ensureGroupWatch: (...args: unknown[]) => ensureGroupWatch(...args),
  finishTask: (...args: unknown[]) => finishTask(...args),
  listGroups: (...args: unknown[]) => listGroups(...args),
  assignTask: (...args: unknown[]) => assignTask(...args),
}))
vi.mock("@/lib/api", () => ({
  terminateTerminalSession: (...args: unknown[]) =>
    terminateTerminalSession(...args),
  readFileForEdit: (...args: unknown[]) => readFileForEdit(...args),
}))
vi.mock("@/lib/terminal/agent-panes", () => ({
  useAllAgentPanes: () => [
    {
      descriptor: { terminalId: "t1", targetRef: "ref-1" },
      state: "attention",
      since: 5_000,
    },
  ],
  useAgentPaneStore: (select: (state: { seen: object }) => unknown) =>
    select({ seen: {} }),
}))
vi.mock("@/components/project-management/group/pane-actions", () => ({
  usePaneActions: () => ({ jump, interrupt: vi.fn() }),
}))
vi.mock("@/hooks/use-agent-profiles", () => ({
  useAgentProfiles: () => ({ agents: [{ id: "claude", name: "Claude Code" }] }),
}))
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({
    openFilePreview,
    openCommitDiff,
    openBranchDiff: vi.fn(),
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
  useWorkspaceLayoutStore: { getState: () => ({ selectWorkspaceTab }) },
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

import { TaskDetail } from "./task-detail"
import { TaskToolbar } from "./task-toolbar"
import { useTaskViewStore } from "./task-view-store"

const tab = {
  id: "task:7:10-01-demo",
  kind: "task",
  folderId: 7,
  taskDirName: "10-01-demo",
  title: "Ship it",
} as TaskWorkspaceTab

function view(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    result: {
      taskDirName: "10-01-demo",
      title: "Ship it",
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

function renderDetail(shown: TaskWorkspaceTab = tab) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {/* 工具栏在统一文件 Header 里，与任务页共用 task-view-store */}
      <TaskToolbar folderId={shown.folderId} task={shown.taskDirName} />
      <TaskDetail tab={shown} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  useTaskViewStore.setState({ views: {}, errors: {} })
  for (const mock of [
    getTaskView,
    readTaskGroup,
    startTask,
    postToMember,
    ensureGroupWatch,
    requestAgentLaunch,
    setActiveFolderId,
    refreshWorktreeFamily,
    finishTask,
    changeTaskState,
    listGroups,
    assignTask,
    terminateTerminalSession,
    jump,
    openTaskTab,
    closeFileTab,
    activateFolderWorkspace,
    selectWorkspaceTab,
    readFileForEdit,
    openFilePreview,
    openCommitDiff,
  ]) {
    mock.mockReset()
  }
  ensureGroupWatch.mockResolvedValue({ ok: true, result: { running: true } })
  terminateTerminalSession.mockResolvedValue(undefined)
  listGroups.mockResolvedValue({
    ok: true,
    result: { groups: ["main"], worktrees: { main: "/repo" } },
  })
})

describe("TaskDetail", () => {
  it("assigns the task to another worktree group from the more menu", async () => {
    listGroups.mockResolvedValue({
      ok: true,
      result: {
        groups: ["main", "g-arch"],
        worktrees: { main: "/repo", "g-arch": "/repo-arch" },
      },
    })
    getTaskView.mockResolvedValue(view({ group: "main", worktree: null }))
    assignTask.mockResolvedValue({
      ok: true,
      result: { taskDirName: "10-01-demo", group: "g-arch" },
    })
    const user = userEvent.setup()
    renderDetail()
    await waitFor(() => expect(listGroups).toHaveBeenCalledWith(7, true))
    await user.click(
      await screen.findByRole("button", { name: "More actions" })
    )
    await user.click(
      await screen.findByRole("menuitemradio", { name: "repo-arch" })
    )
    await waitFor(() =>
      expect(assignTask).toHaveBeenCalledWith(7, "10-01-demo", "g-arch")
    )
  })

  it("abandons an open task from the more menu", async () => {
    getTaskView.mockResolvedValue(view({ state: "planning" }))
    changeTaskState.mockResolvedValue({
      ok: true,
      result: { state: "completed" },
    })
    const user = userEvent.setup()
    renderDetail()
    await user.click(
      await screen.findByRole("button", { name: "More actions" })
    )
    await user.click(
      await screen.findByRole("menuitem", { name: "Abandon task" })
    )
    await waitFor(() =>
      expect(changeTaskState).toHaveBeenCalledWith(7, "10-01-demo", "cancel")
    )
  })

  it("begins a planning task without creating an execution environment", async () => {
    getTaskView.mockResolvedValue(
      view({
        state: "planning",
        branch: null,
        baseBranch: null,
        worktree: null,
        commits: [],
      })
    )
    changeTaskState.mockResolvedValue({
      ok: true,
      result: { state: "running" },
    })
    renderDetail()
    fireEvent.click(await screen.findByRole("button", { name: "Begin task" }))
    await waitFor(() =>
      expect(changeTaskState).toHaveBeenCalledWith(7, "10-01-demo", "begin")
    )
    expect(screen.getByText("# PRD body")).toBeVisible()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(document.querySelector("[data-start-bar]")).toBeNull()
    expect(startTask).not.toHaveBeenCalled()
    expect(refreshWorktreeFamily).not.toHaveBeenCalled()
    expect(ensureGroupWatch).not.toHaveBeenCalled()
  })

  it("shows only the task: step progress and source idea, no group or git details", async () => {
    getTaskView.mockResolvedValue(
      view({
        group: "design-team",
        idea: "2026-10-17-101500",
        prd: "/repo/.berth/tasks/10-01-demo.md",
        branch: "hidden-feature-branch",
        baseBranch: "hidden-base",
        diffstat: "private git summary",
        commits: [{ hash: "abc1234", subject: "private commit", step: null }],
      })
    )
    // 想法已归档：只有归档里那份读得到。
    readFileForEdit.mockImplementation(async (_root: string, path: string) => {
      if (!path.includes("归档")) throw new Error("not found")
      return { content: "" }
    })
    renderDetail()
    expect(await screen.findByText("Steps 1/1")).toBeVisible()
    for (const text of [
      "repo-demo",
      "design-team",
      "hidden-feature-branch",
      "hidden-base",
      "private git summary",
      "private commit",
    ]) {
      expect(screen.queryByText(text)).not.toBeInTheDocument()
    }
    fireEvent.click(screen.getByText("From idea 2026-10-17-101500"))
    await waitFor(() =>
      expect(openFilePreview).toHaveBeenCalledWith(
        "/repo/.berth/ideas/归档/2026-10-17-101500.idea.md"
      )
    )
    expect(readTaskGroup).not.toHaveBeenCalled()
  })

  it("edits the body of a single-file task in place, not in a separate file", async () => {
    getTaskView.mockResolvedValue(
      view({ prd: "/repo/.berth/tasks/10-01-demo.md", prdText: "## 目标" })
    )
    renderDetail()
    expect(await screen.findByTestId("task-body-editor")).toHaveTextContent(
      "## 目标"
    )
    expect(screen.queryByText("Open task file")).not.toBeInTheDocument()
  })

  const FILE_STEPS = [
    {
      text: "ticked in the file",
      checked: true,
      id: "S1",
      state: "committed",
      commit: { hash: "0d99670abc", subject: "", step: "S1" },
      change: "a.rs",
      verify: "cargo test a",
    },
    {
      text: "next",
      checked: false,
      id: "S2",
      state: "todo",
      commit: null,
      change: "b.rs",
      verify: "cargo test b",
    },
  ]

  it("lays out the goal, then steps with the current one open, then the full body", async () => {
    const prdText = "## 目标\n\n任务做完就归档\n\n## 记录\n\n- 一行"
    getTaskView.mockResolvedValue(
      view({
        prd: "/repo/.berth/tasks/10-01-demo.md",
        prdText,
        steps: FILE_STEPS,
        currentStep: "S2",
      })
    )
    renderDetail()
    const goal = await screen.findByText("任务做完就归档", { selector: "p" })
    const step = screen.getByText("ticked in the file")
    const editor = screen.getByTestId("task-body-editor")
    expect(editor.textContent).toBe(prdText)
    expect(
      goal.compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      step.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(step.closest("li")!.dataset.stepState).toBe("committed")
    expect(screen.getByText("next").closest("li")!.dataset.current).toBe("true")
    // 当前步默认展开改哪里、怎么验证；其他步点开才看。
    expect(screen.getByText("cargo test b")).toBeVisible()
    expect(screen.queryByText("cargo test a")).not.toBeInTheDocument()
    await userEvent.click(step)
    expect(screen.getByText("cargo test a")).toBeVisible()
    await userEvent.click(screen.getByRole("button", { name: "0d99670" }))
    expect(openCommitDiff).toHaveBeenCalledWith("0d99670abc", undefined, "")
  })

  it("edits steps on the task page and saves them to the task file", async () => {
    getTaskView.mockResolvedValue(
      view({
        prd: "/repo/.berth/tasks/10-01-demo.md",
        prdText: "正文",
        steps: FILE_STEPS,
      })
    )
    saveTask.mockResolvedValue({ ok: true, result: {} })
    renderDetail()
    await userEvent.click(
      await screen.findByRole("button", { name: "Edit steps" })
    )
    await userEvent.click(screen.getByRole("button", { name: "Add step" }))
    await userEvent.type(screen.getByLabelText("S3 What to do"), "new")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(saveTask).toHaveBeenCalledWith(7, "10-01-demo", {
        steps: [
          {
            id: "S1",
            do: "ticked in the file",
            change: "a.rs",
            verify: "cargo test a",
            commit: "0d99670abc",
          },
          { id: "S2", do: "next", change: "b.rs", verify: "cargo test b" },
          { id: "S3", do: "new", change: "", verify: "" },
        ],
      })
    )
  })

  it("opens a linked session, falling back to its snapshot when the source is gone", async () => {
    const session = {
      agent: "claude",
      id: "s1",
      title: "修标题",
      cwd: "/repo",
      snapshot: "/repo/.berth/local/task-sessions/10-01-demo/claude-s1.md",
    }
    getTaskView.mockResolvedValue(view({ sessions: [session] }))
    openSession.mockImplementation(
      async (_session: unknown, onUnavailable: () => void) => onUnavailable()
    )
    renderDetail()
    await userEvent.click(await screen.findByRole("button", { name: /修标题/ }))
    expect(openSession).toHaveBeenCalledWith(
      {
        agent: "claude",
        sessionId: "s1",
        cwd: "/repo",
        title: "修标题",
      },
      expect.any(Function)
    )
    expect(openFilePreview).toHaveBeenCalledWith(session.snapshot)
  })

  it("omits the goal summary for a legacy task without one, and steps without any", async () => {
    getTaskView.mockResolvedValue(view({ prdText: "# 旧任务", steps: [] }))
    renderDetail()
    await screen.findByText("# 旧任务")
    expect(screen.queryByText("Edit steps")).not.toBeInTheDocument()
    expect(screen.getAllByText("# 旧任务")).toHaveLength(1)
  })

  it("completes and archives without terminating members or removing the environment", async () => {
    getTaskView.mockResolvedValue(view({ state: "running", commits: [] }))
    readTaskGroup.mockResolvedValue(group())
    changeTaskState.mockResolvedValue({
      ok: true,
      result: { state: "completed" },
    })
    renderDetail()
    fireEvent.click(
      await screen.findByRole("button", { name: "Complete and archive" })
    )
    await waitFor(() =>
      expect(changeTaskState).toHaveBeenCalledWith(7, "10-01-demo", "complete")
    )
    expect(terminateTerminalSession).not.toHaveBeenCalled()
    expect(finishTask).not.toHaveBeenCalled()
    expect(refreshWorktreeFamily).not.toHaveBeenCalled()
  })

  it("keeps a task tab and active worktree project in place after completion", async () => {
    getTaskView.mockResolvedValue(view({ state: "running", commits: [] }))
    readTaskGroup.mockResolvedValue(group())
    changeTaskState.mockResolvedValue({
      ok: true,
      result: { state: "completed" },
    })
    renderDetail({ ...tab, id: "task:8:10-01-demo", folderId: 8 })
    fireEvent.click(
      await screen.findByRole("button", { name: "Complete and archive" })
    )
    await waitFor(() =>
      expect(changeTaskState).toHaveBeenCalledWith(8, "10-01-demo", "complete")
    )
    expect(activateFolderWorkspace).not.toHaveBeenCalled()
    expect(closeFileTab).not.toHaveBeenCalled()
    expect(openTaskTab).not.toHaveBeenCalled()
    expect(selectWorkspaceTab).not.toHaveBeenCalled()
  })

  it("allows task completion even with dirty shared worktree files", async () => {
    getTaskView.mockResolvedValue(view({ state: "running", dirtyFiles: 2 }))
    readTaskGroup.mockResolvedValue(group())
    changeTaskState.mockResolvedValue({
      ok: true,
      result: { state: "completed" },
    })
    renderDetail()
    fireEvent.click(
      await screen.findByRole("button", { name: "Complete and archive" })
    )
    await waitFor(() => expect(changeTaskState).toHaveBeenCalledTimes(1))
    expect(terminateTerminalSession).not.toHaveBeenCalled()
    expect(finishTask).not.toHaveBeenCalled()
  })

  it("reopens archived tasks into execution without branch cleanup", async () => {
    getTaskView.mockResolvedValue(view({ state: "completed", archived: true }))
    readTaskGroup.mockResolvedValue(group())
    changeTaskState.mockResolvedValue({
      ok: true,
      result: { state: "running" },
    })
    renderDetail()
    fireEvent.click(await screen.findByRole("button", { name: "Reopen task" }))
    await waitFor(() =>
      expect(changeTaskState).toHaveBeenCalledWith(7, "10-01-demo", "reopen")
    )
    expect(terminateTerminalSession).not.toHaveBeenCalled()
    expect(finishTask).not.toHaveBeenCalled()
  })
})
