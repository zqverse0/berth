import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import {
  cloneRepository,
  githubStarred,
  githubTrending,
  openFolderInWorkspace,
} from "@/lib/api"
import type { GithubStarredResult, GithubTrendingResult } from "@/lib/types"
import { useGithubStarredStore } from "@/stores/git/github-starred-store"
import { useGithubTrendingStore } from "@/stores/git/github-trending-store"
import { GithubTrendingWorkspace } from "@/components/layout/github-trending-workspace"
import { SidebarHeader } from "@/components/layout/sidebar/sidebar-header"

vi.mock("@/lib/api", () => ({
  githubTrending: vi.fn(),
  githubStarred: vi.fn(),
  getGitHubAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
  cloneRepository: vi.fn().mockResolvedValue(undefined),
  openFolderInWorkspace: vi.fn().mockResolvedValue({}),
}))

const openReadonlyTextPreview = vi.fn()
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ openReadonlyTextPreview }),
}))

const mockedGithubTrending = vi.mocked(githubTrending)
const mockedGithubStarred = vi.mocked(githubStarred)

const result: GithubTrendingResult = {
  repos: [
    {
      rank: 1,
      name: "demo",
      full_name: "acme/demo",
      description: "A useful repository",
      html_url: "https://github.com/acme/demo",
      stargazers_count: 1234,
      forks_count: 56,
      language: "Rust",
      owner: {
        login: "acme",
        avatar_url: "https://github.com/acme.png?size=64",
      },
    },
  ],
  fetched_at: "2026-09-02T00:00:00Z",
  time_range: "weekly",
  rate_limit_remaining: 42,
}

const emptyStarredResult: GithubStarredResult = {
  repos: [],
  synced_at: null,
  account_id: null,
  readme: null,
  rate_limit_remaining: null,
}

function renderWorkspace() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {/* 刷新按钮通过 portal 渲染进侧栏顶栏 */}
      <SidebarHeader title="Discover" />
      <div className="h-96">
        <GithubTrendingWorkspace />
      </div>
    </NextIntlClientProvider>
  )
}

describe("GithubTrendingWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useGithubTrendingStore.getState().reset()
    useGithubStarredStore.getState().reset()
    mockedGithubTrending.mockResolvedValue(result)
    mockedGithubStarred.mockResolvedValue(emptyStarredResult)
  })

  it("loads the weekly feed and renders repository metadata", async () => {
    renderWorkspace()

    expect(await screen.findByText("acme/demo")).toBeInTheDocument()
    expect(mockedGithubTrending).toHaveBeenCalledWith("weekly", false)
    expect(screen.getByLabelText("1.2k stars")).toBeInTheDocument()
    expect(screen.getByText("Rust")).toBeInTheDocument()
  })

  it("reloads when the time range changes", async () => {
    renderWorkspace()
    await screen.findByText("acme/demo")

    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(await screen.findByRole("option", { name: "Today" }))

    await waitFor(() => {
      expect(mockedGithubTrending).toHaveBeenLastCalledWith("daily", false)
    })
  })

  it("reuses cached data when remounted and does not call API again", async () => {
    const { unmount } = renderWorkspace()
    expect(await screen.findByText("acme/demo")).toBeInTheDocument()
    expect(mockedGithubTrending).toHaveBeenCalledTimes(1)

    // 卸载组件（例如切换到其他 Tab）
    unmount()

    // 重新挂载组件（切回该 Tab）
    renderWorkspace()
    expect(await screen.findByText("acme/demo")).toBeInTheDocument()
    // 应当直接从 store 缓存读取，API 调用次数依然为 1，不浪费请求配额
    expect(mockedGithubTrending).toHaveBeenCalledTimes(1)
  })

  it("forces reload when refresh button is clicked", async () => {
    renderWorkspace()
    await screen.findByText("acme/demo")
    expect(mockedGithubTrending).toHaveBeenCalledWith("weekly", false)

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() => {
      expect(mockedGithubTrending).toHaveBeenLastCalledWith("weekly", true)
    })
  })

  it("indicates starred status with filled star icon and allows toggling", async () => {
    // 模拟用户已绑定 GitHub 账号并已星标 acme/demo
    useGithubStarredStore.setState({
      accounts: {
        accounts: [
          {
            id: "acc-1",
            username: "octocat",
            server_url: "https://github.com",
            scopes: [],
            avatar_url: null,
            created_at: "2026-01-01T00:00:00Z",
            is_default: true,
          },
        ],
      },
      repos: [
        {
          id: 101,
          name: "demo",
          full_name: "acme/demo",
          description: "A useful repository",
          html_url: "https://github.com/acme/demo",
          clone_url: "https://github.com/acme/demo.git",
          stargazers_count: 1234,
          forks_count: 56,
          language: "Rust",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          pushed_at: "2026-01-01T00:00:00Z",
          starred_at: "2026-01-01T00:00:00Z",
          owner: { login: "acme", avatar_url: "https://github.com/acme.png" },
          topics: [],
          license: null,
          archived: false,
        },
      ],
      hydrated: true,
    })

    renderWorkspace()
    expect(await screen.findByText("acme/demo")).toBeInTheDocument()

    // 此时应当显示 Unstar 按钮（已星标状态）
    const unstarBtn = screen.getByRole("button", { name: /Unstar/i })
    expect(unstarBtn).toBeInTheDocument()

    // 点击触发取消星标
    mockedGithubStarred.mockResolvedValueOnce(emptyStarredResult)
    fireEvent.click(unstarBtn)

    await waitFor(() => {
      expect(mockedGithubStarred).toHaveBeenCalledWith({
        op: "unstar",
        owner: "acme",
        name: "demo",
      })
    })
  })

  it("replaces the loading preview with the error when README fails", async () => {
    renderWorkspace()
    await screen.findByText("acme/demo")

    mockedGithubStarred.mockRejectedValueOnce(new Error("no token"))
    fireEvent.click(screen.getByText("acme/demo"))

    await waitFor(() => {
      expect(openReadonlyTextPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          content: "Failed to load README: no token",
        })
      )
    })
  })

  it("clones straight into the remembered folder from the row", async () => {
    useGithubStarredStore.setState({ targetDir: "/tmp/src/" })
    renderWorkspace()
    await screen.findByText("acme/demo")

    fireEvent.click(screen.getByRole("button", { name: "Clone: acme/demo" }))

    await waitFor(() => {
      expect(vi.mocked(openFolderInWorkspace)).toHaveBeenCalledWith(
        "/tmp/src/demo"
      )
    })
    expect(vi.mocked(cloneRepository)).toHaveBeenCalledWith(
      "https://github.com/acme/demo.git",
      "/tmp/src/demo",
      undefined
    )
  })
})
