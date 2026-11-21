import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { FolderDetail } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useRemoveProject, type RemoveMode } from "./remove-project-dialog"

const mocks = vi.hoisted(() => ({
  terminals: [] as Record<string, unknown>[],
  members: [] as Record<string, unknown>[],
  worktrees: {} as Record<string, string>,
  plan: null as Record<string, unknown> | null,
  changes: 0,
  remove: vi.fn(async () => {}),
  finish: vi.fn(),
}))

vi.mock("@/lib/terminal/terminal-inventory-query", () => ({
  refreshTerminalInventory: async () => mocks.terminals,
}))
vi.mock("@/lib/agent/berth-group", () => ({
  readTaskGroup: async () => ({ ok: true, result: { members: mocks.members } }),
  listGroups: async () => ({
    ok: true,
    result: { groups: [], worktrees: mocks.worktrees },
  }),
}))
vi.mock("@/lib/agent/berth-tasks", () => ({
  finishGroup: async (...args: unknown[]) => {
    mocks.finish(...args)
    return { ok: true, result: mocks.plan }
  },
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  gitStatus: async () => Array.from({ length: mocks.changes }, () => ({})),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ closeTabsByFolder: vi.fn() }),
}))

const folder = (id: number, path: string) =>
  ({
    id,
    name: path.split("/").pop(),
    path,
    project_id: 1,
    project: { name: "repo", main_folder_id: 1 },
  }) as unknown as FolderDetail

function Harness({ id, mode }: { id: number; mode: RemoveMode }) {
  const { requestRemove, removeDialog } = useRemoveProject()
  return (
    <>
      <button onClick={() => requestRemove(id, mode)}>go</button>
      {removeDialog}
    </>
  )
}

async function open(id: number, mode: RemoveMode = "delete") {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Harness id={id} mode={mode} />
    </NextIntlClientProvider>
  )
  await act(async () => {
    fireEvent.click(screen.getByText("go"))
  })
}

const m = enMessages.ProjectMembers

beforeEach(() => {
  mocks.terminals = []
  mocks.members = []
  mocks.worktrees = {}
  mocks.plan = null
  mocks.changes = 0
  mocks.remove.mockClear()
  mocks.finish.mockClear()
  useAppWorkspaceStore.setState({
    allFolders: [folder(1, "/repo"), folder(2, "/repo-wt")],
    removeFolderFromWorkspace: mocks.remove,
  })
})

describe("useRemoveProject — deleting a worktree", () => {
  it("refuses while an agent runs in the worktree", async () => {
    mocks.terminals = [
      {
        terminalId: "t",
        folderId: 1,
        agentId: "claude",
        status: "running",
        cwd: "/repo-wt/src",
        initialCwd: "/repo-wt",
      },
    ]
    await open(2)

    expect(await screen.findByText(m.gotIt)).toBeTruthy()
    expect(screen.queryByText(enMessages.Folder.common.confirm)).toBeNull()
  })

  it("asks before discarding uncommitted changes, then forces the delete", async () => {
    mocks.changes = 3
    await open(2)

    expect(
      await screen.findByText(/has 3 uncommitted changes; deleting discards/)
    ).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByText(enMessages.Folder.common.confirm))
    })
    expect(mocks.remove).toHaveBeenCalledWith(2, true, true)
  })

  it("hands a group worktree to the group wrap-up and lists what blocks it", async () => {
    mocks.worktrees = { g1: "/repo-wt" }
    mocks.plan = {
      ready: false,
      openTasks: ["11-01-x"],
      dirty: [],
      merged: false,
      baseBranch: "dev",
    }
    await open(2)

    expect(mocks.finish).toHaveBeenCalledWith(1, "g1", true)
    expect(await screen.findByText(/Open tasks: 11-01-x/)).toBeTruthy()
    expect(screen.getByText(/isn't merged into dev/)).toBeTruthy()
    expect(screen.queryByText(enMessages.Folder.common.confirm)).toBeNull()
  })
})
