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
    await handlePageCall(host({ openFile }), "files.open", {
      path: "/main/b.md",
    })
    expect(openFile).toHaveBeenLastCalledWith("/main/b.md")
    await handlePageCall(host({ openFile }), "files.open", { path: "b.md" })
    expect(openFile).toHaveBeenCalledWith("/repo/b.md")
    await expect(
      handlePageCall(host(), "process.run", {})
    ).rejects.toMatchObject({ reason: "unsupported" })
    await expect(
      handlePageCall(host(), "ui.openUrl", { url: "javascript:alert(1)" })
    ).rejects.toMatchObject({ reason: "invalid-params" })
  })
  it("hands sessions.open to the host without a permission", async () => {
    const openSession = vi.fn()
    await handlePageCall(
      host({ permissions: [], openSession }),
      "sessions.open",
      {
        agent: "pi",
        sessionId: "s1",
        cwd: "/repo",
      }
    )
    expect(openSession).toHaveBeenCalledWith({
      agent: "pi",
      sessionId: "s1",
      cwd: "/repo",
      title: null,
    })
    await expect(
      handlePageCall(host({ openSession }), "sessions.open", { agent: "pi" })
    ).rejects.toMatchObject({ reason: "invalid-params" })
    await expect(
      handlePageCall(host(), "sessions.open", {
        agent: "pi",
        sessionId: "s1",
        cwd: "/repo",
      })
    ).rejects.toMatchObject({ reason: "unsupported" })
  })

  it("hands agent.attach text to the host only with the agent permission", async () => {
    const sendToAgent = vi.fn()
    await expect(
      handlePageCall(host({ sendToAgent }), "agent.attach", { text: "hi" })
    ).rejects.toMatchObject({ reason: "denied" })
    await handlePageCall(
      host({ permissions: ["agent"], sendToAgent }),
      "agent.attach",
      { label: "x", text: "hi" }
    )
    expect(sendToAgent).toHaveBeenCalledWith("hi")
  })
  it("serves devices only with the devices permission, with host status and selection", async () => {
    const { useDeviceSnapshotStore, useDevicesPanelStore } =
      await import("@/lib/devices")
    const device = {
      id: 3,
      name: "gpu",
      target: "gpu",
      localDir: "/d/3",
      node: { berth: "/b/berth", status: null },
      shown: ["/home/k/app"],
    }
    useDeviceSnapshotStore.setState({
      devices: [device],
      statusOf: () => ({ state: "online", message: null, keyMissing: false }),
    })
    useDevicesPanelStore.setState({ selected: 3 })
    await expect(
      handlePageCall(host(), "devices.list", {})
    ).rejects.toMatchObject({ reason: "denied" })
    expect(
      await handlePageCall(
        host({ permissions: ["devices"] }),
        "devices.list",
        {}
      )
    ).toEqual({
      devices: [
        {
          id: 3,
          name: "gpu",
          target: "gpu",
          node: true,
          shown: ["/home/k/app"],
          status: "online",
          message: null,
          keyMissing: false,
        },
      ],
      selected: 3,
    })
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
  it("routes sidebar requests only to the current writable editor of the same plugin and project", async () => {
    const editor = mount()
    editor.fromPage({ method: "page.hello" })
    await vi.waitFor(() => expect(editor.posted).toHaveLength(1))
    let path: string | null = "/repo/a.excalidraw"
    const viewHost = host({
      context: { kind: "view", id: "gallery", params: {} },
      activeEditorPath: () => path,
    })
    expect(await handlePageCall(viewHost, "editor.active", {})).toEqual({
      path: "a.excalidraw",
    })
    expect(
      await handlePageCall(
        { ...viewHost, plugin: "other" },
        "editor.active",
        {}
      )
    ).toBeNull()
    expect(
      await handlePageCall({ ...viewHost, root: "/other" }, "editor.active", {})
    ).toBeNull()
    const pending = handlePageCall(viewHost, "editor.request", {
      path: "a.excalidraw",
      method: "snapshot",
    })
    const request = editor.posted[1] as { id: number; method: string }
    expect(request.method).toBe("editor.request")
    editor.fromPage({ id: request.id, result: { content: "latest unsaved" } })
    await expect(pending).resolves.toEqual({ content: "latest unsaved" })
    path = "/repo/b.excalidraw"
    await expect(
      handlePageCall(viewHost, "editor.request", {
        path: "a.excalidraw",
        method: "restore",
      })
    ).rejects.toMatchObject({ reason: "unavailable" })
    path = "/repo/a.excalidraw"
    const stale = handlePageCall(viewHost, "editor.request", {
      path: "a.excalidraw",
      method: "snapshot",
    })
    const staleRequest = editor.posted[2] as { id: number }
    path = null
    editor.fromPage({ id: staleRequest.id, result: "stale" })
    await expect(stale).rejects.toMatchObject({ reason: "unavailable" })
    editor.connection.update(
      host({
        context: { ...host().context, readOnly: true } as PageHost["context"],
      })
    )
    path = "/repo/a.excalidraw"
    expect(await handlePageCall(viewHost, "editor.active", {})).toBeNull()
    editor.connection.dispose()
    expect(await handlePageCall(viewHost, "editor.active", {})).toBeNull()
  })

  it("validates sidebar header tabs", async () => {
    const setHeaderTabs = vi.fn()
    const view = host({ setHeaderTabs })
    await handlePageCall(view, "ui.setHeaderTabs", {
      tabs: [{ id: "revise", label: "改图" }],
      value: "revise",
    })
    expect(setHeaderTabs).toHaveBeenCalledWith(
      [{ id: "revise", label: "改图" }],
      "revise"
    )
    await expect(
      handlePageCall(view, "ui.setHeaderTabs", { tabs: [{}], value: "revise" })
    ).rejects.toMatchObject({ reason: "invalid-params" })
  })
})
