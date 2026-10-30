import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FileWorkspaceHeader } from "./file-workspace-header"
import {
  FileViewerRuntimeProvider,
  useFileViewerController,
} from "./file-viewer-runtime"
import type { FileViewerToolbarState } from "@/lib/files/file-viewer-definition"
import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/hooks/use-appearance", () => ({
  useEditorFont: () => ({
    editorWordWrap: false,
    setEditorWordWrap: vi.fn(),
  }),
}))
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  openPath: vi.fn().mockResolvedValue(undefined),
}))

function makeResourceTab(kind: "image" | "office" | "pdf"): FileWorkspaceTab {
  return {
    kind: "file",
    dataMode: "resource",
    id: `file:${kind}`,
    folderId: null,
    title: `${kind}.bin`,
    description: null,
    path: `/repo/${kind}.bin`,
    loading: false,
    saveState: "idle",
    saveError: null,
    preview:
      kind === "image"
        ? { kind, revision: 0, dataUrl: "data:image/png;base64,AA==" }
        : { kind, revision: 0 },
    readonly: true,
  }
}

function ControllerMount({ state }: { state: FileViewerToolbarState }) {
  useFileViewerController(state)
  return null
}

function Surface({
  tab,
  state,
}: {
  tab: FileWorkspaceTab
  state: FileViewerToolbarState
}) {
  return (
    <FileViewerRuntimeProvider tabId={tab.id}>
      <FileWorkspaceHeader tabId={tab.id} />
      <ControllerMount state={state} />
    </FileViewerRuntimeProvider>
  )
}

beforeEach(() => useWorkspaceFileStore.getState().reset())
afterEach(() => {
  cleanup()
  useWorkspaceFileStore.getState().reset()
})

describe("FileWorkspaceHeader viewer controls", () => {
  it("preserves header height for non-file document surfaces", () => {
    const tab: FileWorkspaceTab = {
      kind: "diff",
      id: "diff:working-tree",
      folderId: null,
      title: "Working tree",
      description: null,
      path: "/repo",
      loading: false,
      saveState: "idle",
      saveError: null,
      language: "diff",
      content: "",
      readonly: true,
    }
    useWorkspaceFileStore.getState().insertFileTab(tab)

    const { container } = render(
      <FileViewerRuntimeProvider tabId={tab.id}>
        <FileWorkspaceHeader tabId={tab.id} />
      </FileViewerRuntimeProvider>
    )

    expect(container.firstElementChild?.className).toContain("h-10")
  })

  it("renders image actions and metadata from the local controller", async () => {
    const zoomIn = vi.fn()
    const tab = makeResourceTab("image")
    useWorkspaceFileStore.getState().insertFileTab(tab)

    render(
      <Surface
        tab={tab}
        state={{
          kind: "image",
          zoom: {
            value: 100,
            min: 10,
            max: 1000,
            in: zoomIn,
            out: vi.fn(),
            reset: vi.fn(),
          },
          metadata: [{ label: "Dimensions", value: "640 x 480" }],
        }}
      />
    )

    await waitFor(() =>
      expect(screen.getByText("Dimensions: 640 x 480")).toBeTruthy()
    )
    fireEvent.click(screen.getByLabelText("imageZoomIn"))
    expect(zoomIn).toHaveBeenCalledTimes(1)
  })

  it("renders PDF navigation and Office refresh/external actions", async () => {
    const previous = vi.fn()
    const refresh = vi.fn()
    const openExternal = vi.fn()
    const pdf = makeResourceTab("pdf")
    useWorkspaceFileStore.getState().insertFileTab(pdf)

    const view = render(
      <Surface
        tab={pdf}
        state={{
          kind: "pdf",
          zoom: { value: 100, min: 10, max: 300, in: vi.fn(), out: vi.fn() },
          pdf: {
            page: 2,
            total: 4,
            setPage: previous,
            fitWidth: vi.fn(),
          },
          openExternal,
        }}
      />
    )

    await waitFor(() => expect(screen.getByLabelText("pdfPage")).toBeTruthy())
    fireEvent.click(screen.getByLabelText("pdfPrevious"))
    expect(previous).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByLabelText("pdfOpenExternal"))
    expect(openExternal).toHaveBeenCalledTimes(1)

    view.unmount()
    const office = makeResourceTab("office")
    useWorkspaceFileStore.getState().insertFileTab(office)
    const grab = vi.fn()
    render(
      <Surface
        tab={office}
        state={{
          kind: "office",
          refresh,
          openExternal,
          elementGrab: { active: false, toggle: grab },
        }}
      />
    )
    await waitFor(() =>
      expect(screen.getByLabelText("previewWatchRetry")).toBeTruthy()
    )
    fireEvent.click(screen.getByLabelText("previewWatchRetry"))
    expect(refresh).toHaveBeenCalledTimes(1)
    // 元素抓取能力已随沙箱文档化下线：控制器仍可能带 elementGrab（防旧
    // 快照），但 capability 没有声明 → 按钮不渲染（消失，不是灰按钮）。
    expect(screen.queryByLabelText("previewElementGrab")).toBeNull()
    expect(grab).not.toHaveBeenCalled()
  })
})
