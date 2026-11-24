import { describe, expect, it } from "vitest"
import {
  mentionChoices,
  mentionQueryAt,
  mentionRanges,
  resolveMentions,
} from "./mentions"

const peers = [
  { id: "arch", name: "架构顾问" },
  { id: "dev", name: "Dev" },
  { id: "dev2", name: "dev" },
]

describe("group mentions", () => {
  it("opens the @ list only at a word start", () => {
    expect(mentionQueryAt("hi @De", 6)).toEqual({ start: 3, query: "De" })
    expect(mentionQueryAt("（@架", 3)).toEqual({ start: 1, query: "架" })
    expect(mentionQueryAt("a@b", 3)).toBeNull()
    expect(mentionQueryAt("@a\nb", 4)).toBeNull()
  })

  it("filters choices and closes after a full name and a space", () => {
    expect(mentionChoices(peers, "ev").map((p) => p.id)).toEqual([
      "dev",
      "dev2",
    ])
    expect(mentionChoices(peers, "架构顾问 ")).toEqual([])
  })

  it("highlights known names and @everyone, not name prefixes", () => {
    const text = "@架构顾问 看下 @everyone @Devops"
    expect(
      mentionRanges(text, peers).map((r) => text.slice(r.start, r.end))
    ).toEqual(["@架构顾问", "@everyone"])
  })

  it("resolves recipients; a shared name needs a pick from the list", () => {
    expect(resolveMentions("@架构顾问 你好", peers)).toEqual({
      everyone: false,
      ids: ["arch"],
      ambiguous: [],
    })
    expect(resolveMentions("@dev 看下", peers).ambiguous).toEqual(["Dev"])
    expect(resolveMentions("@dev 看下", peers, ["dev2"]).ids).toEqual(["dev2"])
    expect(resolveMentions("@everyone", peers).everyone).toBe(true)
  })
})
