import { create } from "zustand"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import {
  getGitHubAccounts,
  githubStarred,
  updateGitHubAccounts,
} from "@/lib/api"
import type {
  GitHubAccount,
  GitHubAccountsSettings,
  GithubStarredRepo,
} from "@/lib/types"
import type { StarredSortBy } from "@/lib/git/github-starred-search"

const ALL = "__all__"

/** 上次 clone 的目标目录，重启后沿用 */
const TARGET_DIR_KEY = "github:clone-target-dir"

function loadTargetDir(): string {
  try {
    return localStorage.getItem(TARGET_DIR_KEY) ?? ""
  } catch {
    return ""
  }
}

export { ALL as GITHUB_STARRED_FILTER_ALL }

interface GithubStarredState {
  accounts: GitHubAccountsSettings
  repos: GithubStarredRepo[]
  syncedAt: string | null
  cacheAccountId: string | null
  query: string
  sortBy: StarredSortBy
  language: string
  topic: string
  license: string
  targetDir: string
  hydrated: boolean
  hydrating: boolean
  syncing: boolean
  hydrate: () => Promise<void>
  sync: () => Promise<void>
  addAccount: (account: GitHubAccount) => Promise<void>
  setQuery: (query: string) => void
  setSortBy: (sortBy: StarredSortBy) => void
  setLanguage: (language: string) => void
  setTopic: (topic: string) => void
  setLicense: (license: string) => void
  setTargetDir: (targetDir: string) => void
  toggleStar: (repo: {
    name: string
    full_name: string
    owner: { login: string; avatar_url?: string }
    description?: string | null
    stargazers_count?: number | null
    forks_count?: number | null
    language?: string | null
    html_url?: string
  }) => Promise<boolean>
  reset: () => void
}

const emptyAccounts: GitHubAccountsSettings = { accounts: [] }

export const useGithubStarredStore = create<GithubStarredState>((set, get) => ({
  accounts: emptyAccounts,
  repos: [],
  syncedAt: null,
  cacheAccountId: null,
  query: "",
  sortBy: "stars",
  language: ALL,
  topic: ALL,
  license: ALL,
  targetDir: loadTargetDir(),
  hydrated: false,
  hydrating: false,
  syncing: false,
  hydrate: async () => {
    if (get().hydrated || get().hydrating) return
    set({ hydrating: true })
    try {
      const [accounts, starred] = await Promise.all([
        getGitHubAccounts(),
        githubStarred({ op: "list" }),
      ])
      set({
        accounts,
        repos: starred.repos,
        syncedAt: starred.synced_at,
        cacheAccountId: starred.account_id,
        hydrated: true,
        hydrating: false,
      })
    } catch (error) {
      set({ hydrating: false })
      throw error
    }
  },
  sync: async () => {
    set({ syncing: true })
    try {
      const starred = await githubStarred({ op: "sync" })
      set({
        repos: starred.repos,
        syncedAt: starred.synced_at,
        cacheAccountId: starred.account_id,
        hydrated: true,
        syncing: false,
      })
    } catch (error) {
      set({ syncing: false })
      throw error
    }
  },
  addAccount: async (account) => {
    const { accounts } = get()
    const updated: GitHubAccountsSettings = {
      accounts: [
        ...accounts.accounts.map((row) =>
          account.is_default ? { ...row, is_default: false } : row
        ),
        account,
      ],
    }
    const saved = await updateGitHubAccounts(updated)
    set({ accounts: saved })
    await get().sync()
  },
  toggleStar: async (repo) => {
    const { repos, accounts } = get()
    const defaultAccount =
      accounts.accounts.find((a) => a.is_default) ?? accounts.accounts[0]
    if (!defaultAccount) {
      throw new Error("NO_ACCOUNT")
    }
    const fullNameLower = repo.full_name.toLowerCase()
    const isStarred = repos.some(
      (r) => r.full_name.toLowerCase() === fullNameLower
    )
    const op = isStarred ? "unstar" : "star"

    // 乐观更新状态
    if (isStarred) {
      set({
        repos: repos.filter((r) => r.full_name.toLowerCase() !== fullNameLower),
      })
    } else {
      const now = new Date().toISOString()
      const newStarredRepo: GithubStarredRepo = {
        id: Date.now(),
        name: repo.name,
        full_name: repo.full_name,
        description: repo.description ?? null,
        html_url: repo.html_url || `https://github.com/${repo.full_name}`,
        clone_url: `https://github.com/${repo.full_name}.git`,
        stargazers_count: (repo.stargazers_count ?? 0) + 1,
        forks_count: repo.forks_count ?? 0,
        language: repo.language ?? null,
        created_at: now,
        updated_at: now,
        pushed_at: now,
        starred_at: now,
        owner: {
          login: repo.owner.login,
          avatar_url:
            repo.owner.avatar_url ||
            `https://github.com/${repo.owner.login}.png?size=64`,
        },
        topics: [],
        license: null,
        archived: false,
      }
      set({ repos: [newStarredRepo, ...repos] })
    }

    try {
      await githubStarred({
        op,
        owner: repo.owner.login,
        name: repo.name,
      })
      return !isStarred
    } catch (err) {
      set({ repos })
      throw err
    }
  },
  setQuery: (query) => set({ query }),
  setSortBy: (sortBy) => set({ sortBy }),
  setLanguage: (language) => set({ language }),
  setTopic: (topic) => set({ topic }),
  setLicense: (license) => set({ license }),
  setTargetDir: (targetDir) => {
    try {
      localStorage.setItem(TARGET_DIR_KEY, targetDir)
    } catch {
      /* 存不下只影响下次重启 */
    }
    set({ targetDir })
  },
  reset: () =>
    set({
      accounts: emptyAccounts,
      repos: [],
      syncedAt: null,
      cacheAccountId: null,
      query: "",
      sortBy: "stars",
      language: ALL,
      topic: ALL,
      license: ALL,
      targetDir: loadTargetDir(),
      hydrated: false,
      hydrating: false,
      syncing: false,
    }),
}))

registerBackendScopedStoreReset(() => {
  useGithubStarredStore.getState().reset()
})
