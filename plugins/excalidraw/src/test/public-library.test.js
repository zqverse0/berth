import { afterEach, expect, it, vi } from "vitest"
import library from "../../private/library.js"
const fetch = vi.fn()
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})
const host = () => vi.stubGlobal("berth", { http: { fetch } })

it("读取官方素材目录，来源仅返回可展示的字段", async () => {
  host()
  fetch.mockResolvedValue({
    status: 200,
    text: JSON.stringify([
      {
        id: "icons",
        name: "Icons",
        source: "author/icons.excalidrawlib",
        authors: [{ name: "Author" }],
        description: "Shapes",
      },
      null,
      {},
    ]),
  })
  expect(await library({ action: "publicCatalog" })).toEqual([
    {
      id: "icons",
      name: "Icons",
      source: "author/icons.excalidrawlib",
      authors: "Author",
      description: "Shapes",
    },
  ])
  expect(fetch.mock.calls[0][0]).toBe(
    "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries.json"
  )
})

it("仅从官方仓库取素材，拒绝路径越界或任意网址", async () => {
  host()
  fetch.mockResolvedValue({ status: 200, text: '{"type":"excalidrawlib"}' })
  expect(
    await library({
      action: "publicLibrary",
      source: "author/icons.excalidrawlib",
    })
  ).toEqual({ content: '{"type":"excalidrawlib"}' })
  expect(fetch.mock.calls[0][0]).toBe(
    "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/author/icons.excalidrawlib"
  )
  for (const source of [
    "../secret.excalidrawlib",
    "https://evil.test/a.excalidrawlib",
    "/x.excalidrawlib",
    "a\\x.excalidrawlib",
    "file.txt",
    "a/x.excalidrawlib?token=secret",
  ])
    await expect(library({ action: "publicLibrary", source })).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
})

it("目录和下载出错时不伪装成成功", async () => {
  host()
  fetch.mockResolvedValue({ status: 503, text: "unavailable" })
  await expect(library({ action: "publicCatalog" })).rejects.toThrow("503")
  fetch.mockResolvedValue({ status: 200, text: "{}" })
  await expect(library({ action: "publicCatalog" })).rejects.toThrow("catalog")
})
