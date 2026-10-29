import { describe, expect, it } from "vitest"
import { isHttpDocumentUrl, normalizeWebReaderUrl } from "./web-document"

describe("web document helpers", () => {
  it("accepts public HTTP(S) shaped URLs and rejects unsafe schemes", () => {
    expect(isHttpDocumentUrl("https://docs.example.com/guide/")).toBe(true)
    expect(isHttpDocumentUrl("http://docs.example.com/page")).toBe(true)
    expect(isHttpDocumentUrl("file:///tmp/docs")).toBe(false)
    expect(isHttpDocumentUrl("javascript:alert(1)")).toBe(false)
    expect(isHttpDocumentUrl("https://user:pass@example.com/docs")).toBe(false)
  })

  it("normalizes a safe URL for the web reader", () => {
    expect(normalizeWebReaderUrl(" https://docs.example.com/guide ")).toBe(
      "https://docs.example.com/guide"
    )
    expect(normalizeWebReaderUrl("javascript:alert(1)")).toBeNull()
  })
})
