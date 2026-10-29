import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const tabItemSource = readFileSync(
  resolve(process.cwd(), "src/components/tabs/tab-item.tsx"),
  "utf8"
)
const shellSource = readFileSync(
  resolve(process.cwd(), "src/components/tabs/workspace-tab-shell.tsx"),
  "utf8"
)
const tabBarSource = readFileSync(
  resolve(process.cwd(), "src/components/tabs/tab-bar.tsx"),
  "utf8"
)
const detailSource = readFileSync(
  resolve(
    process.cwd(),
    "src/components/conversations/conversation-detail-panel.tsx"
  ),
  "utf8"
)
const layoutSource = readFileSync(
  resolve(process.cwd(), "src/app/workspace/layout.tsx"),
  "utf8"
)

describe("primary tab chrome union awareness", () => {
  it("renders terminal and conversation chrome in the shared tab strip", () => {
    expect(tabBarSource).toContain("<WorkspaceTabStrip")
    expect(tabItemSource).toContain("isTerminalTab")
    expect(tabItemSource).toContain("ColorTerminalIcon")
    expect(tabItemSource).toContain("AgentIcon")
    expect(tabItemSource).toContain("liveAgentId !== undefined")
    expect(tabItemSource).toContain('"agentType" in tab && tab.agentType')
    expect(tabItemSource).toContain("closeTerminalTab")
    expect(tabItemSource).toContain("closeConversationTab")
    expect(tabItemSource).not.toContain("[font-style:oblique]")
  })

  it("dispatches terminal primary tiles to the shared TerminalView", () => {
    expect(detailSource).toContain("TerminalView")
    expect(detailSource).toContain("isTerminalTab(tab)")
    // Visible pane tiles only — background terminal tabs remain warmed but do
    // not claim a visible pane.
    expect(detailSource).toContain("active || paneVisible")
    // Must not filter the primary workspace to conversation-only.
    expect(detailSource).not.toMatch(
      /const tabs = useTabStore\(\(s\) => s\.tabs\.filter\(isConversationTab\)\)/
    )
    // No second xterm host component.
    expect(detailSource).not.toContain("TerminalTabView")
  })

  it("does not mount the legacy bottom terminal lifecycle", () => {
    expect(layoutSource).not.toContain("TerminalProvider")
    expect(layoutSource).not.toContain("TerminalPanel")
    expect(layoutSource).not.toContain("useTerminalContext")
    expect(layoutSource).not.toContain("FOLDER_MAIN_TERMINAL_PANEL_ID")
  })

  it("routes every tab kind through the shared WorkspaceTabShell", () => {
    const fileTabItemSource = readFileSync(
      resolve(
        process.cwd(),
        "src/components/files/file-workspace-tab-item.tsx"
      ),
      "utf8"
    )
    for (const source of [tabItemSource, fileTabItemSource]) {
      expect(source).toContain("<WorkspaceTabShell")
      expect(source).not.toContain("<Reorder.Item")
    }
    // Double-click toggles pin on primary and file tabs.
    expect(tabItemSource).toContain("onDoubleClick={() => onPin(tab.id)}")
    expect(fileTabItemSource).toContain("onDoubleClick={() => onPin(tab.id)}")
    // 钉住与 Agent 状态、新开未看统一为一个状态点。
    expect(tabItemSource).toContain('tab.isPinned && "pinned"')
    expect(shellSource).toContain("<StatusDot")
    expect(shellSource).not.toContain("<Pin")
  })

  it("renders agent and terminal tabs as compact badges with a hover-only close", () => {
    const globalsCssSource = readFileSync(
      resolve(process.cwd(), "src/app/globals.css"),
      "utf8"
    )

    expect(tabItemSource).toContain(
      "isIconOnlyTab = isAgentTab || isTerminalTab(tab)"
    )
    expect(tabItemSource).toContain("compact={isIconOnlyTab}")
    expect(tabItemSource).toContain('className="size-5 shrink-0"')
    expect(tabItemSource).toContain("<ColorTerminalIcon")
    expect(shellSource).toContain(
      'data-agent-tab={compact ? "true" : undefined}'
    )
    expect(shellSource).toContain("basis-10 w-10")
    expect(shellSource).toContain("{!compact && label != null && (")

    // Compact tabs keep their icon when active; close is a hover-only corner
    // badge so a click on the active tab body never closes it.
    expect(shellSource).toContain("active && !compact")
    expect(shellSource).toContain("group-hover/tab:pointer-events-auto")

    // globals.css excludes agent/icon-only tabs from forced padding-right
    expect(globalsCssSource).toContain(
      '.browser-tab-item[data-active="true"]:not([data-agent-tab="true"])'
    )

    // Context menu: closeToRight before pinGlobal, no copyShareLink/closeAll.
    expect(tabItemSource).not.toContain("copyShareLink")
    expect(tabItemSource).not.toContain('t("closeAll")')
    expect(tabItemSource.indexOf('t("closeToRight")')).toBeLessThan(
      tabItemSource.indexOf('t("pinGlobal")')
    )
  })
})
