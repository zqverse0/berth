import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(
  resolve(
    process.cwd(),
    "src/components/conversations/conversation-detail-panel.tsx"
  ),
  "utf8"
)
const sessionViewerSource = readFileSync(
  resolve(process.cwd(), "src/sessions/components/session-tab-view.tsx"),
  "utf8"
)
const sessionSurfaceSource = readFileSync(
  resolve(process.cwd(), "src/sessions/components/session-view-surface.tsx"),
  "utf8"
)

describe("ConversationDetailPanel keep-alive detail loading", () => {
  it("only auto-fetches persisted detail for the active tab", () => {
    // 套路断言需抗格式化：将源码与期望串都压缩掉全部空白后比对，
    // 保证「仅激活 tab 拉取持久化详情」这一契约不受 prettier 折行影响。
    const compact = (value: string) => value.replace(/\s+/g, "")
    expect(compact(sessionViewerSource)).toContain(
      compact(
        "useConversationDetail(effectiveConversationId, { enabled: isActive })"
      )
    )
    expect(source).toContain("paneVisible")
  })
})

describe("ConversationDetailPanel terminal keep-alive", () => {
  it("keeps other projects' warmed terminals mounted when this project has no tabs", () => {
    expect(source).not.toContain("hasNoTabs")
    expect(source).toContain("if (tabs.length === 0) return null")
  })
})

describe("ConversationDetailPanel read-only transcript", () => {
  it("does not mount a chat composer or ACP connection on the session surface", () => {
    expect(sessionViewerSource).not.toContain("ConversationShell")
    expect(sessionViewerSource).not.toContain("hideInput")
    expect(sessionViewerSource).not.toContain("useConnectionLifecycle")
    expect(sessionViewerSource).not.toContain("handleSend")
    expect(sessionViewerSource).not.toContain("canAutoConnect")
    expect(sessionViewerSource).not.toContain("ChatInput")
    expect(sessionSurfaceSource).toContain("<MessageListView")
    expect(source).not.toContain("<AgentLaunchPanel")
  })

  it("routes continue-session to Agent CLI launch instead of ACP send", () => {
    expect(sessionViewerSource).toContain("requestAgentLaunch({")
    expect(sessionViewerSource).not.toContain("consumeLaunchInitialDraft")
    expect(sessionViewerSource).not.toContain("lifecycleSend")
    expect(sessionViewerSource).not.toContain("acpFork")
  })

  it("does not render a decorative welcome page", () => {
    expect(source).not.toContain("WelcomeHero")
    expect(source).not.toContain("WelcomeTip")
    expect(source).not.toContain("QuickActions")
    expect(source).not.toContain("welcome-hero")
  })

  it("uses the workspace background contract for transcript surfaces", () => {
    expect(sessionSurfaceSource).toContain("bg-background ws-transparent-bg")
  })
})

describe("ConversationDetailPanel cross-pane primary tabs", () => {
  it("keeps one primary tree while painting a visible tab in each pane", () => {
    expect(source).toContain("data-workspace-primary-pane={pane}")
    expect(source).toContain("paneVisibleTabIds")
    expect(source).toContain("isVisible={paneVisible}")
    expect(source).toContain("workspaceTabRefEqual(activeWorkspaceTab, tabRef)")
    expect(source).toContain("selectWorkspaceTab(tabRef)")
    expect(source).not.toContain("activePrimaryPane === pane")
    expect(source).not.toContain(
      "const active = inScope && tab.id === activeTabId"
    )
  })
})

describe("ConversationDetailPanel session-management navigation", () => {
  it("hands a launch draft back to the project workspace", () => {
    expect(sessionViewerSource).toContain("activateFolderWorkspace(folder.id)")
    expect(source).not.toContain("<AgentLaunchPanel")
  })
})

describe("ConversationDetailPanel containment", () => {
  it("fills its host without the removed pane geometry variables", () => {
    expect(source).toContain("absolute inset-0 overflow-hidden")
    expect(source).not.toContain("--ws-")
  })
})
