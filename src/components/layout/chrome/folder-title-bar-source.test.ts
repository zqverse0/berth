import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(
  resolve(process.cwd(), "src/components/layout/chrome/folder-title-bar.tsx"),
  "utf8"
)

describe("mobile folder title bar terminal architecture", () => {
  it("does not expose a projectless resource or legacy terminal entry", () => {
    expect(source).not.toContain("<NewResourceMenu")
    expect(source).not.toContain("openChatModeTab")
    expect(source).not.toContain("defaultFolderId={null}")
    expect(source).not.toContain("useTerminalContext")
    expect(source).not.toContain("toggleTerminal")
  })
})
