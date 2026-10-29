import { render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PointerSelectionAction } from "@/pointer"
import type { TextFileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { HtmlPreview } from "./html-preview"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const openFilePreview = vi.fn()
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ openFilePreview }),
}))
const actions: PointerSelectionAction[] = []
vi.mock("@/pointer", () => ({
  useOptionalPointer: () => ({
    registerSelectionAction: (action: PointerSelectionAction) => {
      actions.push(action)
      return () => actions.splice(actions.indexOf(action), 1)
    },
  }),
}))

// A fake frame: the test decides when "load" fires and sees every post.
const post = vi.fn()
let frame: EventTarget & { contentWindow: { postMessage: typeof post } }
vi.mock("@/components/files/sandboxed-html-document", () => ({
  SandboxedHtmlDocument: ({
    onFrame,
  }: {
    onFrame?: (frame: unknown) => void
  }) => {
    onFrame?.(frame)
    return null
  },
}))

const tab = {
  kind: "file",
  path: "/repo/a.html",
  content: "<p>a</p>\n<p>b</p>",
} as TextFileWorkspaceTab

async function renderPreview(revealLine: number | null) {
  render(<HtmlPreview tab={tab} rootPath="/repo" revealLine={revealLine} />)
  // Picking state is posted once the frame is attached.
  await waitFor(() => expect(post).toHaveBeenCalled())
}

const load = () => frame.dispatchEvent(new Event("load"))
const revealsSent = () =>
  post.mock.calls.filter(([message]) => "revealLine" in (message as object))

describe("HtmlPreview", () => {
  beforeEach(() => {
    openFilePreview.mockClear()
    post.mockClear()
    actions.length = 0
    frame = Object.assign(new EventTarget(), {
      contentWindow: { postMessage: post },
    })
  })

  it("reveals the editor cursor line on the first load only", async () => {
    await renderPreview(2)
    expect(revealsSent()).toHaveLength(0)
    load()
    load()
    expect(revealsSent()).toEqual([
      [{ type: "berth:preview-view", revealLine: 2 }, "*"],
    ])
  })

  it("sends no reveal without a cursor line", async () => {
    await renderPreview(null)
    load()
    expect(revealsSent()).toHaveLength(0)
  })

  it("offers 'show in source' only for this file's preview line selections", async () => {
    await renderPreview(null)
    const action = actions.find((a) => a.id === "html-show-in-source")!
    const selection = (path: string, editable = false) => ({
      excerpt: "b",
      editable,
      source: {
        identity: { type: "file" as const, path },
        span: { unit: "lines" as const, start: 2, end: 3 },
        excerpt: "b",
      },
    })
    expect(action.matches(selection("/repo/a.html"))).toBe(true)
    expect(action.matches(selection("/repo/a.html", true))).toBe(false)
    expect(action.matches(selection("/repo/other.html"))).toBe(false)

    const closeMenu = vi.fn()
    action.onActivate!({
      selection: selection("/repo/a.html"),
      closeMenu,
      openPanel: vi.fn(),
      backToMenu: vi.fn(),
    })
    expect(closeMenu).toHaveBeenCalled()
    expect(openFilePreview).toHaveBeenCalledWith("/repo/a.html", { line: 2 })
  })
})
