import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const viewerSource = readFileSync(
  resolve(process.cwd(), "src/components/files/viewers/text-file-viewer.tsx"),
  "utf8"
)
const saveSource = readFileSync(
  resolve(process.cwd(), "src/components/files/viewers/use-file-tab-save.ts"),
  "utf8"
)

describe("text file viewer CodeMirror composition wiring", () => {
  it("uses the stable tab identity for editor state and content updates", () => {
    expect(viewerSource).toMatch(/documentId=\{`file-tab:\$\{scope\}`\}/)
    expect(viewerSource).toMatch(/updateFileTabContent\(scope, value\)/)
    expect(viewerSource).toMatch(/onChange=\{handleEditorChange\}/)
  })

  it("pauses autosave while the originating tab is composing", () => {
    expect(viewerSource).toMatch(/onCompositionChange=\{\(composing\) => \{/)
    expect(viewerSource).toMatch(/setFileTabComposing\(scope, composing\)/)
    expect(viewerSource).toMatch(
      /useFileTabSave\(tab, \{ active, isComposing \}\)/
    )
    expect(saveSource).toMatch(/fileSaveState !== "idle" \|\| isComposing/)
  })

  it("does not retain a legacy controlled value path", () => {
    expect(viewerSource).not.toMatch(/imeSafeEditorValue|legacyEditorRef/)
  })

  it("文档菜单不再投递到 Agent，复制内容与出处仅依赖选区", () => {
    expect(viewerSource).not.toMatch(
      /\b(sendDocument|canSendSelection|canSendDocument|addFileToChat)\b/
    )
    expect(viewerSource).toMatch(
      /<ContextMenuItem\s+disabled=\{!hasEditorSelection\}\s+onSelect=\{copyEditorSource\}/
    )
  })
})
