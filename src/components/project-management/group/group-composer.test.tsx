import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { MemberRow } from "./group-model"
import { GroupComposer } from "./group-composer"

const openFileDialog = vi.hoisted(() => vi.fn())
vi.mock("@/lib/platform", () => ({
  isLocalDesktop: () => true,
  openFileDialog,
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = () => ({
    allFolders: [{ id: 7, path: "/repo" }],
    conversations: [],
  })
  const useAppWorkspaceStore = (
    select: (s: ReturnType<typeof state>) => unknown
  ) => select(state())
  useAppWorkspaceStore.getState = state
  useAppWorkspaceStore.subscribe = () => () => {}
  return { useAppWorkspaceStore }
})

const rows = ["a", "b"].map((name) => ({
  member: { name, bodies: [], joined_seq: 1, joined_at: null, leftAt: null },
  pane: null,
  status: "idle",
  unread: false,
  lastActivity: null,
})) as MemberRow[]

function composer(
  props: Partial<React.ComponentProps<typeof GroupComposer>> = {}
) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <GroupComposer
        folderId={7}
        rows={rows}
        targets={["a"]}
        onSend={vi.fn().mockResolvedValue([])}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

describe("GroupComposer recipient safety", () => {
  it("keeps a draft addressed to A when A leaves, blocked and never redirected to B", () => {
    const onSend = vi.fn()
    const view = render(composer({ onSend }))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "for A only" },
    })
    view.rerender(composer({ onSend, rows: [rows[1]] }))
    expect(screen.getByRole("button", { name: "Send to a" })).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unavailable recipients: a"
    )
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()
  })

  it("sends to an expert that is not in the group yet, by its name", async () => {
    const onSend = vi.fn().mockResolvedValue([])
    render(
      composer({
        onSend,
        rows: [],
        targets: ["dev"],
        experts: [{ id: "dev", name: "Dev", agent: "claude" }],
      })
    )
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send to Dev" }))
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(["dev"], "hello", undefined)
    )
  })

  it("sends to the members the text @-mentions, over the reply target", async () => {
    const onSend = vi.fn().mockResolvedValue([])
    const reply = {
      schema_version: 1,
      seq: 8,
      kind: "message" as const,
      timestamp_ms: 1000,
      author: "a",
      text: "question",
    }
    render(composer({ onSend, reply }))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "@b this answers A" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send to b" }))
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(["b"], "@b this answers A", 8)
    )
  })

  it("opens the @ list of members and everyone, and picks with the keyboard", async () => {
    const onSend = vi.fn().mockResolvedValue([])
    render(composer({ onSend, targets: [], inGroup: true }))
    const input = screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: "@", selectionStart: 1 } })
    expect(screen.getAllByRole("option")).toHaveLength(3)
    fireEvent.change(input, { target: { value: "hi @", selectionStart: 4 } })
    expect(
      screen
        .getAllByRole("option")
        .map((option) => option.dataset.mentionChoice)
    ).toEqual(["everyone", "a", "b"])
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(input.value).toBe("hi @b ")
    expect(screen.queryByRole("listbox")).toBeNull()
    // 收起后删掉重打 @，列表重新弹出。
    fireEvent.change(input, { target: { value: "hi ", selectionStart: 3 } })
    fireEvent.change(input, { target: { value: "hi @", selectionStart: 4 } })
    expect(screen.getAllByRole("option")).toHaveLength(3)
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByRole("listbox")).toBeNull()
    fireEvent.change(input, { target: { value: "hi @b ", selectionStart: 6 } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(["b"], "hi @b", undefined)
    )
  })

  it("refuses a shared name nobody picked", () => {
    const onSend = vi.fn().mockResolvedValue([])
    const twins = rows.map((row) => ({
      ...row,
      member: { ...row.member, label: "Twin" },
    }))
    render(composer({ onSend, rows: twins, targets: [] }))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "@Twin go" },
    })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Several members are named Twin"
    )
    expect(onSend).not.toHaveBeenCalled()
  })

  it("@-mentions experts outside the group, refusing those without an Agent", async () => {
    const onSend = vi.fn().mockResolvedValue([])
    render(
      composer({
        onSend,
        experts: [
          { id: "ops", name: "Ops", agent: "claude" },
          { id: "qa", name: "QA", agent: null },
        ],
        inGroup: true,
        targets: [],
      })
    )
    const input = screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: "@", selectionStart: 1 } })
    expect(
      screen
        .getAllByRole("option")
        .map((option) => option.dataset.mentionChoice)
    ).toEqual(["everyone", "a", "b", "ops", "qa"])
    fireEvent.change(input, { target: { value: "@QA look" } })
    expect(screen.getByRole("alert")).toHaveTextContent("QA has no Agent yet")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()
    // 配了 Agent 的照发，由后端让它入群。
    fireEvent.change(input, { target: { value: "@Ops look" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(["ops"], "@Ops look", undefined)
    )
  })

  it("preserves the draft and releases sending state after a rejected request", async () => {
    render(
      composer({ onSend: vi.fn().mockRejectedValue(new Error("network")) })
    )
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "keep this" } })
    fireEvent.click(screen.getByRole("button", { name: "Send to a" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Send failed")
    expect(input).toHaveValue("keep this")
    expect(screen.getByRole("button", { name: "Send to a" })).toBeEnabled()
  })
})

describe("GroupComposer file picker", () => {
  it("inserts picked files at the cursor, relative inside the project", async () => {
    openFileDialog.mockResolvedValue(["/repo/src/a.ts", "/other/b.md"])
    render(composer())
    const input = screen.getByRole<HTMLTextAreaElement>("textbox")
    fireEvent.change(input, { target: { value: "look at" } })
    input.setSelectionRange(7, 7)
    fireEvent.click(screen.getByRole("button", { name: "Insert file paths" }))
    await waitFor(() =>
      expect(input).toHaveValue("look at `src/a.ts` `/other/b.md` ")
    )
    expect(openFileDialog).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true, defaultPath: "/repo" })
    )
  })
})

describe("GroupComposer textarea sizing", () => {
  it("uses the existing content-sized Textarea for soft wraps and manual newlines", () => {
    render(composer())
    const input = screen.getByRole("textbox")
    expect(input).toHaveAttribute("data-slot", "textarea")
    expect(input).toHaveClass("field-sizing-content", "min-h-14", "max-h-48")
    fireEvent.change(input, { target: { value: "long text ".repeat(100) } })
    expect(input).toHaveValue("long text ".repeat(100))
    fireEvent.change(input, { target: { value: "first line\nsecond line" } })
    expect(input).toHaveValue("first line\nsecond line")
    fireEvent.change(input, { target: { value: "" } })
    expect(input).toHaveValue("")
  })
})
