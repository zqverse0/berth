import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import {
  type BerthTaskView,
  type BerthTaskList,
  type BerthTaskSummary,
} from "@/lib/agent/berth-tasks"

const openTaskTab = vi.fn()
const openCommitDiff = vi.fn()
const listBerthTaskViews = vi.fn()
const saveTask = vi.fn()
vi.mock("@/lib/agent/berth-tasks", () => ({
  listBerthTaskViews: (...args: unknown[]) => listBerthTaskViews(...args),
  saveTask: (...args: unknown[]) => saveTask(...args),
}))

vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ openTaskTab, openCommitDiff }),
}))

let folders: { id: number; path: string; parent_id: number | null }[] = []
let panes: unknown[] = []
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (
    select: (state: { allFolders: typeof folders }) => unknown
  ) => select({ allFolders: folders }),
}))
vi.mock("@/lib/terminal/agent-panes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/terminal/agent-panes")>()),
  useAllAgentPanes: () => panes,
  useAgentPaneStore: (select: (state: { seen: object }) => unknown) =>
    select({ seen: {} }),
}))

import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { BerthTasksPanel } from "./berth-tasks-panel"

function summary(
  id: string,
  status: string,
  extra: Partial<BerthTaskSummary> = {}
): BerthTaskSummary {
  return {
    id,
    title: `Task ${id}`,
    status,
    etag: "1",
    archived: false,
    ...extra,
  }
}

function view(
  taskDirName: string,
  state: BerthTaskView["state"],
  steps: BerthTaskView["steps"] = []
): BerthTaskView {
  return {
    taskDirName,
    title: taskDirName,
    state,
    prd: "",
    prdText: "",
    branch: null,
    baseBranch: null,
    worktree: null,
    dirtyFiles: 0,
    acceptance: { done: 0, total: 0, items: [] },
    steps,
    currentStep: null,
    commits: [],
    unlinkedCommits: 0,
    diffstat: "",
    history: [],
  }
}

function renderPanel(data: Partial<BerthTaskList>) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <BerthTasksPanel
        folderId={7}
        data={{ tasks: [], diagnostics: [], truncated: false, ...data }}
      />
    </NextIntlClientProvider>
  )
}

const row = (title: string) => screen.getByText(title).closest("button")!

function bound(taskDirName: string, worktree: string): BerthTaskView {
  return {
    ...view(taskDirName, "running"),
    branch: taskDirName,
    baseBranch: "dev",
    worktree,
  }
}

beforeEach(() => {
  folders = [{ id: 7, path: "/repo", parent_id: null }]
  panes = []
  openTaskTab.mockReset()
  openCommitDiff.mockReset()
  saveTask.mockReset()
  useWorkspaceFileStore.setState({ fileTabs: [], activeFileTabId: null })
  listBerthTaskViews.mockReset()
  listBerthTaskViews.mockResolvedValue({ ok: true, result: { tasks: [] } })
})

describe("BerthTasksPanel", () => {
  it("lists tasks flat by state with no group headings", async () => {
    listBerthTaskViews.mockResolvedValue({
      ok: true,
      result: {
        tasks: [
          view("a", "planning"),
          { ...bound("b", "/repo-team"), group: "team" },
        ],
      },
    })
    renderPanel({ tasks: [summary("a", "planning"), summary("b", "planning")] })
    const running = await screen.findByText("In progress")
    expect(running.closest("section")!.textContent).toContain("Task b")
    expect(
      screen.getByText("Planning").closest("section")!.textContent
    ).toContain("Task a")
    expect(screen.queryByText(/Group:/)).toBeNull()
    expect(screen.queryByText(/Worktree:/)).toBeNull()
  })

  it("opens the task tab in the center workspace", async () => {
    const user = userEvent.setup()
    listBerthTaskViews.mockResolvedValue({
      ok: true,
      result: { tasks: [view("08-19-demo", "planning")] },
    })
    renderPanel({ tasks: [summary("08-19-demo", "planning")] })
    await user.click(await screen.findByText("Task 08-19-demo"))
    expect(openTaskTab).toHaveBeenCalledWith({
      folderId: 7,
      taskDirName: "08-19-demo",
      title: "Task 08-19-demo",
    })
  })

  it("shows step progress and folds completed tasks into archived", async () => {
    const step = (
      checked: boolean,
      state: "todo" | "committed" | "merged"
    ) => ({ text: "s", checked, state, commit: null })
    listBerthTaskViews.mockResolvedValue({
      ok: true,
      result: {
        tasks: [
          view("a", "running", [
            step(true, "todo"),
            step(false, "committed"),
            step(false, "todo"),
          ]),
          view("b", "completed"),
        ],
      },
    })
    renderPanel({ tasks: [summary("a", "planning"), summary("b", "planning")] })
    expect((await screen.findByText("Archived")).textContent).toBe("Archived1")
    expect(row("Task a").dataset.taskState).toBe("running")
    expect(row("Task a").textContent).toContain("2/3")
    expect(row("Task a").title).toBe("a\nRunning · 2/3")
    expect(row("Task b").dataset.taskState).toBe("completed")
  })

  it("lists tasks from the records while views are unavailable", async () => {
    listBerthTaskViews.mockRejectedValue(new Error("offline"))
    renderPanel({ tasks: [summary("a", "in_progress")] })
    expect(await screen.findByText("Task a")).toBeVisible()
  })

  it("folds unreadable tasks into one line and lists archived tasks apart", async () => {
    renderPanel({
      tasks: [
        summary("a", "planning"),
        summary("z", "planning", { archived: true }),
      ],
      diagnostics: [{ entry: "08-28-x", message: "bad" }],
    })
    expect(screen.getByText("1 task(s) could not be read")).toBeInTheDocument()
    expect((await screen.findByText("Archived")).textContent).toBe("Archived1")
  })

  const FILE_STEPS: BerthTaskView["steps"] = [
    {
      text: "ticked in the file",
      checked: true,
      id: "S1",
      state: "todo",
      commit: { hash: "0d99670", subject: "" },
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
  it("keeps a row to title, state and progress and highlights the open task", async () => {
    listBerthTaskViews.mockResolvedValue({
      ok: true,
      result: { tasks: [view("a", "running", FILE_STEPS)] },
    })
    useWorkspaceFileStore.setState({
      fileTabs: [
        {
          id: "t",
          kind: "task",
          folderId: 7,
          taskDirName: "a",
          title: "a",
        } as never,
      ],
      activeFileTabId: "t",
    })
    renderPanel({ tasks: [summary("a", "in_progress")] })
    await waitFor(() => expect(row("Task a").dataset.taskState).toBe("running"))
    expect(row("Task a").getAttribute("aria-current")).toBe("page")
    expect(screen.queryByText("ticked in the file")).not.toBeInTheDocument()
    expect(screen.queryByText("Edit steps")).not.toBeInTheDocument()
  })
})
