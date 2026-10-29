import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const stripSource = readFileSync(
  resolve(process.cwd(), "src/components/tabs/workspace-tab-strip.tsx"),
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
const fileTabBarSource = readFileSync(
  resolve(process.cwd(), "src/components/files/file-workspace-tab-bar.tsx"),
  "utf8"
)

describe("workspace tab selection wiring", () => {
  it("routes primary and file tab clicks through the unified active reference", () => {
    // Shared strip owns selection wiring once for both panes.
    // 每个 tab 拿到同一个 selectTab（包一层 selectWorkspaceTab），点击时传入自己的 ref（稳定回调，memo 不被击穿）。
    expect(stripSource).toContain("onSwitch={selectTab}")
    expect(stripSource).toContain("selectWorkspaceTab(ref)")
    expect(stripSource).toContain("dragRef={entry.ref}")
    expect(stripSource).not.toContain("<Reorder.Group")
    expect(stripSource).not.toContain("onSwitch={switchTab}")
    expect(stripSource).not.toContain("onSwitch={switchFileTab}")
    expect(stripSource).not.toContain("isActive={tab.id === activeTabId}")

    // Column wrappers only pick a pane.
    expect(tabBarSource).toContain('pane="conversation"')
    expect(fileTabBarSource).toContain('pane="files"')
    expect(tabBarSource).toContain("WorkspaceTabStrip")
    expect(fileTabBarSource).toContain("WorkspaceTabStrip")
  })

  it("squeezes tabs Chrome-style down to a min width, then scrolls", () => {
    // 1. The tab group shrinks so items trade width fairly…
    expect(stripSource).toContain("flex min-w-0 shrink items-stretch")
    expect(stripSource).not.toContain("flex shrink-0 items-stretch")
    // 2. …and scrolls itself once tabs hit their min width.
    expect(stripSource).toContain(
      "gap-0 overflow-x-auto overflow-y-hidden pr-2 pt-1.5"
    )
    expect(shellSource).toContain("min-w-24 shrink basis-48")
  })

  it("swaps the dragged tab for a gap only while dragging", () => {
    expect(stripSource).toContain(
      "entries.filter((entry) => entry.key !== draggingKey)"
    )
    expect(stripSource).toContain(
      "draggingKey && dragOverPane === pane ? dragInsertIndex : null"
    )
    expect(stripSource).toContain("data-workspace-tab-placeholder")
    expect(stripSource).toContain("leadingTabs == null")
  })
})
