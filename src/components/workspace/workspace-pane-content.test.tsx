import { render, screen } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import type { WorkspaceLayoutProjection } from "@/lib/workspace/workspace-layout-projection"
import type { WorkspaceTabRef } from "@/lib/workspace/workspace-tab-placement"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { WorkspacePaneContent } from "./workspace-pane-content"

const mocks = vi.hoisted(() => ({
  layout: null as Partial<WorkspaceLayoutProjection> | null,
}))

vi.mock("@/hooks/workspace/use-workspace-layout", () => ({
  useWorkspaceLayoutProjection: (
    select: (projection: WorkspaceLayoutProjection) => unknown
  ) => select(mocks.layout as WorkspaceLayoutProjection),
}))
vi.mock("@/components/conversations/conversation-detail-panel", () => ({
  ConversationDetailPanel: ({ pane }: { pane: string }) => (
    <div data-testid="primary-host">{pane}</div>
  ),
}))
vi.mock("@/components/workspace/project-home/project-home", () => ({
  ProjectHome: () => <div data-testid="project-home" />,
}))
vi.mock("@/components/files/file-workspace-header", () => ({
  FileWorkspaceHeader: () => null,
}))
vi.mock("@/components/files/file-viewer-runtime", () => ({
  FileViewerRuntimeProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}))
vi.mock("@/components/files/file-workspace-panel", () => ({
  FileWorkspacePanel: (props: {
    tabId: string
    visible: boolean
    active: boolean
  }) => (
    <div
      data-testid="file-host"
      data-tab-id={props.tabId}
      data-visible={String(props.visible)}
      data-active={String(props.active)}
    />
  ),
}))

const file = (id: string): WorkspaceTabRef => ({ kind: "file", id })
const terminal: WorkspaceTabRef = { kind: "primary", id: "term" }

function layout(
  files: WorkspaceTabRef[],
  conversation: WorkspaceTabRef[],
  active: Record<"files" | "conversation", WorkspaceTabRef | null>,
  activeFileTabId: string | null
) {
  mocks.layout = {
    tabsByPane: { files, conversation, "files-split": [] },
    activeTabByPane: { ...active, "files-split": null },
  }
  useWorkspaceFileStore.setState({ activeFileTabId })
}

beforeEach(() => {
  mocks.layout = null
})

it("shows the pane's own file and leaves another pane's file alone", () => {
  layout(
    [file("a")],
    [file("b")],
    { files: file("a"), conversation: file("b") },
    "b"
  )
  render(<WorkspacePaneContent pane="files" />)
  const host = screen.getByTestId("file-host")
  expect(host.dataset.tabId).toBe("a")
  expect(host.dataset.visible).toBe("true")
  // Only the pane holding activeFileTabId owns save / document context.
  expect(host.dataset.active).toBe("false")
  expect(screen.getByTestId("primary-host")).toHaveTextContent("files")
})

it("keeps the file host mounted but hidden while a terminal covers the pane", () => {
  layout(
    [file("a"), terminal],
    [],
    { files: file("a"), conversation: null },
    "a"
  )
  const view = render(<WorkspacePaneContent pane="files" />)
  expect(screen.getByTestId("file-host").dataset.active).toBe("true")

  layout(
    [file("a"), terminal],
    [],
    { files: terminal, conversation: null },
    "a"
  )
  view.rerender(<WorkspacePaneContent pane="files" />)
  const host = screen.getByTestId("file-host")
  expect(host.dataset.tabId).toBe("a")
  expect(host.dataset.visible).toBe("false")
  expect(host.dataset.active).toBe("false")
})

it("drops the remembered file once it moves to another pane", () => {
  layout([file("a")], [], { files: file("a"), conversation: null }, "a")
  const view = render(<WorkspacePaneContent pane="files" />)

  layout(
    [terminal],
    [file("a")],
    { files: terminal, conversation: file("a") },
    "a"
  )
  view.rerender(<WorkspacePaneContent pane="files" />)
  expect(screen.queryByTestId("file-host")).toBeNull()
})

it("keeps recent projects' file hosts mounted, up to three", () => {
  useWorkspaceFileStore.setState({
    fileTabs: ["a", "b", "c", "d"].map((id) => ({ id })) as never,
  })
  const hosts = () =>
    screen
      .getAllByTestId("file-host")
      .map((host) => `${host.dataset.tabId}:${host.dataset.visible}`)
  // 每次切项目，本组只剩该项目的 tab
  layout([file("a")], [], { files: file("a"), conversation: null }, "a")
  const view = render(<WorkspacePaneContent pane="files" />)
  for (const id of ["b", "c", "d"]) {
    layout([file(id)], [], { files: file(id), conversation: null }, id)
    view.rerender(<WorkspacePaneContent pane="files" />)
  }
  // 切回 c：不重建，直接显示；最久没用的 a 已卸载
  layout([file("c")], [], { files: file("c"), conversation: null }, "c")
  view.rerender(<WorkspacePaneContent pane="files" />)
  expect(hosts()).toEqual(["b:false", "c:true", "d:false"])
})

it("keeps a summoned home over the file while other panes render", async () => {
  layout(
    [file("a")],
    [terminal],
    { files: file("a"), conversation: terminal },
    "a"
  )
  useAppUiStore.setState({ projectHomeOver: "file:a" })
  // 辅助面板的激活 tab 不同，不能把左栏叫出的首页清掉
  render(
    <>
      <WorkspacePaneContent pane="files" />
      <WorkspacePaneContent pane="conversation" />
    </>
  )
  expect(await screen.findByTestId("project-home")).toBeInTheDocument()
  expect(useAppUiStore.getState().projectHomeOver).toBe("file:a")
})
