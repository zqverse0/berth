import { describe, expect, it } from "vitest"
import { inlineCodePathUrl } from "./remark-inline-code-paths"

describe("inlineCodePathUrl", () => {
  it.each([
    ["src/a.ts", "berth://path/src/a.ts"],
    ["README.md", "berth://path/README.md"],
    ["a.ts:12", "berth://path/a.ts#L12"],
    ["a.ts:12:5", "berth://path/a.ts#L12"],
    ["src/a.rs:12-20", "berth://path/src/a.rs#L12"],
    ["a.ts#L12-L20", "berth://path/a.ts#L12"],
    ["/abs/x.py", "/abs/x.py"],
    ["~/notes/x.md", "~/notes/x.md"],
    ["../up/x.go", "../up/x.go"],
    [".berth/tasks/x/prd.md", "berth://path/.berth/tasks/x/prd.md"],
    ["./x/y.ts", "berth://path/x/y.ts"],
  ])("%s → %s", (value, url) => {
    expect(inlineCodePathUrl(value)).toBe(url)
  })

  it.each([
    ["console.log"],
    ["group.refresh()"],
    ["npm run dev"],
    ["https://x.com/a.md"],
    ["src/*.ts"],
    ["@/lib/utils"],
    ["useState"],
  ])("leaves %s alone", (value) => {
    expect(inlineCodePathUrl(value)).toBeNull()
  })
})
