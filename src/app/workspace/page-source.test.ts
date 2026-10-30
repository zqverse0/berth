import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const pageSource = readFileSync(
  resolve(process.cwd(), "src/app/workspace/page.tsx"),
  "utf8"
)

const layoutSource = readFileSync(
  resolve(process.cwd(), "src/app/workspace/layout.tsx"),
  "utf8"
)

describe("workspace page and global surfaces", () => {
  it("renders conversation details through the pane content, not the page", () => {
    const paneSource = readFileSync(
      resolve(
        process.cwd(),
        "src/components/workspace/workspace-pane-content.tsx"
      ),
      "utf8"
    )
    expect(paneSource).toContain("<ConversationDetailPanel pane={pane} />")
    expect(pageSource).toContain("return null")
    expect(pageSource).not.toContain("SETTINGS_GLOBAL_TAB_ID")
    expect(pageSource).not.toContain("LazySettingsWorkspaceView")
  })

  it("hosts the settings global surface in the main center workspace (layout)", () => {
    expect(layoutSource).toContain('data-workspace-primary-pane="files"')
    expect(layoutSource).toContain(
      "data-workspace-global-tab-id={SETTINGS_GLOBAL_TAB_ID}"
    )
    expect(layoutSource).toContain("<LazySettingsWorkspaceView />")
  })

  it("no longer projects the retired project-boot global surface", () => {
    expect(pageSource).not.toContain("PROJECT_BOOT_GLOBAL_TAB_ID")
    expect(pageSource).not.toContain("ProjectBootWorkspace")
    expect(layoutSource).not.toContain("PROJECT_BOOT_GLOBAL_TAB_ID")
    expect(layoutSource).not.toContain("ProjectBootWorkspace")
  })
})
