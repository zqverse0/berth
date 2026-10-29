import { describe, expect, it } from "vitest"

import {
  looksLikeFileReference,
  parseFileReference,
} from "./file-open-resolver"

describe("file-open-resolver", () => {
  describe("parseFileReference", () => {
    it("parses absolute POSIX path and strips surrounding quotes", () => {
      const parsed = parseFileReference('"/home/user/project/src/index.ts"')
      expect(parsed).not.toBeNull()
      expect(parsed?.path).toBe("/home/user/project/src/index.ts")
      expect(parsed?.isAbsolute).toBe(true)
      expect(parsed?.line).toBeUndefined()
    })

    it("parses absolute Windows path", () => {
      const parsed = parseFileReference("C:\\Users\\project\\src\\index.ts")
      expect(parsed).not.toBeNull()
      expect(parsed?.path).toBe("C:/Users/project/src/index.ts")
      expect(parsed?.isAbsolute).toBe(true)
    })

    it("parses ~ home path", () => {
      const parsed = parseFileReference("~/project/src/index.ts")
      expect(parsed).not.toBeNull()
      expect(parsed?.path).toBe("~/project/src/index.ts")
      expect(parsed?.isAbsolute).toBe(true)
    })

    it("parses relative path with directory preserving all segments", () => {
      const parsed = parseFileReference(
        "src/components/conversations/sidebar/sidebar-conversation-card.tsx"
      )
      expect(parsed).not.toBeNull()
      expect(parsed?.path).toBe(
        "src/components/conversations/sidebar/sidebar-conversation-card.tsx"
      )
      expect(parsed?.isAbsolute).toBe(false)
    })

    it("parses path with line and column :line:col", () => {
      const parsed = parseFileReference("src/lib/utils.ts:42:15")
      expect(parsed).not.toBeNull()
      expect(parsed?.path).toBe("src/lib/utils.ts")
      expect(parsed?.line).toBe(42)
      expect(parsed?.column).toBe(15)
    })

    it("parses path with line :line", () => {
      const parsed = parseFileReference("src/lib/utils.ts:88")
      expect(parsed).not.toBeNull()
      expect(parsed?.path).toBe("src/lib/utils.ts")
      expect(parsed?.line).toBe(88)
      expect(parsed?.column).toBeUndefined()
    })

    it("parses stacktrace format at (path:line:col)", () => {
      const parsed = parseFileReference("at Object.run (src/app/main.ts:100:5)")
      expect(parsed).not.toBeNull()
      expect(parsed?.path).toBe("src/app/main.ts")
      expect(parsed?.line).toBe(100)
      expect(parsed?.column).toBe(5)
    })

    it("parses file:// protocol url", () => {
      const parsed = parseFileReference("file:///home/user/code/index.html")
      expect(parsed).not.toBeNull()
      expect(parsed?.path).toBe("/home/user/code/index.html")
      expect(parsed?.isAbsolute).toBe(true)
    })

    it("returns null for web URLs and non-file strings", () => {
      expect(parseFileReference("https://example.com/api")).toBeNull()
      expect(parseFileReference("http://localhost:3000")).toBeNull()
      expect(parseFileReference("")).toBeNull()
    })
  })

  describe("looksLikeFileReference", () => {
    it("accepts paths with separators, extensions, and absolute refs", () => {
      expect(looksLikeFileReference("src/lib/utils.ts:42")).toBe(true)
      expect(looksLikeFileReference("task.json")).toBe(true)
      expect(looksLikeFileReference("src/components/launchbar")).toBe(true)
      expect(looksLikeFileReference("/tmp/output.no-enum")).toBe(true)
      expect(looksLikeFileReference("~/notes.md")).toBe(true)
      expect(looksLikeFileReference("C:\\repo\\index.ts")).toBe(true)
    })

    it("rejects ordinary text, numbers, and multiline", () => {
      expect(looksLikeFileReference("hello")).toBe(false)
      expect(looksLikeFileReference("3.14159")).toBe(false)
      expect(looksLikeFileReference("line1\nline2.ts")).toBe(false)
    })
  })
})
