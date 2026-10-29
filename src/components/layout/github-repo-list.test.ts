import { describe, expect, it } from "vitest"
import { githubRepoReference } from "@/components/layout/github-repo-list"

describe("githubRepoReference", () => {
  it("is a single line with no Enter so a paste can never submit or split", () => {
    const text = githubRepoReference({
      full_name: "acme/demo",
      html_url: "https://github.com/acme/demo",
      description: "First line\r\nsecond  line\n",
    })
    expect(text).toBe(
      "acme/demo (https://github.com/acme/demo) — First line second line "
    )
    expect(text).not.toMatch(/[\r\n]/)
  })
})
