import { beforeEach, describe, expect, it, vi } from "vitest"

const destroyTask = vi.fn()
const closeSource = vi.fn()
const getPage = vi.fn()
const { getDocument, openPdfSource } = vi.hoisted(() => ({
  getDocument: vi.fn(),
  openPdfSource: vi.fn(),
}))

vi.mock("./pdf-source", () => ({
  openPdfSource,
}))

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  PDFDataRangeTransport: class {},
  getDocument,
}))

describe("openPdfDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage,
      }),
      destroy: destroyTask,
    })
    getPage.mockResolvedValue({
      getViewport: () => ({ width: 100, height: 100 }),
      render: () => ({
        promise: Promise.resolve(),
        cancel: () => undefined,
      }),
    })
    openPdfSource.mockResolvedValue({
      kind: "url",
      url: "/preview.pdf",
      length: 10,
      sourceVersion: "v1",
      close: closeSource,
    })
  })

  it("closes the loading task, document and source exactly once", async () => {
    const { openPdfDocument } = await import("./open-pdf-document")
    const session = await openPdfDocument({
      file: { rootPath: "/repo", path: "a.pdf" },
      revision: 0,
      signal: new AbortController().signal,
      requestPassword: async () => null,
    })
    await session.close()
    await session.close()
    expect(destroyTask).toHaveBeenCalledTimes(1)
    expect(closeSource).toHaveBeenCalledTimes(1)
  })

  it("waits for pending page requests before destroying the worker", async () => {
    let finishPage: (() => void) | undefined
    getPage.mockReturnValueOnce(
      new Promise((resolve) => {
        finishPage = () =>
          resolve({
            getTextContent: vi.fn(),
            render: vi.fn(),
          })
      })
    )
    const { openPdfDocument } = await import("./open-pdf-document")
    const session = await openPdfDocument({
      file: { rootPath: "/repo", path: "a.pdf" },
      revision: 0,
      signal: new AbortController().signal,
      requestPassword: async () => null,
    })

    const pageRequest = session.document.getPage(1)
    const closing = session.close()
    await Promise.resolve()
    expect(destroyTask).not.toHaveBeenCalled()

    finishPage?.()
    await pageRequest
    await closing
    expect(destroyTask).toHaveBeenCalledTimes(1)
  })

  it("waits for pending page rendering before destroying the worker", async () => {
    let finishRendering: (() => void) | undefined
    const renderPromise = new Promise<void>((resolve) => {
      finishRendering = resolve
    })
    getPage.mockResolvedValueOnce({
      getTextContent: vi.fn(),
      render: vi.fn(() => ({ promise: renderPromise })),
    })
    const { openPdfDocument } = await import("./open-pdf-document")
    const session = await openPdfDocument({
      file: { rootPath: "/repo", path: "a.pdf" },
      revision: 0,
      signal: new AbortController().signal,
      requestPassword: async () => null,
    })

    const page = await session.document.getPage(1)
    page.render({} as never)
    const closing = session.close()
    await Promise.resolve()
    expect(destroyTask).not.toHaveBeenCalled()

    finishRendering?.()
    await closing
    expect(destroyTask).toHaveBeenCalledTimes(1)
  })

  it("does not destroy an opened worker directly when its signal aborts", async () => {
    const controller = new AbortController()
    const { openPdfDocument } = await import("./open-pdf-document")
    const session = await openPdfDocument({
      file: { rootPath: "/repo", path: "a.pdf" },
      revision: 0,
      signal: controller.signal,
      requestPassword: async () => null,
    })

    controller.abort()
    await Promise.resolve()
    expect(destroyTask).not.toHaveBeenCalled()
    await session.close()
    expect(destroyTask).toHaveBeenCalledTimes(1)
  })

  it("uses bounded range loading without automatic prefetch", async () => {
    openPdfSource.mockResolvedValue({
      kind: "range",
      length: 10,
      sourceVersion: "v1",
      read: vi.fn(),
      close: closeSource,
    })
    const { openPdfDocument } = await import("./open-pdf-document")

    const session = await openPdfDocument({
      file: { rootPath: "/repo", path: "a.pdf" },
      revision: 0,
      signal: new AbortController().signal,
      requestPassword: async () => null,
    })

    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        range: expect.anything(),
        length: 10,
        disableStream: true,
        disableAutoFetch: true,
        rangeChunkSize: 256 * 1024,
      })
    )
    await session.close()
  })

  it("recreates an expired source once during initial loading", async () => {
    openPdfSource
      .mockRejectedValueOnce(new Error("PDF lease failed: 410"))
      .mockResolvedValueOnce({
        kind: "url",
        url: "/preview.pdf",
        length: 10,
        sourceVersion: "v2",
        close: closeSource,
      })
    const { openPdfDocument } = await import("./open-pdf-document")
    const session = await openPdfDocument({
      file: { rootPath: "/repo", path: "a.pdf" },
      revision: 0,
      signal: new AbortController().signal,
      requestPassword: async () => null,
    })
    expect(openPdfSource).toHaveBeenCalledTimes(2)
    expect(session.sourceVersion).toBe("v2")
    await session.close()
  })
})
