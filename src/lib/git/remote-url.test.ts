import { describe, expect, it } from "vitest"
import { remoteWebUrl } from "@/lib/git/remote-url"

describe("remoteWebUrl", () => {
  it.each([
    ["git@github.com:zqverse0/berth.git", "https://github.com/zqverse0/berth"],
    ["ssh://git@github.com:22/o/r.git", "https://github.com/o/r"],
    ["https://user@gitlab.com/o/r.git", "https://gitlab.com/o/r"],
    ["http://host/o/r", "http://host/o/r"],
    ["/srv/git/repo.git", null],
    ["file:///srv/git/repo.git", null],
  ])("%s -> %s", (input, expected) => {
    expect(remoteWebUrl(input)).toBe(expected)
  })
})
