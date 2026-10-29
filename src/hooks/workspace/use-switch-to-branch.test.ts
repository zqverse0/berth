import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { resetTabStore, useTabStore } from "@/stores/tab-store"

const mocks = vi.hoisted(() => ({
  resolveWorktreeFolder: vi.fn(),
  gitCheckout: vi.fn(),
  requestAgentLaunch: vi.fn(),
  openWorktreeFolder: vi.fn(),
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/api", () => ({
  resolveWorktreeFolder: (...args: unknown[]) =>
    mocks.resolveWorktreeFolder(...args),
  gitCheckout: (...args: unknown[]) => mocks.gitCheckout(...args),
  getFolder: vi.fn(async () => ({
    id: 1,
    name: "repo",
    path: "/tmp/repo",
    git_branch: "other",
    default_agent_type: null,
    last_opened_at: "2026-01-01T00:00:00.000Z",
    sort_order: 1,
    color: "#000000",
    parent_id: null,
    kind: "regular",
    alias: null,
  })),
}))

vi.mock("@/stores/agent-launch-store", () => ({
  requestAgentLaunch: (...args: unknown[]) => mocks.requestAgentLaunch(...args),
}))

import { useSwitchToBranch } from "./use-switch-to-branch"

function makeFolder(
  overrides: Partial<FolderDetail> & { id: number; path: string }
): FolderDetail {
  return {
    name: overrides.name ?? `folder-${overrides.id}`,
    git_branch: overrides.git_branch ?? "main",
    default_agent_type: null,
    last_opened_at: "2026-01-01T00:00:00.000Z",
    sort_order: overrides.id,
    color: "#000000",
    parent_id: overrides.parent_id ?? null,
    kind: "regular",
    alias: null,
    ...overrides,
  }
}

beforeEach(() => {
  resetAppWorkspaceStore()
  resetTabStore()
  mocks.resolveWorktreeFolder.mockReset()
  mocks.gitCheckout.mockReset()
  mocks.requestAgentLaunch.mockReset()
  mocks.openWorktreeFolder.mockReset()
})

afterEach(() => {
  resetAppWorkspaceStore()
  resetTabStore()
})

describe("useSwitchToBranch", () => {
  it("activates a registered worktree without opening the launch home", async () => {
    const root = makeFolder({ id: 1, path: "/tmp/repo", git_branch: "main" })
    const worktree = makeFolder({
      id: 2,
      path: "/tmp/repo-feature",
      git_branch: "feature",
      parent_id: 1,
    })
    useAppWorkspaceStore.setState({
      folders: [root, worktree],
      allFolders: [root, worktree],
    })
    mocks.resolveWorktreeFolder.mockResolvedValue({
      path: worktree.path,
      folder_id: worktree.id,
    })
    const activate = vi.spyOn(useTabStore.getState(), "activateFolderWorkspace")

    const { result } = renderHook(() => useSwitchToBranch())
    await act(async () => {
      await result.current({
        activeFolder: root,
        branchName: "feature",
        currentBranch: "main",
      })
    })

    expect(activate).toHaveBeenCalledWith(2)
    expect(mocks.requestAgentLaunch).not.toHaveBeenCalled()
  })

  it("activates the registered root when checking out there", async () => {
    const root = makeFolder({ id: 1, path: "/tmp/repo", git_branch: "main" })
    const worktree = makeFolder({
      id: 2,
      path: "/tmp/repo-feature",
      git_branch: "feature",
      parent_id: 1,
    })
    useAppWorkspaceStore.setState({
      folders: [root, worktree],
      allFolders: [root, worktree],
    })
    mocks.resolveWorktreeFolder.mockResolvedValue({
      path: null,
      folder_id: null,
    })
    mocks.gitCheckout.mockResolvedValue(undefined)
    const activate = vi.spyOn(useTabStore.getState(), "activateFolderWorkspace")

    const { result } = renderHook(() => useSwitchToBranch())
    await act(async () => {
      await result.current({
        activeFolder: worktree,
        branchName: "other",
        currentBranch: "feature",
      })
    })

    expect(activate).toHaveBeenCalledWith(1)
    expect(mocks.requestAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.gitCheckout).toHaveBeenCalledWith("/tmp/repo", "other")
  })
})
