import { afterEach, expect, it, vi } from "vitest"
import { copyText } from "../clipboard.js"
afterEach(() => {
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it("先用浏览器剪贴板 API", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal("navigator", { clipboard: { writeText } })
  await copyText("instructions", "copy failed")
  expect(writeText).toHaveBeenCalledWith("instructions")
  expect(document.querySelector("textarea")).toBeNull()
})

it("剪贴板 API 不可用时回退浏览器复制命令，并清理临时节点", async () => {
  vi.stubGlobal("navigator", {})
  const execCommand = vi.fn(() => {
    expect(document.querySelector("textarea").value).toBe("instructions")
    return true
  })
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
  })
  const button = document.createElement("button")
  document.body.append(button)
  button.focus()
  await copyText("instructions", "copy failed")
  expect(execCommand).toHaveBeenCalledWith("copy")
  expect(document.querySelector("textarea")).toBeNull()
  expect(document.activeElement).toBe(button)
})

it("复制失败明确 reject，不遗留节点或伪装成功", async () => {
  vi.stubGlobal("navigator", {})
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => false,
  })
  await expect(copyText("instructions", "请手动复制")).rejects.toThrow(
    "请手动复制"
  )
  expect(document.querySelector("textarea")).toBeNull()
})
