import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ReactNode } from "react"
import {
  FileViewerRuntimeProvider,
  useFileViewerController,
  useOptionalFileViewerRuntime,
} from "./file-viewer-runtime"
import type { FileViewerToolbarState } from "@/lib/files/file-viewer-definition"
import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"

function makeTab(): FileWorkspaceTab {
  return {
    kind: "file",
    dataMode: "text",
    previewKind: "markdown",
    id: "file:readme",
    folderId: null,
    title: "README.md",
    description: null,
    path: "/repo/README.md",
    language: "markdown",
    content: "# Read me",
    savedContent: "# Read me",
    isDirty: false,
    etag: null,
    mtimeMs: null,
    loading: false,
    saveState: "idle",
    saveError: null,
    readonly: true,
    lineEnding: "lf",
  }
}

function RuntimeProbe() {
  const runtime = useOptionalFileViewerRuntime()
  return (
    <output data-testid="runtime-state">
      {runtime?.controller?.zoom?.value ?? "none"}
    </output>
  )
}

function Controller({ snapshot }: { snapshot: FileViewerToolbarState | null }) {
  useFileViewerController(snapshot)
  return null
}

function Harness({
  snapshot,
  children,
}: {
  snapshot: FileViewerToolbarState | null
  children?: ReactNode
}) {
  return (
    <FileViewerRuntimeProvider tabId="file:readme">
      <RuntimeProbe />
      <Controller snapshot={snapshot} />
      {children}
    </FileViewerRuntimeProvider>
  )
}

beforeEach(() => {
  useWorkspaceFileStore.getState().reset()
  useWorkspaceFileStore.getState().insertFileTab(makeTab())
})

afterEach(() => {
  cleanup()
  useWorkspaceFileStore.getState().reset()
})

describe("FileViewerRuntimeProvider", () => {
  it("publishes a mounted viewer controller to the header seam", async () => {
    render(
      <Harness
        snapshot={{
          kind: "markdown",
          zoom: {
            value: 125,
            min: 50,
            max: 200,
            in: () => {},
            out: () => {},
          },
        }}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId("runtime-state")).toHaveTextContent("125")
    )
  })

  it("updates the controller snapshot without replacing its registration seam", async () => {
    const first = {
      kind: "markdown" as const,
      zoom: { value: 100, min: 50, max: 200, in: () => {}, out: () => {} },
    }
    const second = {
      kind: "markdown" as const,
      zoom: { value: 150, min: 50, max: 200, in: () => {}, out: () => {} },
    }
    const view = render(<Harness snapshot={first} />)
    await waitFor(() =>
      expect(screen.getByTestId("runtime-state")).toHaveTextContent("100")
    )

    view.rerender(<Harness snapshot={second} />)
    await waitFor(() =>
      expect(screen.getByTestId("runtime-state")).toHaveTextContent("150")
    )
  })

  it("removes controls omitted by a later controller snapshot", async () => {
    const view = render(
      <Harness
        snapshot={{
          kind: "markdown",
          zoom: {
            value: 100,
            min: 50,
            max: 200,
            in: () => {},
            out: () => {},
          },
        }}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId("runtime-state")).toHaveTextContent("100")
    )

    view.rerender(<Harness snapshot={{ kind: "markdown" }} />)
    await waitFor(() =>
      expect(screen.getByTestId("runtime-state")).toHaveTextContent("none")
    )
  })

  it("clears the header controller when the viewer unmounts", async () => {
    const view = render(
      <Harness
        snapshot={{
          kind: "markdown",
          zoom: {
            value: 100,
            min: 50,
            max: 200,
            in: () => {},
            out: () => {},
          },
        }}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId("runtime-state")).toHaveTextContent("100")
    )

    view.rerender(<Harness snapshot={null} />)
    await waitFor(() =>
      expect(screen.getByTestId("runtime-state")).toHaveTextContent("none")
    )
  })
})
