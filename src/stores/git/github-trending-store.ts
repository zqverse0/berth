import { create } from "zustand"
import { githubTrending } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { GithubTrendingRepo, TrendingTimeRange } from "@/lib/types"

export interface TrendingCacheEntry {
  repos: GithubTrendingRepo[]
  fetchedAt: string
  rateLimitRemaining: number | null
}

interface GithubTrendingState {
  timeRange: TrendingTimeRange
  cache: Partial<Record<TrendingTimeRange, TrendingCacheEntry>>
  loading: boolean
  error: string | null
  setTimeRange: (range: TrendingTimeRange) => void
  load: (range?: TrendingTimeRange, force?: boolean) => Promise<void>
  refresh: () => Promise<void>
  reset: () => void
}

let activeRequestId = 0

export const useGithubTrendingStore = create<GithubTrendingState>(
  (set, get) => ({
    timeRange: "weekly",
    cache: {},
    loading: false,
    error: null,
    setTimeRange: (range) => {
      set({ timeRange: range })
      void get().load(range, false)
    },
    load: async (range, force = false) => {
      const targetRange = range ?? get().timeRange
      const currentCache = get().cache[targetRange]

      if (!force && currentCache) {
        set({ timeRange: targetRange, error: null, loading: false })
        return
      }

      const reqId = ++activeRequestId
      set({ timeRange: targetRange, loading: true, error: null })

      try {
        const result = await githubTrending(targetRange, force)
        if (reqId !== activeRequestId) return

        set((state) => ({
          loading: false,
          error: null,
          cache: {
            ...state.cache,
            [targetRange]: {
              repos: result.repos,
              fetchedAt: result.fetched_at,
              rateLimitRemaining: result.rate_limit_remaining,
            },
          },
        }))
      } catch (err) {
        if (reqId !== activeRequestId) return
        set({
          loading: false,
          error: toErrorMessage(err),
        })
      }
    },
    refresh: async () => {
      await get().load(get().timeRange, true)
    },
    reset: () => {
      activeRequestId++
      set({
        timeRange: "weekly",
        cache: {},
        loading: false,
        error: null,
      })
    },
  })
)
