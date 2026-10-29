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
import { ImagePreview } from "./image-preview"
import type { ImageResourceFileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/hooks/use-appearance", () => ({
  useEditorFont: () => ({
    editorWordWrap: false,
    setEditorWordWrap: vi.fn(),
  }),
}))

function makeImageTab(): ImageResourceFileWorkspaceTab {
  return {
    kind: "file",
    dataMode: "resource",
    id: "file:logo.png",
    folderId: null,
    title: "logo.png",
    description: null,
    path: "/repo/logo.png",
    loading: false,
    saveState: "idle",
    saveError: null,
    preview: {
      kind: "image",
      revision: 0,
      dataUrl: "data:image/png;base64,AA==",
    },
    readonly: true,
  }
}

beforeEach(() => useWorkspaceFileStore.getState().reset())
afterEach(() => {
  cleanup()
  useWorkspaceFileStore.getState().reset()
})

describe("ImagePreview shared toolbar controller", () => {
  it("publishes zoom and metadata to the workspace header", async () => {
    const tab = makeImageTab()
    useWorkspaceFileStore.getState().insertFileTab(tab)
    render(
      <FileViewerRuntimeProvider tabId={tab.id}>
        <FileWorkspaceHeader tabId={tab.id} />
        <ImagePreview tab={tab} />
      </FileViewerRuntimeProvider>
    )

    const image = screen.getByRole("img")
    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      value: 640,
    })
    Object.defineProperty(image, "naturalHeight", {
      configurable: true,
      value: 480,
    })
    fireEvent.load(image)

    await waitFor(() =>
      expect(screen.getByText("imageDimensions: 640 x 480")).toBeTruthy()
    )
    expect(screen.getByText("imageFileSize: 1 B")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("imageZoomIn"))
    await waitFor(() => expect(screen.getByText("125%")).toBeTruthy())
  })
})
