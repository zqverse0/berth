import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { FileWorkspaceHeader } from "./file-workspace-header"
import { FileViewerRuntimeProvider } from "./file-viewer-runtime"
import { PdfPreview } from "./pdf-preview"
import { createSplitLayoutTransaction } from "@/lib/workspace/split-layout-transaction"
import { SplitLayoutTransactionProvider } from "@/lib/workspace/split-layout-transaction-context"
import type { ResourceFileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { __resetPdfSessionCacheForTests } from "@/lib/pdf/pdf-session-cache"
import {
  loadHighlights,
  saveHighlights,
  type PdfHighlight,
} from "@/lib/pdf/pdf-highlight-store"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"

const {
  closeSession,
  isLocalDesktop,
  openPath,
  openPdfDocument,
  pendingViewerRequests,
  pendingViewerRenderRequests,
  setDocumentCalls,
  translate,
  viewerInstances,
  resizeCallbacks,
} = vi.hoisted(() => ({
  closeSession: vi.fn(),
  isLocalDesktop: vi.fn(() => false),
  openPath: vi.fn(),
  openPdfDocument: vi.fn(),
  pendingViewerRequests: [] as Array<() => unknown>,
  pendingViewerRenderRequests: [] as Array<() => void>,
  setDocumentCalls: [] as unknown[],
  translate: (key: string) => key,
  viewerInstances: [] as Array<{
    currentPageNumber: number
    currentScale: number
    currentScaleValue: string
    scaleValueAssignments: string[]
  }>,
  resizeCallbacks: [] as Array<() => void>,
}))

vi.mock("next-intl", () => ({
  useTranslations: () => translate,
}))

vi.mock("@/lib/platform", () => ({
  isLocalDesktop,
  openPath,
}))

vi.mock("@/hooks/use-appearance", () => ({
  useEditorFont: () => ({
    editorWordWrap: false,
    setEditorWordWrap: vi.fn(),
  }),
}))

vi.mock("@/lib/pdf/open-pdf-document", () => ({
  openPdfDocument,
}))

vi.mock("@/lib/pdf/pdf-highlight-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/pdf/pdf-highlight-store")>()
  return {
    ...actual,
    loadHighlights: vi.fn(async () => []),
    saveHighlights: vi.fn(async () => true),
  }
})

vi.mock("pdfjs-dist", () => ({
  AbortException: class AbortException extends Error {},
}))

vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => {
  class MockEventBus {
    private listeners = new Map<string, Set<(event: never) => void>>()

    on(name: string, listener: (event: never) => void) {
      const listeners = this.listeners.get(name) ?? new Set()
      listeners.add(listener)
      this.listeners.set(name, listeners)
    }

    off(name: string, listener: (event: never) => void) {
      this.listeners.get(name)?.delete(listener)
    }

    dispatch(name: string, event: unknown) {
      this.listeners.get(name)?.forEach((listener) => listener(event as never))
    }
  }

  class MockLinkService {
    setViewer() {}
    setDocument() {}
  }

  class MockViewer {
    pagesCount = 2
    private pageNumber = 1
    private scale = 1
    private scaleValue = "1"
    scaleValueAssignments: string[] = []
    private eventBus: MockEventBus
    private abortSignal: AbortSignal | undefined
    private document: { getPage(pageNumber: number): unknown } | null = null
    private cleaned = false
    renderingQueue = {
      renderView: () => {
        if (this.cleaned || !this.document) {
          throw new Error("pdfPage is not loaded")
        }
        return true
      },
    }

    constructor({
      eventBus,
      abortSignal,
    }: {
      eventBus: MockEventBus
      abortSignal?: AbortSignal
    }) {
      this.eventBus = eventBus
      this.abortSignal = abortSignal
      viewerInstances.push(this)
    }

    setDocument(document: unknown) {
      setDocumentCalls.push(document)
      this.document = document as {
        getPage(pageNumber: number): unknown
      } | null
      if (document) {
        pendingViewerRequests.push(() => {
          this.document!.getPage(2)
        })
        pendingViewerRenderRequests.push(() => this.renderingQueue.renderView())
        this.eventBus.dispatch("pagesinit", {})
      }
    }

    cleanup() {
      void this.abortSignal
      this.cleaned = true
    }

    forceRendering() {
      if (this.cleaned) throw new Error("pdfPage is not loaded")
      return true
    }

    get currentPageNumber() {
      return this.pageNumber
    }

    set currentPageNumber(value: number) {
      this.pageNumber = value
      this.eventBus.dispatch("pagechanging", { pageNumber: value })
    }

    get currentScale() {
      return this.scale
    }

    set currentScale(value: number) {
      this.scale = value
      this.eventBus.dispatch("scalechanging", { scale: value })
    }

    get currentScaleValue() {
      return this.scaleValue
    }

    set currentScaleValue(value: string) {
      this.scaleValue = value
      this.scaleValueAssignments.push(value)
      if (value === "page-width") this.currentScale = 0.75
    }
  }

  return {
    EventBus: MockEventBus,
    PDFLinkService: MockLinkService,
    PDFViewer: MockViewer,
  }
})

function makePdfTab(path: string): ResourceFileWorkspaceTab {
  return {
    kind: "file",
    dataMode: "resource",
    id: `file:${path}`,
    folderId: null,
    title: path.split("/").pop() ?? path,
    description: null,
    path,
    loading: false,
    saveState: "idle",
    saveError: null,
    preview: { kind: "pdf", revision: 0 },
    readonly: true,
  }
}

function renderPdfSurface(
  path = "/repo/a.pdf",
  transaction?: ReturnType<typeof createSplitLayoutTransaction>,
  onTextContent?: (content: string) => void
) {
  const tab = makePdfTab(path)
  useWorkspaceFileStore.getState().insertFileTab(tab)
  const preview = (
    <PdfPreview
      file={{ rootPath: "/repo", path: path.replace(/^\/repo\//, "") }}
      sourceRevision={0}
      onTextContent={onTextContent}
    />
  )
  return render(
    <FileViewerRuntimeProvider tabId={tab.id}>
      <FileWorkspaceHeader tabId={tab.id} />
      {transaction ? (
        <SplitLayoutTransactionProvider transaction={transaction}>
          {preview}
        </SplitLayoutTransactionProvider>
      ) : (
        preview
      )}
    </FileViewerRuntimeProvider>
  )
}

describe("PdfPreview", () => {
  beforeAll(() => {
    class ResizeObserverMock {
      callback: () => void
      constructor(callback: () => void) {
        this.callback = callback
        resizeCallbacks.push(callback)
      }
      observe() {}
      disconnect() {
        const index = resizeCallbacks.indexOf(this.callback)
        if (index >= 0) resizeCallbacks.splice(index, 1)
      }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return 640
      },
    })
  })

  beforeEach(async () => {
    await __resetPdfSessionCacheForTests()
    vi.clearAllMocks()
    useWorkspaceFileStore.getState().reset()
    setDocumentCalls.length = 0
    pendingViewerRequests.length = 0
    pendingViewerRenderRequests.length = 0
    viewerInstances.length = 0
    resizeCallbacks.length = 0
    isLocalDesktop.mockReturnValue(false)
    openPdfDocument.mockResolvedValue({
      sourceVersion: "v1",
      document: {
        numPages: 2,
        getPage: async () => ({
          getTextContent: async () => ({ items: [] }),
        }),
      },
      close: closeSession,
    })
  })

  afterEach(async () => {
    await __resetPdfSessionCacheForTests()
  })

  it("loads the document and exposes page controls in the shared header", async () => {
    renderPdfSurface()

    await waitFor(() => expect(viewerInstances).toHaveLength(1))
    expect(setDocumentCalls[0]).toBeTruthy()
    expect(screen.getByText("/ 2")).toBeTruthy()
    await waitFor(() => expect(screen.getByText("75%")).toBeTruthy())

    fireEvent.click(screen.getByLabelText("pdfNext"))
    expect(viewerInstances[0].currentPageNumber).toBe(2)
    expect((screen.getByLabelText("pdfPage") as HTMLInputElement).value).toBe(
      "2"
    )
  })

  it("zooms continuously from the viewer resolved scale", async () => {
    renderPdfSurface()
    await waitFor(() => expect(screen.getByText("75%")).toBeTruthy())

    fireEvent.click(screen.getByLabelText("pdfZoomIn"))
    expect(viewerInstances[0].currentScale).toBeCloseTo(0.9)
    expect(screen.getByText("90%")).toBeTruthy()
  })

  it("opens the absolute path in the local system viewer", async () => {
    isLocalDesktop.mockReturnValue(true)
    renderPdfSurface("/repo/docs/a.pdf")

    fireEvent.click(screen.getByLabelText("pdfOpenExternal"))
    await waitFor(() =>
      expect(openPath).toHaveBeenCalledWith("/repo/docs/a.pdf")
    )
  })

  it("waits until a hidden (kept-alive) host is visible before laying out pages", async () => {
    let visible = false
    const original = HTMLElement.prototype.checkVisibility
    HTMLElement.prototype.checkVisibility = () => visible
    try {
      renderPdfSurface()
      await waitFor(() => expect(viewerInstances).toHaveLength(1))
      const viewer = viewerInstances[0]
      // 隐藏时不碰 pdf.js 的缩放 / 滚动（量不到尺寸，scrollIntoView 会抛错）
      expect(viewer.scaleValueAssignments).toHaveLength(0)

      visible = true
      act(() => {
        for (const callback of [...resizeCallbacks]) callback()
      })
      expect(viewer.scaleValueAssignments).toContain("page-width")
    } finally {
      HTMLElement.prototype.checkVisibility = original
    }
  })

  it("skips page-width refits until the split transaction commits", async () => {
    const transaction = createSplitLayoutTransaction()
    renderPdfSurface("/repo/a.pdf", transaction)
    await waitFor(() => expect(viewerInstances).toHaveLength(1))
    const viewer = viewerInstances[0]
    const before = viewer.scaleValueAssignments.length

    transaction.beginPreview()
    act(() => {
      for (const callback of [...resizeCallbacks]) callback()
    })
    expect(viewer.scaleValueAssignments.length).toBe(before)

    act(() => {
      transaction.commit({ geometry: [], reason: "divider" })
    })
    expect(
      viewer.scaleValueAssignments[viewer.scaleValueAssignments.length - 1]
    ).toBe("page-width")
    expect(viewer.scaleValueAssignments.length).toBe(before + 1)
  })

  it("reuses a warm session after switching away and back", async () => {
    const first = renderPdfSurface()
    await waitFor(() => expect(viewerInstances).toHaveLength(1))

    first.unmount()
    expect(closeSession).not.toHaveBeenCalled()

    const second = renderPdfSurface()
    await waitFor(() => expect(viewerInstances).toHaveLength(2))
    expect(openPdfDocument).toHaveBeenCalledTimes(1)

    second.unmount()
  })

  it("keeps a session alive while active text extraction is pending", async () => {
    let resolveTextContent: (() => void) | null = null
    const pendingTextContent = new Promise<void>((resolve) => {
      resolveTextContent = resolve
    })
    const documents = new Map<string, { getPage: ReturnType<typeof vi.fn> }>()
    const closeSpies = new Map<string, ReturnType<typeof vi.fn>>()
    openPdfDocument.mockImplementation(async ({ file }) => {
      let closed = false
      const close = vi.fn(async () => {
        closed = true
      })
      const document = {
        numPages: 1,
        getPage: vi.fn(async () => ({
          getTextContent: async () => {
            if (file.path === "a.pdf") await pendingTextContent
            if (closed) throw new Error("document closed")
            return { items: [] }
          },
        })),
      }
      documents.set(file.path, document)
      closeSpies.set(file.path, close)
      return { sourceVersion: "v1", document, close }
    })

    const first = renderPdfSurface("/repo/a.pdf", undefined, vi.fn())
    await waitFor(() => {
      expect(documents.get("a.pdf")).toBeDefined()
      expect(documents.get("a.pdf")?.getPage).toHaveBeenCalled()
    })

    first.unmount()
    const second = renderPdfSurface("/repo/b.pdf")
    await waitFor(() => expect(viewerInstances).toHaveLength(2))
    second.unmount()
    await act(async () => {
      await Promise.resolve()
    })

    expect(closeSpies.get("a.pdf")).not.toHaveBeenCalled()
    // 断言存在：赋值发生在异步回调里，TS 窄化为 null 报不可调用
    resolveTextContent!()
    await act(async () => {
      await Promise.resolve()
    })
  })

  it("keeps the session alive while viewer page work is pending", async () => {
    let closed = false
    const getPage = vi.fn(() => {
      if (closed) throw new Error("viewer used a closed document")
      return Promise.resolve(null)
    })
    const document = { numPages: 2, getPage }
    const close = vi.fn(async () => {
      closed = true
    })
    openPdfDocument.mockResolvedValue({
      sourceVersion: "v1",
      document,
      close,
    })

    const view = renderPdfSurface()
    await waitFor(() => expect(viewerInstances).toHaveLength(1))
    const pageRequest = pendingViewerRequests[0]()
    view.unmount()

    await pageRequest
    expect(getPage).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()

    await __resetPdfSessionCacheForTests()
  })

  it("stops queued rendering before cleaning page views", async () => {
    const view = renderPdfSurface()
    await waitFor(() => expect(viewerInstances).toHaveLength(1))
    view.unmount()

    expect(() => pendingViewerRenderRequests[0]()).not.toThrow()
  })

  it("detaches the viewer and closes the source when the cache is cleared", async () => {
    const view = renderPdfSurface()
    await waitFor(() => expect(viewerInstances).toHaveLength(1))

    view.unmount()
    expect(setDocumentCalls).toContain(null)
    expect(closeSession).not.toHaveBeenCalled()

    await __resetPdfSessionCacheForTests()
    expect(closeSession).toHaveBeenCalledTimes(1)
  })

  // 高亮链路：sidecar 加载 → 色块渲染 → 点击开注释编辑器 → 保存 / 删除持久化。
  // 选色创建高亮依赖 pointer 工具栏交互与容器 mouseup 几何捕获，由
  // pointer 插槽测试与 geometry 单测覆盖，此处聚焦加载/渲染/注释/落盘。

  function makeHighlight(overrides: Partial<PdfHighlight> = {}): PdfHighlight {
    return {
      version: 1,
      kind: "highlight",
      id: "hl-1",
      page: 1,
      rects: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.05 }],
      quote: "selected text",
      color: "yellow",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    }
  }

  /** 向 `.pdfViewer` 插入带 data-page-number 的假页面元素，供色块 portal 落点 */
  function insertFakePage(pageNumber: number) {
    act(() => {
      const viewer = document.querySelector(".pdfViewer")
      expect(viewer).not.toBeNull()
      const page = document.createElement("div")
      page.className = "page"
      page.setAttribute("data-page-number", String(pageNumber))
      page.style.position = "relative"
      page.style.width = "600px"
      page.style.height = "800px"
      viewer!.appendChild(page)
    })
  }

  it("loads sidecar highlights and renders them as blocks in the page", async () => {
    const mockLoad = vi.mocked(loadHighlights)
    mockLoad.mockResolvedValue([makeHighlight()])

    renderPdfSurface()
    await waitFor(() => expect(viewerInstances).toHaveLength(1))
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())

    insertFakePage(1)

    await waitFor(() => {
      const block = document.querySelector(".berth-pdf-highlight")
      expect(block).not.toBeNull()
      expect(block!.getAttribute("title")).toBe("selected text")
    })
  })

  it("does not open comment editor when clicking a highlight block", async () => {
    const mockLoad = vi.mocked(loadHighlights)
    mockLoad.mockResolvedValue([makeHighlight()])

    renderPdfSurface()
    await waitFor(() => expect(viewerInstances).toHaveLength(1))
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())
    insertFakePage(1)

    await waitFor(() => {
      expect(document.querySelector(".berth-pdf-highlight")).not.toBeNull()
    })
    fireEvent.click(document.querySelector(".berth-pdf-highlight")!)

    // 高亮与注释解绑，点击高亮块不会弹出注释编辑器
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("deletes a highlight when pressing Backspace on a focused highlight block", async () => {
    const mockLoad = vi.mocked(loadHighlights)
    const mockSave = vi.mocked(saveHighlights)
    mockLoad.mockResolvedValue([makeHighlight()])

    renderPdfSurface()
    await waitFor(() => expect(viewerInstances).toHaveLength(1))
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())
    insertFakePage(1)

    await waitFor(() => {
      expect(document.querySelector(".berth-pdf-highlight")).not.toBeNull()
    })
    const highlightEl = document.querySelector(".berth-pdf-highlight")!
    fireEvent.click(highlightEl)
    fireEvent.keyDown(highlightEl, { key: "Backspace" })

    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    await waitFor(() => {
      expect(document.querySelector(".berth-pdf-highlight")).toBeNull()
    })
  })

  it("deletes a note through the comment editor and persists", async () => {
    const mockLoad = vi.mocked(loadHighlights)
    const mockSave = vi.mocked(saveHighlights)
    const noteItem: PdfHighlight = {
      version: 1,
      kind: "note",
      id: "note-1",
      page: 1,
      rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.04 }],
      quote: "annotated text",
      comment: "to be deleted",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    mockLoad.mockResolvedValue([noteItem])

    renderPdfSurface()
    await waitFor(() => expect(viewerInstances).toHaveLength(1))
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())
    insertFakePage(1)

    await waitFor(() => {
      expect(document.querySelector(".berth-pdf-note-underline")).not.toBeNull()
    })
    fireEvent.click(document.querySelector(".berth-pdf-note-underline")!)
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy()
    })

    fireEvent.click(screen.getByText("pdfHighlightCommentDelete"))

    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(document.querySelector(".berth-pdf-note-underline")).toBeNull()
    })
  })

  it("loads note items, renders them as underlines, and opens note card on click", async () => {
    const mockLoad = vi.mocked(loadHighlights)
    const mockSave = vi.mocked(saveHighlights)
    const noteItem: PdfHighlight = {
      version: 1,
      kind: "note",
      id: "note-1",
      page: 1,
      rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.04 }],
      quote: "annotated text",
      comment: "this is an important note",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    mockLoad.mockResolvedValue([noteItem])

    renderPdfSurface()
    await waitFor(() => expect(viewerInstances).toHaveLength(1))
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())
    insertFakePage(1)

    await waitFor(() => {
      const underline = document.querySelector(".berth-pdf-note-underline")
      expect(underline).not.toBeNull()
      expect(underline!.getAttribute("title")).toBe("this is an important note")
    })

    // 点击下划线打开查看卡片
    fireEvent.click(document.querySelector(".berth-pdf-note-underline")!)
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy()
      expect(screen.getByText("this is an important note")).toBeTruthy()
      expect(screen.getByText("pdfCommentEdit")).toBeTruthy()
    })

    // 点击编辑切换到编辑态并保存
    fireEvent.click(screen.getByText("pdfCommentEdit"))
    const textarea = screen.getByRole("textbox")
    expect((textarea as HTMLTextAreaElement).value).toBe(
      "this is an important note"
    )
    fireEvent.change(textarea, { target: { value: "updated note content" } })
    fireEvent.click(screen.getByText("pdfHighlightCommentSave"))

    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("closes the note editor when clicking outside the dialog", async () => {
    const mockLoad = vi.mocked(loadHighlights)
    const noteItem: PdfHighlight = {
      version: 1,
      kind: "note",
      id: "note-outside",
      page: 1,
      rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.04 }],
      quote: "annotated text",
      comment: "outside test note",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    mockLoad.mockResolvedValue([noteItem])

    renderPdfSurface()
    await waitFor(() => expect(viewerInstances).toHaveLength(1))
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())
    insertFakePage(1)

    await waitFor(() => {
      expect(document.querySelector(".berth-pdf-note-underline")).not.toBeNull()
    })
    fireEvent.click(document.querySelector(".berth-pdf-note-underline")!)
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy()
    })

    // 等待一帧让 pointerdown 监听器就绪后，点击外部区域关闭
    await new Promise((resolve) => setTimeout(resolve, 10))
    fireEvent.pointerDown(document.body)

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })
  })
})
