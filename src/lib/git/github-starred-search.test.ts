import { describe, expect, it } from "vitest"
import type { GithubStarredRepo } from "@/lib/types"
import {
  filterStarredRepos,
  NO_LICENSE_SENTINEL,
  searchStarredRepos,
  sortStarredRepos,
} from "@/lib/git/github-starred-search"

function repo(
  partial: Partial<GithubStarredRepo> &
    Pick<GithubStarredRepo, "id" | "name" | "full_name">
): GithubStarredRepo {
  return {
    description: null,
    html_url: `https://github.com/${partial.full_name}`,
    clone_url: `https://github.com/${partial.full_name}.git`,
    stargazers_count: 100,
    forks_count: 10,
    language: "TypeScript",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-06-01T00:00:00Z",
    pushed_at: "2024-06-01T00:00:00Z",
    starred_at: "2024-05-01T00:00:00Z",
    owner: { login: "acme", avatar_url: "" },
    topics: [],
    license: "MIT",
    archived: false,
    ...partial,
  }
}

const sample = [
  repo({
    id: 1,
    name: "alpha",
    full_name: "acme/alpha",
    description: "offline first CRDT",
    language: "Rust",
    stargazers_count: 500,
    topics: ["database"],
    license: "MIT",
  }),
  repo({
    id: 2,
    name: "beta",
    full_name: "acme/beta",
    description: "webdav client",
    language: "TypeScript",
    stargazers_count: 50,
    topics: ["webdav"],
    license: "GPL-3.0",
    starred_at: "2024-07-01T00:00:00Z",
  }),
  repo({
    id: 3,
    name: "gamma",
    full_name: "acme/gamma",
    description: "helper",
    language: "Go",
    stargazers_count: 200,
    license: "NOASSERTION",
  }),
]

describe("searchStarredRepos", () => {
  it("matches AND of words across name description and topics", () => {
    expect(searchStarredRepos(sample, "offline crdt").map((r) => r.id)).toEqual(
      [1]
    )
  })

  it("matches topics", () => {
    expect(searchStarredRepos(sample, "database").map((r) => r.id)).toEqual([1])
  })

  it("returns all for empty query", () => {
    expect(searchStarredRepos(sample, "  ")).toHaveLength(3)
  })
})

describe("sortStarredRepos", () => {
  it("sorts by stars descending", () => {
    expect(sortStarredRepos(sample, "stars", "desc").map((r) => r.id)).toEqual([
      1, 3, 2,
    ])
  })

  it("sorts by starred_at", () => {
    expect(
      sortStarredRepos(sample, "starred", "desc").map((r) => r.id)
    ).toEqual([2, 1, 3])
  })
})

describe("filterStarredRepos", () => {
  it("filters language and license sentinel", () => {
    const hits = filterStarredRepos(sample, {
      query: "",
      languages: ["Go"],
      topics: [],
      licenses: [NO_LICENSE_SENTINEL],
      sortBy: "name",
      sortOrder: "asc",
    })
    expect(hits.map((r) => r.id)).toEqual([3])
  })

  it("filters topics", () => {
    const hits = filterStarredRepos(sample, {
      query: "",
      languages: [],
      topics: ["webdav"],
      licenses: [],
      sortBy: "stars",
      sortOrder: "desc",
    })
    expect(hits.map((r) => r.id)).toEqual([2])
  })
})
