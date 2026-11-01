import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  readWorkspaceFileBase64: vi.fn(async () => btoa("hello")),
}))
vi.mock("@/lib/platform", () => ({ openUrl: vi.fn(async () => {}) }))
vi.mock("@/lib/plugins/plugin-views", () => ({
  callPluginBackend: vi.fn(async () => "stored"),
  runPluginAction: vi.fn(async () => 42),
}))

import { readWorkspaceFileBase64 } from "@/lib/api"
import {
  connectPluginPage,
  handlePageCall,
  resolvePagePath,
  type PageHost,
} from "./plugin-page"

const host = (overrides: Partial<PageHost> = {}): PageHost => ({
  plugin: "demo",
  permissions: ["project.files"],
  root: "/repo",
  project: { id: "1", name: "repo", root: "/repo" },
  locale: "en",
  context: {
    kind: "editor",
    id: "drawing",
    mode: "edit",
    path: "a.excalidraw",
    readOnly: false,
    content: "{}",
  },
  ...overrides,
})

describe("resolvePagePath", () => {
  it("normalises inside the root and rejects escapes", () => {
    expect(resolvePagePath("docs/./img/../a.png")).toBe("docs/a.png")
    expect(() => resolvePagePath("../x")).toThrow(/outside/)
    expect(() => resolvePagePath("/etc/passwd")).toThrow(/relative/)
    expect(() => resolvePagePath("C:/x")).toThrow(/relative/)
    expect(() => resolvePagePath("")).toThrow()
  })
})

describe("handlePageCall", () => {
  it("reads files relative to the root only with project.files", async () => {
    await expect(
      handlePageCall(host(), "files.readText", { path: "notes/a.md" })
    ).resolves.toBe("hello")
    expect(readWorkspaceFileBase64).toHaveBeenCalledWith("/repo", "notes/a.md")
    await expect(
      handlePageCall(host({ permissions: [] }), "files.readBase64", {
        path: "a",
      })
    ).rejects.toMatchObject({ reason: "denied" })
  })

  it("routes storage to the backend, opens files and rejects unknown methods", async () => {
    await expect(
      handlePageCall(host(), "storage.get", { key: "k" })
    ).resolves.toBe("stored")
    const openFile = vi.fn()
    await handlePageCall(host({ openFile }), "files.open", { path: "b.md" })
    expect(openFile).toHaveBeenCalledWith("/repo/b.md")
    await expect(
      handlePageCall(host(), "process.run", {})
    ).rejects.toMatchObject({ reason: "unsupported" })
    await expect(
      handlePageCall(host(), "ui.openUrl", { url: "javascript:alert(1)" })
    ).rejects.toMatchObject({ reason: "invalid-params" })
  })
})

describe("connectPluginPage", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

  const mount = (overrides: Partial<PageHost> = {}) => {
    const frame = document.createElement("iframe")
    document.body.append(frame)
    const posted: unknown[] = []
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(
      (message: unknown) => void posted.push(message)
    )
    const fromPage = (data: object) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { jsonrpc: "2.0", ...data },
          source: frame.contentWindow,
        })
      )
    const connection = connectPluginPage(frame, host(overrides))
    return { frame, posted, fromPage, connection }
  }

  it("answers hello with init and flushes queued events after it", async () => {
    const { posted, fromPage, connection } = mount()
    connection.send("editor.externalChange", { content: '{"v":2}' })
    expect(posted).toHaveLength(0)
    fromPage({ method: "page.hello" })
    await vi.waitFor(() => expect(posted).toHaveLength(2))
    expect(posted[0]).toMatchObject({
      method: "page.init",
      params: {
        context: { kind: "editor", path: "a.excalidraw" },
        locale: "en",
      },
    })
    expect(posted[1]).toMatchObject({
      method: "editor.externalChange",
      params: { content: '{"v":2}' },
    })
    connection.dispose()
  })

  it("passes changes up unless read-only, and ignores other windows", () => {
    const onChange = vi.fn()
    const { fromPage, connection } = mount({ onChange })
    fromPage({ method: "editor.change", params: { content: "next" } })
    expect(onChange).toHaveBeenCalledWith("next")
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          jsonrpc: "2.0",
          method: "editor.change",
          params: { content: "spoof" },
        },
        source: window,
      })
    )
    expect(onChange).toHaveBeenCalledTimes(1)
    connection.dispose()

    const readOnly = vi.fn()
    const other = mount({
      onChange: readOnly,
      context: {
        kind: "editor",
        id: "drawing",
        mode: "edit",
        path: "a",
        readOnly: true,
        content: "",
      },
    })
    other.fromPage({ method: "editor.change", params: { content: "x" } })
    expect(readOnly).not.toHaveBeenCalled()
    other.connection.dispose()
  })

  it("re-dispatches forwarded keys from the iframe element", () => {
    const { frame, fromPage, connection } = mount()
    const seen = vi.fn()
    window.addEventListener("keydown", seen)
    fromPage({
      method: "ui.key",
      params: { key: "s", code: "KeyS", ctrlKey: true },
    })
    expect(seen).toHaveBeenCalledTimes(1)
    const event = seen.mock.calls[0][0] as KeyboardEvent
    expect(event.ctrlKey).toBe(true)
    expect(event.target).toBe(frame)
    window.removeEventListener("keydown", seen)
    connection.dispose()
  })

  it("resolves page responses to host requests", async () => {
    const { posted, fromPage, connection } = mount()
    fromPage({ method: "page.hello" })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    const pending = connection.request("editor.render", { path: "a" })
    await vi.waitFor(() => expect(posted).toHaveLength(2))
    const request = posted[1] as { id: number }
    fromPage({ id: request.id, result: "data:image/svg" })
    await expect(pending).resolves.toBe("data:image/svg")
    connection.dispose()
  })
})
