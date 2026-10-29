import { render } from "@testing-library/react"
import { describe, expect, it, vi, afterEach } from "vitest"
import {
  DOCUMENT_FRAME_CONTEXT_MESSAGE,
  type DocumentFrameContextMessage,
} from "@/lib/document-context/frame-bridge"
import {
  PreviewSelectionLayer,
  sourceLinesSpan,
} from "./preview-selection-layer"

vi.mock("@/contexts/document-context", () => ({
  useDocumentContext: () => ({
    registerDocument: vi.fn(),
  }),
}))
vi.mock("@/stores/app-workspace-store", () => ({
  // selector 协议：useAppWorkspaceStore((s) => s.allFolders)
  useAppWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({ allFolders: [{ id: 1, path: "/repo" }] }),
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

// pointer 桩：捕获 reportSelection / showMenu 调用
const showMenu = vi.fn()
const reportSelection = vi.fn()

vi.mock("../provider", () => ({
  useOptionalPointer: () => ({ reportSelection, showMenu }),
}))

function frameMessage(
  event: DocumentFrameContextMessage["event"],
  extra: Partial<DocumentFrameContextMessage> = {}
): DocumentFrameContextMessage {
  return {
    type: DOCUMENT_FRAME_CONTEXT_MESSAGE,
    event,
    generation: "gen-1",
    url: "about:srcdoc",
    text: "selected text",
    ...extra,
  }
}

// 让容器里出现一个 iframe，其 contentWindow 即消息的 source。真实运行时
// 桥在 iframe load 后必发 document 事件（登记 generation），之后才是
// selection / contextmenu —— 测试按同一顺序驱动。
function renderLayerWithFrame() {
  const layer = render(
    <PreviewSelectionLayer absolutePath="/repo/a.html" fileName="a.html">
      <div>content</div>
    </PreviewSelectionLayer>
  )
  const container = layer.getByText("content").parentElement as HTMLElement
  const iframe = document.createElement("iframe")
  container.appendChild(iframe)
  const source = iframe.contentWindow
  window.dispatchEvent(
    new MessageEvent("message", {
      data: frameMessage("document", { text: null, content: "body" }),
      source,
    })
  )
  return { layer, container, iframe, source }
}

function dispatch(source: MessageEventSource | null, message: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data: message, source }))
}

describe("PreviewSelectionLayer contextmenu 坐标", () => {
  afterEach(() => {
    showMenu.mockClear()
    reportSelection.mockClear()
    vi.clearAllMocks()
  })

  it("把沙箱内右键坐标换算成父页视口坐标并 showMenu（不钉顶）", () => {
    const { iframe, source } = renderLayerWithFrame()
    const rectSpy = vi.spyOn(iframe, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 200,
      width: 600,
      height: 400,
      right: 700,
      bottom: 600,
      x: 100,
      y: 200,
      toJSON: () => ({}),
    } as DOMRect)

    dispatch(source, frameMessage("contextmenu", { clientX: 30, clientY: 42 }))

    expect(showMenu).toHaveBeenCalledTimes(1)
    const [selection, position, options] = showMenu.mock.calls[0]
    expect(selection.excerpt).toBe("selected text")
    expect(position).toEqual({ x: 130, y: 242 })
    // 关键契约：不强制朝向、不传 minTop —— 胶囊锚在选区旁
    expect(options).toBeUndefined()
    rectSpy.mockRestore()
  })

  it("坐标缺失时退到 iframe 左上角，仍不 forcePlacement", () => {
    const { source } = renderLayerWithFrame()
    dispatch(
      source,
      frameMessage("contextmenu", { clientX: null, clientY: null })
    )
    const [, position, options] = showMenu.mock.calls[0]
    expect(options).toBeUndefined()
    expect(typeof position.x).toBe("number")
  })

  it("普通 selection 事件不触发 showMenu", () => {
    const { source } = renderLayerWithFrame()
    dispatch(source, frameMessage("selection"))
    expect(showMenu).not.toHaveBeenCalled()
    expect(reportSelection).toHaveBeenCalled()
  })

  it("非本容器 iframe 的消息被忽略", () => {
    renderLayerWithFrame()
    const alien = document.createElement("iframe")
    document.body.appendChild(alien)
    dispatch(
      alien.contentWindow,
      frameMessage("contextmenu", { clientX: 1, clientY: 1 })
    )
    expect(showMenu).not.toHaveBeenCalled()
  })

  it("pointer 上下文重建（菜单开合）不作废已登记的 generation", () => {
    const { layer, source } = renderLayerWithFrame()
    // 桩每次渲染返回新对象，等价于 provider 的 value 随 menu 变化重建。
    layer.rerender(
      <PreviewSelectionLayer absolutePath="/repo/a.html" fileName="a.html">
        <div>content</div>
      </PreviewSelectionLayer>
    )
    dispatch(source, frameMessage("contextmenu", { clientX: 1, clientY: 1 }))
    expect(showMenu).toHaveBeenCalledTimes(1)
  })

  it("generation 不匹配的 contextmenu 被忽略", () => {
    const { source } = renderLayerWithFrame()
    dispatch(
      source,
      frameMessage("contextmenu", {
        generation: "stale",
        clientX: 1,
        clientY: 1,
      })
    )
    expect(showMenu).not.toHaveBeenCalled()
  })
})

describe("sourceLinesSpan", () => {
  it("merges line anchors and ranges into one span", () => {
    expect(sourceLinesSpan(["5-8"])).toEqual({
      unit: "lines",
      start: 5,
      end: 8,
    })
    expect(sourceLinesSpan(["12", "3", "7-9"])).toEqual({
      unit: "lines",
      start: 3,
      end: 12,
    })
  })

  it("ignores non-line anchors and returns nothing without valid ones", () => {
    expect(sourceLinesSpan(["/body/p[1]", "4"])).toEqual({
      unit: "lines",
      start: 4,
      end: 4,
    })
    expect(sourceLinesSpan(["/body/p[1]", "0"])).toBeUndefined()
    expect(sourceLinesSpan(null)).toBeUndefined()
  })
})
