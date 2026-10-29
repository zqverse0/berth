import LZString from "lz-string"
import { describe, expect, it } from "vitest"
import { parseExcalidrawFile, serializeExcalidrawFile } from "./excalidraw-file"

const scene = {
  type: "excalidraw",
  version: 2,
  source: "obsidian",
  elements: [
    { id: "aB3dE6gH", type: "text", text: "旧文本", originalText: "旧文本" },
    { id: "rect0001", type: "rectangle" },
  ],
  appState: {},
  files: {},
}

const obsidianFile = (drawing: string, kind = "compressed-json") => `---

excalidraw-plugin: parsed
tags: [excalidraw]
custom: keep-me

---
用户自己写的说明

# Excalidraw Data

## Text Elements
旧文本 ^aB3dE6gH

## Element Links
rect0001: [[某笔记]]

## Embedded Files
f1a2b3c4d5: [[assets/pic.png]]

%%
## Drawing
\`\`\`${kind}
${drawing}
\`\`\`
%%`

describe("excalidraw file codec", () => {
  it("treats empty files as an empty board", () => {
    expect(parseExcalidrawFile("x.excalidraw", "").scene).toBeNull()
    expect(parseExcalidrawFile("x.excalidraw.md", "").scene).toBeNull()
  })

  it("reads compressed and plain Obsidian drawings with embedded files", () => {
    const json = JSON.stringify(scene)
    for (const file of [
      obsidianFile(
        LZString.compressToBase64(json).replace(/(.{256})/g, "$1\n\n")
      ),
      obsidianFile(json, "json"),
    ]) {
      const data = parseExcalidrawFile("d.excalidraw.md", file)
      expect(data.scene).toEqual(scene)
      expect(data.embeddedFiles).toEqual({ f1a2b3c4d5: "assets/pic.png" })
    }
  })

  it("writes back only text elements and drawing, keeping the shell", () => {
    const previous = obsidianFile(
      LZString.compressToBase64(JSON.stringify(scene))
    )
    const edited = {
      ...scene,
      elements: [
        { ...scene.elements[0], text: "新文本", originalText: "新文本" },
        scene.elements[1],
        // 新建元素 21 位 id：不进 Text Elements，交给插件补登
        { id: "x".repeat(21), type: "text", text: "新增" },
      ],
      files: {
        f1a2b3c4d5: { dataURL: "data:..." },
        pasted: { dataURL: "data:p" },
      },
    }
    const next = serializeExcalidrawFile(
      "d.excalidraw.md",
      previous,
      JSON.stringify(edited)
    )
    expect(next).toContain("custom: keep-me")
    expect(next).toContain("用户自己写的说明")
    expect(next).toContain("rect0001: [[某笔记]]")
    expect(next).toContain("f1a2b3c4d5: [[assets/pic.png]]")
    expect(next).toContain(
      "## Text Elements\n新文本 ^aB3dE6gH\n\n## Element Links"
    )
    expect(next).not.toContain("新增 ^")
    expect(next).toContain("```compressed-json\n")

    const reread = parseExcalidrawFile("d.excalidraw.md", next).scene
    expect(reread?.files).toEqual({ pasted: { dataURL: "data:p" } })
    expect(JSON.stringify(reread)).toContain("新文本")
    expect((reread as { source?: string }).source).toBe("obsidian")
    // 再写一次结果不变（无漂移）
    expect(
      serializeExcalidrawFile("d.excalidraw.md", next, JSON.stringify(edited))
    ).toBe(next)
  })

  it("creates the Obsidian shell for a new .excalidraw.md", () => {
    const next = serializeExcalidrawFile(
      "n.excalidraw.md",
      "",
      JSON.stringify(scene)
    )
    expect(next).toContain("excalidraw-plugin: parsed")
    expect(parseExcalidrawFile("n.excalidraw.md", next).scene).toEqual({
      ...scene,
      source: "https://github.com/zsviczian/obsidian-excalidraw-plugin",
    })
  })

  it("passes plain .excalidraw through as JSON", () => {
    const json = JSON.stringify(scene)
    expect(serializeExcalidrawFile("p.excalidraw", "", json)).toBe(json)
  })
})
