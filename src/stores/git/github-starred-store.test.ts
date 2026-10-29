import { beforeEach, describe, expect, it, vi } from "vitest"
import { useGithubStarredStore } from "@/stores/git/github-starred-store"

vi.mock("@/lib/api", () => ({
  getGitHubAccounts: vi.fn(),
  githubStarred: vi.fn(),
  updateGitHubAccounts: vi.fn(),
}))

describe("github starred clone target dir", () => {
  beforeEach(() => localStorage.clear())

  it("persists the folder and keeps it across a store reset", () => {
    useGithubStarredStore.getState().setTargetDir("/home/me/src")
    expect(localStorage.getItem("github:clone-target-dir")).toBe("/home/me/src")

    useGithubStarredStore.getState().reset()
    expect(useGithubStarredStore.getState().targetDir).toBe("/home/me/src")
  })
})
