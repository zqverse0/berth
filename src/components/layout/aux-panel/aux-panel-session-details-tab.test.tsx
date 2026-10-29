import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import type { DbConversationSummary } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

// Regression guard: the branch selector was REMOVED from this tab — it lives in
// the surrounding sidebar controls now. Stub it so that if it is ever
// re-added here, its test id surfaces and the "no actions bar" assertions below
// fail.
vi.mock("@/components/layout/git/branch-dropdown", () => ({
  BranchDropdown: () => <div data-testid="branch-dropdown" />,
}))
// The agent icon renders inline SVG with a <title> that duplicates the label.
vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))
// Stats are always supplied here, so the cold-fetch path must never fire; stub
// the API so an accidental call is inert rather than a real transport hit.
vi.mock("@/lib/api", () => ({ getFolderConversation: vi.fn() }))

vi.mock("@/contexts/tab-context", () => ({ useTabStore: vi.fn() }))
vi.mock("@/stores/conversation-runtime-store", () => ({
  useConversationRuntimeStore: vi.fn(),
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: vi.fn(),
}))
// 无焦点工作区标签：走旧对话标签的元信息分支。
vi.mock("@/stores/workspace-layout-store", () => ({
  useWorkspaceLayoutStore: (
    sel: (s: { activeWorkspaceTab: null }) => unknown
  ) => sel({ activeWorkspaceTab: null }),
}))

import { SessionDetailsTab } from "@/components/layout/aux-panel/aux-panel-session-details-tab"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

const mockTabs = useTabStore as unknown as Mock
const mockRuntime = useConversationRuntimeStore as unknown as Mock
const mockWorkspace = useAppWorkspaceStore as unknown as Mock

type TabSlice = {
  tabs: Array<{
    kind: "conversation"
    id: number
    conversationId: number | null
    runtimeConversationId?: number
  }>
  activeTabId: number | null
}
type RuntimeSlice = { byConversationId: Map<number, unknown> }
type WorkspaceSlice = { conversations: DbConversationSummary[] }

function summary(
  over: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id: 7,
    folder_id: 1,
    title: "My session",
    title_locked: false,
    agent_type: "claude_code",
    kind: "regular",
    model: "claude-opus-4-8",
    git_branch: "main",
    external_id: "ext-abc",
    message_count: 12,
    child_count: 0,
    created_at: "2026-06-10T10:00:00.000Z",
    updated_at: "2026-06-12T12:00:00.000Z",
    pinned_at: null,
    ...over,
  }
}

function setupScene(opts: { hasActiveConversation: boolean }) {
  useAppUiStore.setState({ sidebarOpen: true })

  const tabState: TabSlice = {
    tabs: opts.hasActiveConversation
      ? [{ kind: "conversation", id: 1, conversationId: 7 }]
      : [],
    activeTabId: opts.hasActiveConversation ? 1 : null,
  }
  mockTabs.mockImplementation((sel: (s: TabSlice) => unknown) => sel(tabState))
  mockRuntime.mockImplementation((sel: (s: RuntimeSlice) => unknown) =>
    sel({ byConversationId: new Map() })
  )
  mockWorkspace.mockImplementation((sel: (s: WorkspaceSlice) => unknown) =>
    sel({ conversations: opts.hasActiveConversation ? [summary()] : [] })
  )
}

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionDetailsTab />
    </NextIntlClientProvider>
  )
}

describe("SessionDetailsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppUiStore.getState().resetAppUi()
  })

  it("renders the active session's details with no folder-actions bar", () => {
    // Branch + command belong to the surrounding sidebar, so the tab shows the
    // details alone — no branch/command controls here.
    setupScene({ hasActiveConversation: true })
    const { getByText, getByTestId, queryByTestId } = renderTab()
    expect(getByTestId("session-details-tab")).toHaveClass(
      "min-w-0",
      "w-full",
      "flex-1"
    )
    expect(getByText("My session")).toBeTruthy()
    expect(getByText("Claude Code")).toBeTruthy()
    expect(queryByTestId("branch-dropdown")).toBeNull()
  })

  it("shows the empty state when there is no active session", () => {
    setupScene({ hasActiveConversation: false })
    const { getByText, queryByTestId } = renderTab()
    expect(getByText("No active session")).toBeTruthy()
    expect(queryByTestId("branch-dropdown")).toBeNull()
  })
})
