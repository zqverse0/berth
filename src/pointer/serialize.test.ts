import { describe, expect, it } from "vitest"

import { parseSourceFromHtml, encodeSourceHtml } from "./clipboard"
import {
  normalizeSourceRef,
  parseSourcePayload,
  serializeSourcePlain,
  sourceBadgeLabel,
  sourceToPayload,
} from "./serialize"

describe("serializeSourcePlain", () => {
  it("writes file lines", () => {
    expect(
      serializeSourcePlain({
        identity: { type: "file", path: "src/foo.ts" },
        span: { unit: "lines", start: 12, end: 20 },
        excerpt: "const x = 1",
      })
    ).toBe("File: `src/foo.ts` L12–20\n---\nconst x = 1")
  })

  it("writes a single line and a page", () => {
    expect(
      serializeSourcePlain({
        identity: { type: "file", path: "src/foo.ts" },
        span: { unit: "lines", start: 3, end: 3 },
        excerpt: "a",
      })
    ).toBe("File: `src/foo.ts` L3\n---\na")
    expect(
      serializeSourcePlain({
        identity: { type: "file", path: "paper.pdf" },
        span: { unit: "page", page: 5 },
        excerpt: "abstract",
      })
    ).toBe("File: `paper.pdf` Page 5\n---\nabstract")
  })

  it("writes an element locator for HTML/Office preview grabs", () => {
    expect(
      serializeSourcePlain({
        identity: { type: "file", path: "reports/q3.docx" },
        span: {
          unit: "element",
          selector: "table > tr:nth-of-type(3) > td:nth-of-type(2)",
          tagName: "td",
          ancestorPath: ["table", "tr"],
          nearbyText: ["Q2 营收"],
        },
        excerpt: "1,280",
      })
    ).toBe(
      [
        "File: `reports/q3.docx`",
        "Selector: `table > tr:nth-of-type(3) > td:nth-of-type(2)`",
        "Tag: <td>",
        "Ancestor: table > tr",
        "Nearby:",
        "- Q2 营收",
        "---",
        "1,280",
      ].join("\n")
    )
  })

  it("writes a real https URL", () => {
    expect(
      serializeSourcePlain({
        identity: {
          type: "url",
          url: "https://example.com/docs",
          title: "Docs",
        },
        excerpt: "hello",
      })
    ).toBe("URL: https://example.com/docs\nTitle: Docs\n---\nhello")
  })

  it("does not mention get_current_document_content", () => {
    const text = serializeSourcePlain({
      identity: { type: "url", url: "https://example.com" },
      excerpt: "x",
    })
    expect(text).not.toContain("get_current_document")
    expect(text).not.toContain("Selected context for you to inspect")
  })

  it("writes terminal identity and excerpt without the live buffer", () => {
    expect(
      serializeSourcePlain({
        identity: {
          type: "terminal",
          backendInstanceId: "backend-a",
          terminalId: "term-1",
          pane: { session: "7", window: "term-1", index: 0 },
          cwd: "/repo",
          title: "codex",
        },
        excerpt: "npm test",
      })
    ).toBe(
      "Terminal: codex (/repo)\nBackend: backend-a\nPane: 7:term-1.0\n---\nnpm test"
    )
  })
})

describe("source payload", () => {
  it("round-trips JSON and HTML", () => {
    const ref = normalizeSourceRef({
      identity: { type: "file", path: "/abs/a.ts" },
      span: { unit: "lines", start: 2, end: 1 },
      excerpt: "  hi  \n",
    })
    expect(ref?.span).toEqual({ unit: "lines", start: 1, end: 2 })
    const payload = sourceToPayload(ref!)
    expect(parseSourcePayload(payload)).toEqual(ref)
    expect(parseSourceFromHtml(encodeSourceHtml(ref!))).toEqual(ref)
  })

  it("round-trips an element locator", () => {
    const ref = normalizeSourceRef({
      identity: { type: "file", path: "/repo/q3.docx" },
      span: {
        unit: "element",
        selector: " td.amount ",
        tagName: "TD",
        ancestorPath: ["table", "tr"],
        nearbyText: ["Q2"],
        htmlSnippet: '<td class="amount">1</td>',
      },
      excerpt: "1",
    })
    expect(ref?.span).toEqual({
      unit: "element",
      selector: "td.amount",
      tagName: "td",
      ancestorPath: ["table", "tr"],
      nearbyText: ["Q2"],
      htmlSnippet: '<td class="amount">1</td>',
    })
    expect(parseSourcePayload(sourceToPayload(ref!))).toEqual(ref)
  })

  it("round-trips an officecli element path", () => {
    const ref = normalizeSourceRef({
      identity: { type: "file", path: "/repo/deck.pptx" },
      span: {
        unit: "office",
        paths: [" /slide[1]/shape[@id=12] ", "", "/slide[1]/picture[@id=2]"],
      },
      excerpt: "组会汇报",
    })
    expect(ref?.span).toEqual({
      unit: "office",
      paths: ["/slide[1]/shape[@id=12]", "/slide[1]/picture[@id=2]"],
    })
    expect(parseSourcePayload(sourceToPayload(ref!))).toEqual(ref)
    expect(serializeSourcePlain(ref!)).toBe(
      "File: `/repo/deck.pptx`\nElements: `/slide[1]/shape[@id=12]`, `/slide[1]/picture[@id=2]` (preview element paths)\n---\n组会汇报"
    )
    expect(sourceBadgeLabel(ref!)).toBe(
      "deck.pptx · /slide[1]/shape[@id=12] +1"
    )
  })

  it("rejects empty excerpt and unknown versions", () => {
    expect(
      normalizeSourceRef({
        identity: { type: "file", path: "a.ts" },
        excerpt: "   ",
      })
    ).toBeNull()
    expect(
      parseSourcePayload({
        v: 2,
        identity: { type: "file", path: "a" },
        excerpt: "x",
      })
    ).toBeNull()
  })

  it("round-trips a terminal identity", () => {
    const ref = normalizeSourceRef({
      identity: {
        type: "terminal",
        backendInstanceId: " backend-a ",
        terminalId: " term-1 ",
        pane: { session: " 7 ", window: " term-1 ", index: 0.2 },
        cwd: " /repo ",
        title: " shell ",
      },
      excerpt: " ls\n",
    })
    expect(ref).toEqual({
      identity: {
        type: "terminal",
        backendInstanceId: "backend-a",
        terminalId: "term-1",
        pane: { session: "7", window: "term-1", index: 0 },
        cwd: "/repo",
        title: "shell",
      },
      excerpt: " ls",
    })
    expect(parseSourcePayload(sourceToPayload(ref!))).toEqual(ref)
    expect(parseSourceFromHtml(encodeSourceHtml(ref!))).toEqual(ref)
  })

  it("rejects a terminal identity without a pane target", () => {
    expect(
      normalizeSourceRef({
        identity: {
          type: "terminal",
          backendInstanceId: "backend-a",
          terminalId: "term-1",
          pane: { session: "", window: "term-1", index: 0 },
        },
        excerpt: "ls",
      })
    ).toBeNull()
  })

  it("labels file ranges and pages", () => {
    expect(
      sourceBadgeLabel({
        identity: { type: "file", path: "/x/foo.ts" },
        span: { unit: "lines", start: 10, end: 25 },
        excerpt: "x",
      })
    ).toBe("foo.ts:10-25")
    expect(
      sourceBadgeLabel({
        identity: { type: "file", path: "paper.pdf" },
        span: { unit: "page", page: 5 },
        excerpt: "x",
      })
    ).toBe("paper.pdf:p5")
    expect(
      sourceBadgeLabel({
        identity: { type: "file", path: "reports/q3.docx" },
        span: {
          unit: "element",
          selector: "td",
          tagName: "td",
        },
        excerpt: "1,280",
      })
    ).toBe("q3.docx · td")
    expect(
      sourceBadgeLabel({
        identity: {
          type: "terminal",
          backendInstanceId: "backend-a",
          terminalId: "term-1",
          pane: { session: "7", window: "term-1", index: 0 },
          title: "codex",
        },
        excerpt: "x",
      })
    ).toBe("codex")
  })
})
