import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { useDiffOverviewStatusStore } from "@/lib/files/diff-overview-status"
import {
  buildDiffOutline,
  DiffOverviewPanel,
  EMPTY_DIFF_OUTLINE,
} from "./diff-overview-panel"
import { DiffOverviewToolbar } from "./diff-overview-toolbar"

const mocks = vi.hoisted(() => ({
  gitLog: vi.fn(),
  gitCommit: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  gitLog: mocks.gitLog,
  gitCommit: mocks.gitCommit,
}))

vi.mock("@/components/diff/unified-diff-preview", () => ({
  UnifiedDiffPreview: ({
    diffText,
    embedded,
  }: {
    diffText: string
    embedded?: boolean
  }) => (
    <pre
      data-testid="inline-diff-preview"
      data-embedded={embedded ? "true" : "false"}
    >
      {diffText}
    </pre>
  ),
}))

const MULTI_FILE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,1 +1,2 @@",
  " const a = 1",
  "+const b = 2",
  "diff --git a/src/c.ts b/src/c.ts",
  "--- a/src/c.ts",
  "+++ b/src/c.ts",
  "@@ -1,2 +1,1 @@",
  " const c = 3",
  "-const d = 4",
].join("\n")

const tPanel = enMessages.Folder.fileWorkspacePanel
const TAB_ID = "diff:commit:7:1111111111111111111111111111111111111111"

function renderOverview(
  props: Partial<React.ComponentProps<typeof DiffOverviewPanel>> = {}
) {
  const diffContent = props.diffContent ?? MULTI_FILE_DIFF
  const diffOutline =
    props.diffOutline ?? buildDiffOutline(diffContent) ?? EMPTY_DIFF_OUTLINE
  const tabId = props.tabId ?? TAB_ID

  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DiffOverviewToolbar tabId={tabId} />
      <DiffOverviewPanel
        tabId={tabId}
        diffContent={diffContent}
        diffOutline={diffOutline}
        context={
          props.context ?? {
            kind: "commit",
            commitHash: "1111111111111111111111111111111111111111",
            commitMessage: "feat: subject line\n\nBody detail line 1\nLine 2",
          }
        }
        folderId={props.folderId ?? 7}
        folderPath={props.folderPath ?? "/repo"}
        badge={props.badge ?? "1111111"}
        description={props.description}
        onOpenDiffInNewTab={props.onOpenDiffInNewTab ?? vi.fn()}
        openFilePreview={props.openFilePreview ?? vi.fn()}
        onCommitAmended={props.onCommitAmended}
        onRefresh={props.onRefresh}
      />
    </NextIntlClientProvider>
  )
}

describe("DiffOverviewPanel + DiffOverviewToolbar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDiffOverviewStatusStore.setState({ byTabId: {} })
  })

  it("splits code and commit 50/50, drives expand/filter from top toolbar, and syncs bottom status", async () => {
    const hash = "1111111111111111111111111111111111111111"
    mocks.gitLog.mockResolvedValueOnce({
      entries: [
        {
          hash: "1111111",
          full_hash: hash,
          author: "Alice",
          date: "2026-11-20T10:00:00Z",
          message: "feat: subject line\n\nBody detail line 1\nLine 2",
          files: [],
          additions: 1,
          deletions: 1,
          pushed: false,
        },
      ],
      has_upstream: true,
    })

    const onOpenDiffInNewTab = vi.fn()
    renderOverview({ onOpenDiffInNewTab })

    // 上下两部分通过可拖拽垂直分隔条对半分
    const separator = screen.getByRole("separator")
    expect(separator).toHaveAttribute("data-split-view-direction", "vertical")
    expect(
      screen.getByRole("region", { name: tPanel.changedFilesHeading })
    ).toBeTruthy()
    expect(
      screen.getByRole("region", { name: tPanel.commitMessageSectionLabel })
    ).toBeTruthy()

    // 标号、增删量、作者与推送状态同步到全局底部状态栏 store
    await waitFor(() => {
      const status = useDiffOverviewStatusStore.getState().byTabId[TAB_ID]
      expect(status).toMatchObject({
        badge: "1111111",
        copyText: hash,
        fileCount: 2,
        additions: 1,
        deletions: 1,
        author: "Alice",
        pushed: false,
      })
    })

    // 多文件默认折叠，点文件行原地展开，不跳新 tab
    expect(screen.queryByTestId("inline-diff-preview")).toBeNull()
    const fileAButton = screen.getByRole("button", { name: /src\/a\.ts/ })
    fireEvent.click(fileAButton)
    await waitFor(() => {
      const previews = screen.getAllByTestId("inline-diff-preview")
      expect(previews).toHaveLength(1)
      expect(previews[0].dataset.embedded).toBe("true")
      expect(previews[0].textContent).toContain("+const b = 2")
      expect(previews[0].textContent).not.toContain("-const d = 4")
    })
    expect(onOpenDiffInNewTab).not.toHaveBeenCalled()

    // 顶部工具栏「全部展开 / 全部折叠」
    fireEvent.click(screen.getByRole("button", { name: tPanel.expandAllFiles }))
    await waitFor(() => {
      expect(screen.getAllByTestId("inline-diff-preview")).toHaveLength(2)
    })
    fireEvent.click(
      screen.getByRole("button", { name: tPanel.collapseAllFiles })
    )
    expect(screen.queryByTestId("inline-diff-preview")).toBeNull()

    // 顶部工具栏文件筛选
    const filterInput = screen.getByLabelText(tPanel.filterDiffFilesPlaceholder)
    fireEvent.change(filterInput, { target: { value: "c.ts" } })
    expect(screen.queryByRole("button", { name: /src\/a\.ts/ })).toBeNull()
    expect(screen.getByRole("button", { name: /src\/c\.ts/ })).toBeTruthy()
  })

  it("lets the user click the commit message surface directly to edit HEAD unpushed commit", async () => {
    const oldHash = "1111111111111111111111111111111111111111"
    const newHash = "2222222222222222222222222222222222222222"
    mocks.gitLog.mockResolvedValueOnce({
      entries: [
        {
          hash: "1111111",
          full_hash: oldHash,
          author: "Alice",
          date: "2026-11-20T10:00:00Z",
          message: "old subject",
          files: [],
          additions: 1,
          deletions: 0,
          pushed: false,
        },
      ],
      has_upstream: true,
    })
    mocks.gitCommit.mockResolvedValueOnce({
      committed_files: 2,
      hash: newHash,
    })

    const onCommitAmended = vi.fn().mockResolvedValue(undefined)
    renderOverview({ onCommitAmended })

    // 只有一个清晰的编辑入口（整块提交信息卡片），无冗余编辑按钮
    const surface = await screen.findByRole("button", {
      name: tPanel.clickToEditCommitMessage,
    })
    expect(screen.getByText(tPanel.commitEditableBadge)).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: tPanel.editCommitMessage })
    ).toBeNull()

    fireEvent.click(surface)
    const textarea = screen.getByLabelText(tPanel.commitMessageInputLabel)
    fireEvent.change(textarea, {
      target: { value: "new subject\n\nupdated body" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: tPanel.saveCommitMessage })
    )

    await waitFor(() => {
      expect(mocks.gitCommit).toHaveBeenCalledWith(
        "/repo",
        "new subject\n\nupdated body",
        [],
        7,
        true
      )
      expect(onCommitAmended).toHaveBeenCalledWith(
        newHash,
        "new subject\n\nupdated body"
      )
    })
  })

  it("shows read-only state without edit affordance when the commit is already pushed", async () => {
    const hash = "1111111111111111111111111111111111111111"
    mocks.gitLog.mockResolvedValueOnce({
      entries: [
        {
          hash: "1111111",
          full_hash: hash,
          author: "Alice",
          date: "2026-11-20T10:00:00Z",
          message: "pushed commit",
          files: [],
          additions: 1,
          deletions: 0,
          pushed: true,
        },
      ],
      has_upstream: true,
    })

    renderOverview()

    await waitFor(() => {
      expect(screen.getByText(tPanel.commitEditDisabledPushed)).toBeTruthy()
    })
    expect(screen.queryByText(tPanel.commitEditableBadge)).toBeNull()
    expect(
      screen.queryByRole("button", { name: tPanel.editCommitMessage })
    ).toBeNull()
  })
})
