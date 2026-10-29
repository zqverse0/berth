import { describe, expect, it } from "vitest"
import type { GithubStarredRepo } from "@/lib/types"
import { VIRTUAL_PREVIEW_ROOT } from "@/lib/files/file-open-target"
import {
  githubStarredPreviewId,
  githubStarredPreviewMetaFromPath,
  isGithubStarredPreviewPath,
  rememberGithubStarredPreview,
  resolveGithubReadmeRelativeUrls,
} from "@/lib/git/github-starred-preview"

const repo: GithubStarredRepo = {
  id: 1,
  name: "alpha",
  full_name: "acme/alpha",
  description: null,
  html_url: "https://github.com/acme/alpha",
  clone_url: "https://github.com/acme/alpha.git",
  stargazers_count: 1,
  forks_count: 0,
  language: "Rust",
  created_at: null,
  updated_at: null,
  pushed_at: null,
  starred_at: null,
  owner: { login: "acme", avatar_url: "" },
  topics: [],
  license: null,
  archived: false,
}

describe("github starred preview identity", () => {
  it("round-trips meta through the virtual preview path", () => {
    rememberGithubStarredPreview(repo)
    const id = githubStarredPreviewId(repo.full_name)
    const virtualPath = `${VIRTUAL_PREVIEW_ROOT}/${encodeURIComponent(id)}/README.md`
    expect(githubStarredPreviewMetaFromPath(virtualPath)).toEqual({
      full_name: "acme/alpha",
      name: "alpha",
      html_url: "https://github.com/acme/alpha",
      clone_url: "https://github.com/acme/alpha.git",
    })
  })

  it("ignores ordinary files", () => {
    expect(githubStarredPreviewMetaFromPath("/home/user/README.md")).toBeNull()
    expect(isGithubStarredPreviewPath("/home/user/README.md")).toBe(false)
  })
})

describe("resolveGithubReadmeRelativeUrls", () => {
  it("rewrites markdown relative image urls to raw GitHub CDN", () => {
    const input =
      '![banner](./docs/banner.png)\n![logo](assets/logo.svg "Logo")'
    const output = resolveGithubReadmeRelativeUrls(input, "acme/alpha")
    expect(output).toBe(
      '![banner](https://raw.githubusercontent.com/acme/alpha/HEAD/docs/banner.png)\n![logo](https://raw.githubusercontent.com/acme/alpha/HEAD/assets/logo.svg "Logo")'
    )
  })

  it("rewrites html img and source tags", () => {
    const input =
      '<img src="./images/screenshot.png" alt="Demo" width="500" />\n<source srcset="assets/dark.png" />'
    const output = resolveGithubReadmeRelativeUrls(input, "acme/alpha")
    expect(output).toBe(
      '<img src="https://raw.githubusercontent.com/acme/alpha/HEAD/images/screenshot.png" alt="Demo" width="500" />\n<source srcset="https://raw.githubusercontent.com/acme/alpha/HEAD/assets/dark.png" />'
    )
  })

  it("rewrites relative hyperlinks to GitHub blob urls", () => {
    const input =
      '[Docs](docs/guide.md)\n<a href="CONTRIBUTING.md">Contributing</a>'
    const output = resolveGithubReadmeRelativeUrls(input, "acme/alpha")
    expect(output).toBe(
      '[Docs](https://github.com/acme/alpha/blob/HEAD/docs/guide.md)\n<a href="https://github.com/acme/alpha/blob/HEAD/CONTRIBUTING.md">Contributing</a>'
    )
  })

  it("preserves absolute urls and anchor links", () => {
    const input =
      "[External](https://example.com)\n![Shield](https://img.shields.io/badge/test-green)\n[Anchor](#section)"
    const output = resolveGithubReadmeRelativeUrls(input, "acme/alpha")
    expect(output).toBe(input)
  })

  it("handles empty and edge cases gracefully", () => {
    expect(resolveGithubReadmeRelativeUrls("", "acme/alpha")).toBe("")
    expect(resolveGithubReadmeRelativeUrls("plain text", "")).toBe("plain text")
  })
})
