import { describe, expect, it, vi } from "vitest"

const { request, connect } = vi.hoisted(() => {
  const request = vi.fn<
    (method: string, params: Record<string, unknown>) => Promise<unknown>
  >(async () => "data:image/svg+xml,x")
  const connect = vi.fn(() => ({
    request,
    send: vi.fn(),
    update: vi.fn(),
    dispose: vi.fn(),
  }))
  return { request, connect }
})
vi.mock("@/lib/plugins/plugin-page", () => ({
  connectPluginPage: connect,
  pluginAssetUrl: (plugin: string, path: string) =>
    `/__berth/plugin/${plugin}/${path}`,
  pluginFrameSandbox: () => "allow-scripts",
}))

import { usePluginViewsStore, type PluginEditor } from "./plugin-views"
import { embedEditorForPath, renderPluginEmbed } from "./plugin-embed"

const drawing: PluginEditor = {
  plugin: "excalidraw",
  id: "drawing",
  title: "Excalidraw",
  suffixes: [".excalidraw", ".excalidraw.md"],
  page: "page/index.html",
  new: [],
  embed: true,
  permissions: ["project.files"],
}

describe("plugin embeds", () => {
  it("finds only embeddable editors by suffix", () => {
    usePluginViewsStore.setState({
      editors: [
        drawing,
        { ...drawing, id: "plain", suffixes: [".txt"], embed: false },
      ],
    })
    expect(embedEditorForPath("/p/A.excalidraw.md")?.id).toBe("drawing")
    expect(embedEditorForPath("/p/notes.txt")).toBeNull()
  })

  it("renders through one hidden page per root, with paths relative to it", async () => {
    await expect(
      renderPluginEmbed(drawing, "/repo/docs/a.excalidraw", "{}", "/repo")
    ).resolves.toBe("data:image/svg+xml,x")
    await renderPluginEmbed(drawing, "/repo/b.excalidraw", "{}", "/repo/")
    expect(connect).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenNthCalledWith(1, "editor.render", {
      path: "docs/a.excalidraw",
      content: "{}",
      theme: "light",
    })
    expect(request.mock.calls[1][1]).toMatchObject({ path: "b.excalidraw" })
    // 根外的画板：根换成它所在的目录，另开一个页面
    await renderPluginEmbed(drawing, "/elsewhere/c.excalidraw", "{}", "/repo")
    expect(connect).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[2][1]).toMatchObject({ path: "c.excalidraw" })
    expect(document.querySelectorAll("iframe[aria-hidden]")).toHaveLength(2)
  })

  it("treats non-image results as no image", async () => {
    request.mockResolvedValueOnce("not an image")
    await expect(
      renderPluginEmbed(drawing, "/repo/d.excalidraw", "{}", "/repo")
    ).resolves.toBeNull()
  })
})
