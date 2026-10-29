import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TabItem } from "@/stores/tab-store"
import { useTabStore } from "@/stores/tab-store"
import {
  clearDocument,
  registerDocument,
  resetDocumentContextStore,
  useDocumentContextStore,
} from "./document-context-store"

const { setCurrentDocumentContext, clearCurrentDocumentContext } = vi.hoisted(
  () => ({
    setCurrentDocumentContext: vi.fn(),
    clearCurrentDocumentContext: vi.fn(),
  })
)

vi.mock("@/lib/api", () => ({
  setCurrentDocumentContext,
  clearCurrentDocumentContext,
}))

function convTab(id: string, conversationId: number): TabItem {
  return {
    id,
    kind: "conversation",
    folderId: 1,
    conversationId,
  } as unknown as TabItem
}

const CONV_A = convTab("tab-a", 101)
const CONV_B = convTab("tab-b", 202)

function activateTab(tab: TabItem): void {
  useTabStore.setState({ tabs: [tab], activeTabId: tab.id })
}

beforeEach(() => {
  vi.useFakeTimers()
  activateTab(CONV_A)
  resetDocumentContextStore()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  resetDocumentContextStore()
})

const get = () => useDocumentContextStore.getState()

/** 推进防抖(180ms)并冲刷同步队列微任务。 */
async function flushSync(conversationChanged = false): Promise<void> {
  await vi.advanceTimersByTimeAsync(conversationChanged ? 0 : 200)
}

it("公开 store 和渲染适配层不再提供文档投递动作或回执", async () => {
  const documentContext = await import("./document-context-store")
  const { useDocumentContext } = await import("@/contexts/document-context")
  expect(documentContext).not.toHaveProperty("sendDocument")
  expect(useDocumentContext()).not.toHaveProperty("sendDocument")
  expect(get()).not.toHaveProperty("lastReport")
})

describe("registerDocument", () => {
  it("注册文档后 current 暴露文档", () => {
    registerDocument({ kind: "file", path: "/tmp/a.md", content: "hi" })
    expect(get().current?.document.path).toBe("/tmp/a.md")
  })

  it("仅元数据更新保留已有 content 快照", () => {
    registerDocument({ kind: "file", path: "/tmp/a.md", content: "body" })
    registerDocument({ kind: "file", path: "/tmp/a.md", title: "A" })
    expect(get().current?.document.content).toBe("body")
    expect(get().current?.document.title).toBe("A")
  })

  it("换文档替换整个上下文", () => {
    registerDocument({ kind: "file", path: "/tmp/a.md", content: "a" })
    registerDocument({ kind: "pdf", path: "/tmp/b.pdf", content: "b" })
    expect(get().current?.document.kind).toBe("pdf")
    expect(get().current?.document.content).toBe("b")
  })

  it("空 kind 被忽略", () => {
    registerDocument({ kind: "  " })
    expect(get().current).toBeNull()
  })

  it("防抖后同步到后端", async () => {
    registerDocument({ kind: "file", path: "/tmp/a.md", content: "body" })
    await flushSync()
    expect(setCurrentDocumentContext).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 101, kind: "file" })
    )
  })

  it("相等重复注册不触发第二次同步", async () => {
    registerDocument({ kind: "file", path: "/tmp/a.md", content: "body" })
    await flushSync()
    expect(setCurrentDocumentContext).toHaveBeenCalledTimes(1)
    registerDocument({ kind: "file", path: "/tmp/a.md", content: "body" })
    await flushSync()
    expect(setCurrentDocumentContext).toHaveBeenCalledTimes(1)
  })
})

describe("clearDocument", () => {
  it("清空当前文档", () => {
    registerDocument({ kind: "file", path: "/tmp/a.md" })
    clearDocument()
    expect(get().current).toBeNull()
  })

  it("id 不匹配时不动", () => {
    registerDocument({ kind: "file", path: "/tmp/a.md", id: "doc-1" })
    clearDocument("doc-other")
    expect(get().current?.document.path).toBe("/tmp/a.md")
  })

  it("清空后防抖同步走 clear 通道", async () => {
    registerDocument({ kind: "file", path: "/tmp/a.md" })
    clearDocument()
    await flushSync()
    expect(clearCurrentDocumentContext).toHaveBeenCalledWith(101)
  })
})

describe("会话切换(tab store 反应)", () => {
  it("切换会话把当前文档同步到新会话(0ms 防抖)", async () => {
    registerDocument({ kind: "file", path: "/tmp/a.md", content: "body" })
    await flushSync()
    activateTab(CONV_B)
    await flushSync(true)
    expect(setCurrentDocumentContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: 202 })
    )
  })
})
