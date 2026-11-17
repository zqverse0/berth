import { describe, expect, it, vi } from "vitest"
vi.mock("@excalidraw/excalidraw", () => ({
  MIME_TYPES: { excalidrawlib: "application/vnd.excalidrawlib+json" },
  serializeLibraryAsJSON: JSON.stringify,
}))
import { selectedLibraryElements, pickLibraryItems } from "../shape-library.js"

describe("收藏选区", () => {
  it("带上框内文字和嵌套 frame 子元素，不带未选中的外部箭头或假选区", () => {
    const elements = [
      { id: "outer", type: "frame" },
      { id: "inner", type: "frame", frameId: "outer" },
      {
        id: "box",
        type: "rectangle",
        frameId: "inner",
        boundElements: [
          { id: "text", type: "text" },
          { id: "arrow", type: "arrow" },
        ],
      },
      { id: "text", type: "text" },
      { id: "arrow", type: "arrow" },
      { id: "unselected", type: "rectangle" },
    ].reverse()
    const api = {
      getSceneElements: () => elements,
      getAppState: () => ({
        selectedElementIds: { outer: true, unselected: false },
      }),
    }
    expect(
      selectedLibraryElements(api)
        .map((element) => element.id)
        .sort()
    ).toEqual(["box", "inner", "outer", "text"])
    api.getAppState = () => ({ selectedElementIds: {} })
    expect(selectedLibraryElements(api)).toEqual([])
  })
})

it("导出到项目时不覆盖已有文件，坏数据不落盘", async () => {
  const writeText = vi.fn()
  vi.stubGlobal("berth", {
    storage: { dir: "/state" },
    env: { project: async () => ({ root: "/repo" }) },
    fs: {
      mkdir: vi.fn(),
      stat: async (path) =>
        path === "/repo/figures/library.excalidrawlib" ? {} : null,
      writeText,
    },
  })
  const { default: library } = await import("../../private/library.js")
  const content = JSON.stringify({
    type: "excalidrawlib",
    version: 2,
    libraryItems: [],
  })
  await expect(library({ action: "exportShapes", content })).resolves.toEqual({
    path: "/repo/figures/library-2.excalidrawlib",
  })
  expect(writeText).toHaveBeenCalledWith(
    "/repo/figures/library-2.excalidrawlib",
    content
  )
  await expect(
    library({ action: "exportShapes", content: '{"type":"excalidraw"}' })
  ).rejects.toThrow("library")
  expect(writeText).toHaveBeenCalledTimes(1)
})

it("批量素材操作先校验完整选区，拒绝未知和重复 ID", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }]
  expect(pickLibraryItems(items, ["a", "c"])).toEqual([items[0], items[2]])
  for (const ids of [[], ["unknown"], ["a", "unknown"], ["a", "a"], [1], "a"])
    expect(() => pickLibraryItems(items, ids)).toThrow()
})
