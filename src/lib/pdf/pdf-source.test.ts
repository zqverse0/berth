import { afterEach, describe, expect, it, vi } from "vitest"

const call = vi.fn()

vi.mock("@/lib/transport", () => ({
  isDesktop: () => true,
  getTransport: () => ({ call }),
}))

import { openPdfSource } from "./pdf-source"

afterEach(() => {
  call.mockReset()
})

describe("openPdfSource", () => {
  it("opens a local desktop PDF as a range source", async () => {
    call
      .mockResolvedValueOnce({
        sourceId: "src-1",
        length: 4,
        sourceVersion: "v1",
      })
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3, 4]))
      .mockResolvedValueOnce(undefined)

    const source = await openPdfSource({ rootPath: "/repo", path: "a.pdf" })
    expect(source.kind).toBe("range")
    if (source.kind !== "range") throw new Error("expected range source")
    const bytes = await source.read(0, 4, new AbortController().signal)
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4])
    expect(source.length).toBe(4)

    await source.close()
    expect(call).toHaveBeenNthCalledWith(1, "open_local_pdf_source", {
      rootPath: "/repo",
      path: "a.pdf",
    })
    expect(call).toHaveBeenNthCalledWith(2, "read_local_pdf_range", {
      sourceId: "src-1",
      begin: 0,
      end: 4,
    })
    expect(call).toHaveBeenNthCalledWith(3, "close_local_pdf_source", {
      sourceId: "src-1",
    })
  })
})
