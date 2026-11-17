import { afterEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const api = vi.hoisted(() => ({
  request: vi.fn(),
  run: vi.fn(),
  attach: vi.fn(),
  notify: vi.fn(),
  copy: vi.fn(),
}))
vi.mock("../clipboard.js", () => ({ copyText: api.copy }))
vi.stubGlobal("berth", {
  ui: { locale: "zh-CN", notify: api.notify },
  editor: { request: api.request },
  scripts: { run: api.run },
  agent: { attach: api.attach },
})
const { HistoryPanel, describeSelection } = await import("../history-panel.jsx")

const mount = (isCurrent = () => true) =>
  render(
    <HistoryPanel
      path="/repo/a.excalidraw"
      editorPath="a.excalidraw"
      revision={0}
      selected={2}
      isCurrent={isCurrent}
    />
  )
const typeRequest = () => {
  fireEvent.change(
    screen.getByRole("textbox", { name: "修改要求", exact: true }),
    {
      target: { value: "改成蓝色" },
    }
  )
  fireEvent.click(
    screen.getByRole("button", { name: "保存要求并复制给 Agent" })
  )
}
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  sessionStorage.clear()
})

describe("侧栏改图", () => {
  it("保存后复制完整路径、要求、选区和存档说明，不投递也不清空草稿", async () => {
    api.run.mockResolvedValue({ versions: [] })
    api.request.mockResolvedValue({
      content: "latest unsaved",
      selection: ["rect-1 (rectangle)"],
    })
    mount()
    expect(screen.getByText("已选中 2 个元素，只改它们")).toBeTruthy()
    typeRequest()
    await waitFor(() => expect(api.copy).toHaveBeenCalledTimes(1))
    expect(api.run).toHaveBeenCalledWith("private/history.js", {
      action: "request",
      path: "/repo/a.excalidraw",
      content: "latest unsaved",
      text: "改成蓝色",
    })
    expect(api.copy.mock.calls[0][0]).toContain("rect-1")
    expect(api.copy.mock.calls[0][0]).toContain("/repo/a.excalidraw")
    expect(api.copy.mock.calls[0][0]).toContain("改成蓝色")
    expect(api.copy.mock.calls[0][0]).toContain("private/history.js apply")
    expect(api.attach).not.toHaveBeenCalled()
    expect(
      screen.getByRole("textbox", { name: "修改要求", exact: true })
    ).toHaveValue("改成蓝色")
  })

  it("等待存档时切换文件，不复制过期目标", async () => {
    let resolve
    let current = true
    api.run.mockImplementation((_, input) =>
      input.action === "request"
        ? new Promise((done) => {
            resolve = done
          })
        : Promise.resolve({ versions: [] })
    )
    api.request.mockResolvedValue({ content: "unsaved", selection: [] })
    mount(() => current)
    typeRequest()
    await waitFor(() => expect(resolve).toBeTypeOf("function"))
    current = false
    resolve({ versions: [] })
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "保存要求并复制给 Agent" }).disabled
      ).toBe(false)
    )
    expect(api.copy).not.toHaveBeenCalled()
    expect(api.attach).not.toHaveBeenCalled()
  })

  it("恢复通过编辑器并带最新内容校验，不直接覆盖磁盘", async () => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      }
    )
    api.run.mockImplementation((_, input) =>
      Promise.resolve(
        input.action === "restore"
          ? { content: "old" }
          : { versions: [{ id: 1, hash: "x", by: "agent", time: 0 }] }
      )
    )
    api.request.mockResolvedValue({ content: "latest", selection: [] })
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "回到这一版" }))
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith("a.excalidraw", "restore", {
        content: "old",
        expected: "latest",
      })
    )
  })
  it("多个画板的草稿相互独立，切换回来后仍保留", async () => {
    api.run.mockResolvedValue({ versions: [] })
    api.request.mockResolvedValue({ content: "latest", selection: [] })
    const a = mount()
    fireEvent.change(
      screen.getByRole("textbox", { name: "修改要求", exact: true }),
      {
        target: { value: "A 的要求" },
      }
    )
    a.unmount()
    const b = render(
      <HistoryPanel
        path="/repo/b.excalidraw"
        editorPath="b.excalidraw"
        revision={0}
        selected={0}
        isCurrent={() => true}
      />
    )
    expect(
      screen.getByRole("textbox", { name: "修改要求", exact: true })
    ).toHaveValue("")
    fireEvent.change(
      screen.getByRole("textbox", { name: "修改要求", exact: true }),
      {
        target: { value: "B 的要求" },
      }
    )
    b.unmount()
    await act(async () => {
      mount()
    })
    expect(
      screen.getByRole("textbox", { name: "修改要求", exact: true })
    ).toHaveValue("A 的要求")
    expect(screen.getByText("当前画板：a.excalidraw")).toBeTruthy()
  })

  it("复制期间继续输入的新草稿不被清掉", async () => {
    api.run.mockResolvedValue({ versions: [] })
    api.request.mockResolvedValue({ content: "latest", selection: [] })
    let sent
    api.copy.mockImplementation(
      () =>
        new Promise((done) => {
          sent = done
        })
    )
    mount()
    typeRequest()
    await waitFor(() => expect(sent).toBeTypeOf("function"))
    fireEvent.change(
      screen.getByRole("textbox", { name: "修改要求", exact: true }),
      {
        target: { value: "下一条要求" },
      }
    )
    sent()
    await waitFor(() => expect(api.notify).toHaveBeenCalled())
    expect(
      screen.getByRole("textbox", { name: "修改要求", exact: true })
    ).toHaveValue("下一条要求")
  })

  it("选区超过 30 个元素时不再静默截断", () => {
    const elements = Array.from({ length: 45 }, (_, n) => ({
      id: `shape-${n}`,
      type: "rectangle",
    }))
    const selectedElementIds = Object.fromEntries(
      elements.map(({ id }) => [id, true])
    )
    expect(
      describeSelection({
        getAppState: () => ({ selectedElementIds }),
        getSceneElements: () => elements,
      })
    ).toHaveLength(45)
  })
  it("自动复制失败时保留草稿并展示可以手动复制的完整说明", async () => {
    api.run.mockResolvedValue({ versions: [] })
    api.request.mockResolvedValue({ content: "latest", selection: ["rect-1"] })
    api.copy.mockRejectedValue(new Error("请手动复制"))
    mount()
    typeRequest()
    expect(await screen.findByRole("alert")).toHaveTextContent("请手动复制")
    const preview = screen.getByRole("textbox", { name: "给 Agent 的修改说明" })
    expect(preview.value).toContain("/repo/a.excalidraw")
    expect(preview.value).toContain("改成蓝色")
    expect(preview.readOnly).toBe(true)
    expect(
      sessionStorage.getItem("excalidraw:revise-draft:/repo/a.excalidraw")
    ).toBe("改成蓝色")
    expect(api.attach).not.toHaveBeenCalled()
    expect(api.notify).not.toHaveBeenCalled()
  })

  it("存档失败不提示已复制，也不丢失要求", async () => {
    api.run.mockImplementation((_, input) =>
      input.action === "request"
        ? Promise.reject(new Error("disk full"))
        : Promise.resolve({ versions: [] })
    )
    api.request.mockResolvedValue({ content: "latest", selection: [] })
    mount()
    typeRequest()
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full")
    expect(api.copy).not.toHaveBeenCalled()
    expect(api.attach).not.toHaveBeenCalled()
    expect(
      screen.getByRole("textbox", { name: "修改要求", exact: true })
    ).toHaveValue("改成蓝色")
  })
})
