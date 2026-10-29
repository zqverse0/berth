import { describe, expect, it } from "vitest"

import {
  elementSpanFromGrab,
  excerptFromGrab,
  formatElementLocationLines,
} from "./element-source"

describe("element grab source", () => {
  it("builds a bounded locator from a native grab payload", () => {
    const span = elementSpanFromGrab({
      selector: "table > tr:nth-of-type(3) > td:nth-of-type(2)",
      tagName: "TD",
      ancestorPath: ["table", "tbody", "tr"],
      nearbyText: ["Q2", "同比"],
      outerHtml: "<td>1,280</td>",
      innerText: "1,280",
    })
    expect(span).toEqual({
      unit: "element",
      selector: "table > tr:nth-of-type(3) > td:nth-of-type(2)",
      tagName: "td",
      ancestorPath: ["table", "tbody", "tr"],
      nearbyText: ["Q2", "同比"],
      htmlSnippet: "<td>1,280</td>",
    })
    expect(excerptFromGrab({ innerText: "  1,280  " })).toBe("1,280")
    expect(
      formatElementLocationLines(span!).some((line) =>
        line.includes("td:nth-of-type(2)")
      )
    ).toBe(true)
  })

  it("falls back to a tag excerpt when the node has no text", () => {
    expect(
      excerptFromGrab({ tagName: "IMG", id: "logo", innerText: "  " })
    ).toBe("<img#logo>")
  })
})
