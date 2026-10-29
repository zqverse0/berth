import type { GithubStarredRepo } from "@/lib/types"

export const NO_LICENSE_SENTINEL = "__NO_LICENSE__"

const NO_LICENSE_KEYS = new Set([
  "",
  "noassertion",
  "other",
  "none",
  "no-license",
])

export type StarredSortBy = "stars" | "updated" | "name" | "starred"
export type StarredSortOrder = "asc" | "desc"

export interface StarredSearchOptions {
  query: string
  languages: string[]
  topics: string[]
  licenses: string[]
  sortBy: StarredSortBy
  sortOrder: StarredSortOrder
}

export function normalizeLicense(value: string | null | undefined): string {
  if (value == null) return NO_LICENSE_SENTINEL
  const trimmed = value.trim()
  if (!trimmed || NO_LICENSE_KEYS.has(trimmed.toLowerCase())) {
    return NO_LICENSE_SENTINEL
  }
  return trimmed
}

export function searchStarredRepos(
  repos: GithubStarredRepo[],
  query: string
): GithubStarredRepo[] {
  const normalizedQuery = query.toLowerCase().trim()
  if (!normalizedQuery) return repos
  const words = normalizedQuery.split(/\s+/).filter(Boolean)
  return repos.filter((repo) => {
    const name = repo.name.toLowerCase()
    const fullName = repo.full_name.toLowerCase()
    const desc = repo.description ? repo.description.toLowerCase() : ""
    const lang = repo.language ? repo.language.toLowerCase() : ""
    const license = normalizeLicense(repo.license).toLowerCase()
    const topics = repo.topics

    return words.every(
      (word) =>
        name.includes(word) ||
        fullName.includes(word) ||
        desc.includes(word) ||
        lang.includes(word) ||
        license.includes(word) ||
        topics.some((topic) => topic.toLowerCase().includes(word))
    )
  })
}

function sortValue(
  repo: GithubStarredRepo,
  sortBy: StarredSortBy
): number | string {
  switch (sortBy) {
    case "stars":
      return repo.stargazers_count
    case "name":
      return repo.name.toLowerCase()
    case "starred":
      return repo.starred_at ? Date.parse(repo.starred_at) : 0
    case "updated":
    default:
      return Date.parse(repo.pushed_at || repo.updated_at || "") || 0
  }
}

export function sortStarredRepos(
  repos: GithubStarredRepo[],
  sortBy: StarredSortBy = "stars",
  sortOrder: StarredSortOrder = "desc"
): GithubStarredRepo[] {
  return [...repos].sort((a, b) => {
    const av = sortValue(a, sortBy)
    const bv = sortValue(b, sortBy)
    if (av < bv) return sortOrder === "desc" ? 1 : -1
    if (av > bv) return sortOrder === "desc" ? -1 : 1
    return 0
  })
}

export function filterStarredRepos(
  repos: GithubStarredRepo[],
  options: StarredSearchOptions
): GithubStarredRepo[] {
  let filtered = searchStarredRepos(repos, options.query)
  if (options.languages.length > 0) {
    filtered = filtered.filter(
      (repo) =>
        repo.language != null && options.languages.includes(repo.language)
    )
  }
  if (options.topics.length > 0) {
    filtered = filtered.filter((repo) =>
      options.topics.some((topic) => repo.topics.includes(topic))
    )
  }
  if (options.licenses.length > 0) {
    filtered = filtered.filter((repo) =>
      options.licenses.includes(normalizeLicense(repo.license))
    )
  }
  return sortStarredRepos(filtered, options.sortBy, options.sortOrder)
}

export function uniqueValues(
  values: Array<string | null | undefined>
): string[] {
  const set = new Set<string>()
  for (const value of values) {
    if (value && value.trim()) set.add(value)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}
