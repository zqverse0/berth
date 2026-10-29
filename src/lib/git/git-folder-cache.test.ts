import { beforeEach, describe, expect, it, vi } from "vitest"

const gitStatus = vi.fn()
const gitLog = vi.fn()

vi.mock("@/lib/api", () => ({
  gitStatus: (...args: unknown[]) => gitStatus(...args),
  gitLog: (...args: unknown[]) => gitLog(...args),
}))

import {
  invalidateGitFolderCache,
  loadCachedGitLog,
  loadCachedGitStatus,
} from "@/lib/git/git-folder-cache"

beforeEach(() => {
  invalidateGitFolderCache()
  gitStatus.mockReset().mockResolvedValue([{ file: "a.ts", status: " M" }])
  gitLog.mockReset().mockResolvedValue({ entries: [], has_upstream: false })
})

describe("git folder cache", () => {
  it("reuses status for the same path and flag", async () => {
    await loadCachedGitStatus("/repo", true)
    await loadCachedGitStatus("/repo", true)
    expect(gitStatus).toHaveBeenCalledTimes(1)
    await loadCachedGitStatus("/repo", false)
    expect(gitStatus).toHaveBeenCalledTimes(2)
  })

  it("shares log pages by args and drops them on invalidate", async () => {
    await loadCachedGitLog("/repo", { limit: 100 })
    await loadCachedGitLog("/repo", { limit: 100 })
    expect(gitLog).toHaveBeenCalledTimes(1)
    invalidateGitFolderCache("/repo")
    await loadCachedGitLog("/repo", { limit: 100 })
    expect(gitLog).toHaveBeenCalledTimes(2)
  })
})
