import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FileWorkspaceHeader } from "./file-workspace-header"
import { FileViewerRuntimeProvider } from "./file-viewer-runtime"
import type { ResourceFileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/lib/api", () => ({
  startPreviewWatch: vi.fn(),
  stopPreviewWatch: vi.fn(),
  refreshPreviewWatchHtml: vi.fn(),
  installPreviewTool: vi.fn(),
}))
vi.mock("@/hooks/workspace/use-workspace-state-store", () => ({
  useWorkspaceStateStore: () => ({
    subscribeEnvelopes: () => () => {},
  }),
}))
const subscriptions = vi.hoisted(
  () => new Map<string, (payload: unknown) => void>()
)
vi.mock("@/lib/transport", () => ({
  isDesktop: vi.fn(),
  getTransport: () => ({
    subscribe: (event: string, handler: (payload: unknown) => void) => {
      subscriptions.set(event, handler)
      return Promise.resolve(() => subscriptions.delete(event))
    },
  }),
}))
vi.mock("@/hooks/use-appearance", () => ({
  useEditorFont: () => ({
    editorWordWrap: false,
    setEditorWordWrap: vi.fn(),
  }),
}))
vi.mock("@/contexts/document-context", () => ({
  useDocumentContext: () => ({
    registerDocument: vi.fn(),
    clearDocument: vi.fn(),
  }),
}))

import {
  installPreviewTool,
  refreshPreviewWatchHtml,
  startPreviewWatch,
  stopPreviewWatch,
} from "@/lib/api"
import { isDesktop } from "@/lib/transport"
import { PluginPreview } from "./plugin-preview"

const mockStart = vi.mocked(startPreviewWatch)
const mockStop = vi.mocked(stopPreviewWatch)
const mockRefresh = vi.mocked(refreshPreviewWatchHtml)
const mockIsDesktop = vi.mocked(isDesktop)
const mockInstall = vi.mocked(installPreviewTool)

function makeOfficeTab(): ResourceFileWorkspaceTab {
  return {
    kind: "file",
    dataMode: "resource",
    id: "file:report.docx",
    folderId: null,
    title: "report.docx",
    description: null,
    path: "/root/reports/report.docx",
    loading: false,
    saveState: "idle",
    saveError: null,
    preview: { kind: "office", revision: 0 },
    readonly: true,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useWorkspaceFileStore.getState().reset()
  mockStop.mockResolvedValue(undefined)
  mockRefresh.mockResolvedValue("<html><body>snapshot</body></html>")
  mockIsDesktop.mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  useWorkspaceFileStore.getState().reset()
})

describe("PluginPreview", () => {
  it("renders the watch snapshot in the sandboxed document (no native surface)", async () => {
    mockStart.mockResolvedValue({
      port: 30000,
      html: "<html><body><p>first frame</p></body></html>",
      script: "/* plugin adapter */",
    })

    render(<PluginPreview rootPath="/root/reports" relPath="a.docx" />)

    const frame = await screen.findByTitle("previewTitle")
    expect(frame.getAttribute("srcdoc")).toContain("first frame")
    // 渲染器 DOM 适配来自插件声明的脚本，宿主只加拾取开关
    expect(frame.getAttribute("srcdoc")).toContain("/* plugin adapter */")
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
    // 关键契约：不再挂可见 native WebView
    expect(screen.queryByTestId("native-document-surface")).toBeNull()
  })

  it("falls back to a server fetch when the start result has no snapshot", async () => {
    mockStart.mockResolvedValue({ port: 30001, html: null })

    render(<PluginPreview rootPath="/root/reports" relPath="a.docx" />)

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledWith(30001))
    const frame = await screen.findByTitle("previewTitle")
    expect(frame.getAttribute("srcdoc")).toContain("snapshot")
  })

  it("re-fetches the snapshot when its watch pushes an update", async () => {
    mockStart.mockResolvedValue({ port: 41, html: "<p>v1</p>" })
    mockRefresh.mockResolvedValue("<p>v2</p>")
    render(<PluginPreview rootPath="/root/reports" relPath="live.pptx" />)
    await screen.findByTitle("previewTitle")
    await waitFor(() =>
      expect(subscriptions.has("app://preview-watch-update")).toBe(true)
    )
    const push = subscriptions.get("app://preview-watch-update")!

    push({ port: 99 })
    push({ port: 41 })
    push({ port: 41 })

    await waitFor(() =>
      expect(
        screen.getByTitle("previewTitle").getAttribute("srcdoc")
      ).toContain("v2")
    )
    // Another watch's push is ignored; a burst coalesces into one fetch.
    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(mockRefresh).toHaveBeenCalledWith(41)
  })

  it("restarts when its watch closes and shows the disabled-plugin prompt", async () => {
    mockStart.mockResolvedValueOnce({ port: 61, html: "<p>v1</p>" })
    mockStart.mockRejectedValueOnce({
      code: "invalid_input",
      message: "no enabled plugin previews this file type",
      i18n_params: { watchCode: "NO_PROVIDER" },
    })
    render(<PluginPreview rootPath="/root/reports" relPath="closed.pptx" />)
    await screen.findByTitle("previewTitle")
    await waitFor(() =>
      expect(subscriptions.has("app://preview-watch-update")).toBe(true)
    )
    const push = subscriptions.get("app://preview-watch-update")!

    push({ port: 99, kind: "closed" })
    expect(mockStart).toHaveBeenCalledTimes(1)
    push({ port: 61, kind: "closed" })

    expect(await screen.findByText("previewNoProvider")).toBeTruthy()
    expect(mockStart).toHaveBeenCalledTimes(2)
  })

  it("forwards officecli marks to the frame and reveals only new ones", async () => {
    mockStart.mockResolvedValue({
      port: 52,

      html: "<p>doc</p>",
      marks: [{ id: "1", path: "/body/p[1]", note: "old" }],
    })
    render(<PluginPreview rootPath="/root/reports" relPath="marks.docx" />)
    const frame = (await screen.findByTitle(
      "previewTitle"
    )) as HTMLIFrameElement
    const posted = vi.spyOn(frame.contentWindow!, "postMessage")
    await waitFor(() =>
      expect(subscriptions.has("app://preview-watch-update")).toBe(true)
    )
    const push = subscriptions.get("app://preview-watch-update")!

    push({
      port: 52,
      kind: "marks",
      marks: [
        { id: "1", path: "/body/p[1]", note: "old" },
        { id: "2", path: "/body/p[9]", note: "new" },
      ],
    })
    push({ port: 52, kind: "scroll", target: "#w-p-40" })

    await waitFor(() =>
      expect(posted).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "berth:preview-view",
          marks: expect.arrayContaining([
            expect.objectContaining({ path: "/body/p[9]" }),
          ]),
        }),
        "*"
      )
    )
    const reveals = posted.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter((message) => message.revealPath || message.revealAnchor)
    expect(reveals).toEqual([
      { type: "berth:preview-view", revealPath: "/body/p[9]" },
      { type: "berth:preview-view", revealAnchor: "#w-p-40" },
    ])
    // Marks pushes are not content changes.
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it("does not start a watch outside the desktop shell", async () => {
    mockIsDesktop.mockReturnValue(false)

    render(<PluginPreview rootPath="/root/reports" relPath="a.docx" />)

    expect(await screen.findByText("previewDesktopOnly")).toBeTruthy()
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("stops the watch after a grace period on unmount", async () => {
    mockStart.mockResolvedValue({ port: 1, html: "<p>x</p>" })

    const { unmount } = render(
      <PluginPreview rootPath="/root/reports" relPath="stop.docx" />
    )
    await screen.findByTitle("previewTitle")
    vi.useFakeTimers()
    try {
      unmount()
      expect(mockStop).not.toHaveBeenCalled()
      vi.advanceTimersByTime(60_000)
      expect(mockStop).toHaveBeenCalledWith("/root/reports", "stop.docx")
    } finally {
      vi.useRealTimers()
    }
  })

  it("paints the cached snapshot instantly on remount", async () => {
    mockStart.mockResolvedValue({ port: 2, html: "<p>cached</p>" })
    const first = render(
      <PluginPreview rootPath="/root/reports" relPath="cache.pptx" />
    )
    await screen.findByTitle("previewTitle")
    first.unmount()

    mockStart.mockReturnValue(new Promise(() => {}))
    render(<PluginPreview rootPath="/root/reports" relPath="cache.pptx" />)
    // Synchronous: no await, the start promise never resolves.
    expect(screen.getByTitle("previewTitle").getAttribute("srcdoc")).toContain(
      "cached"
    )
  })

  it("installs OfficeCLI in place and restarts the watch", async () => {
    mockStart.mockRejectedValueOnce({
      code: "dependency_missing",
      message: "officecli is not installed",
      i18n_params: { watchCode: "NOT_INSTALLED" },
    })
    mockStart.mockResolvedValueOnce({ port: 9, html: "<p>ok</p>" })
    mockInstall.mockResolvedValue({
      installed: true,
      version: "1.0",
      path: "/bin/officecli",
      runtimeError: null,
      installScript: true,
      canUpdate: false,
    })

    render(<PluginPreview rootPath="/root/reports" relPath="install.docx" />)

    fireEvent.click(await screen.findByText("previewInstall"))
    await waitFor(() => expect(mockInstall).toHaveBeenCalledTimes(1))
    expect(mockInstall.mock.calls[0][1]).toBe("install.docx")
    const frame = await screen.findByTitle("previewTitle")
    expect(frame.getAttribute("srcdoc")).toContain("ok")
  })

  it("shows the installer error when install fails", async () => {
    mockStart.mockRejectedValue({
      code: "dependency_missing",
      message: "officecli is not installed",
      i18n_params: { watchCode: "NOT_INSTALLED" },
    })
    mockInstall.mockRejectedValue({ code: "io", message: "network down" })

    render(<PluginPreview rootPath="/root/reports" relPath="fail.docx" />)

    fireEvent.click(await screen.findByText("previewInstall"))
    expect((await screen.findByRole("alert")).textContent).toContain(
      "network down"
    )
  })

  it("points to plugin settings when no plugin previews the file", async () => {
    mockStart.mockRejectedValue({
      code: "invalid_input",
      message: "no enabled plugin previews this file type",
      i18n_params: { watchCode: "NO_PROVIDER" },
    })

    render(<PluginPreview rootPath="/root/reports" relPath="none.docx" />)

    expect(await screen.findByText("previewNoProvider")).toBeTruthy()
    expect(screen.queryByText("previewInstall")).toBeNull()
  })

  it("retries a failed desktop watch", async () => {
    mockStart.mockRejectedValueOnce({
      code: "task_execution_failed",
      message: "boom",
      i18n_params: { watchCode: "START_FAILED" },
    })
    mockStart.mockResolvedValueOnce({ port: 5, html: "<p>y</p>" })

    const tab = makeOfficeTab()
    useWorkspaceFileStore.getState().insertFileTab(tab)
    render(
      <FileViewerRuntimeProvider tabId={tab.id}>
        <FileWorkspaceHeader tabId={tab.id} />
        <PluginPreview
          rootPath="/root/reports"
          relPath="report.docx"
          absolutePath={tab.path}
        />
      </FileViewerRuntimeProvider>
    )

    const retry = await screen.findByLabelText("previewWatchRetry")
    expect(mockStart).toHaveBeenCalledTimes(1)
    fireEvent.click(retry)
    await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(2))
  })
})
