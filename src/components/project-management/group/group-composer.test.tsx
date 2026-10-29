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
  bodies: [],
  body: null,
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
  it("keeps sending to A when A goes offline, never redirecting to B, and offers to launch it", async () => {
    const onSend = vi.fn().mockResolvedValue([])
    const onLaunch = vi.fn()
    const view = render(composer({ onSend, onLaunch }))
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "for A only" } })
    const offline = [{ ...rows[0], status: "left" as const }, rows[1]]
    view.rerender(composer({ onSend, onLaunch, rows: offline }))
    fireEvent.click(screen.getByRole("button", { name: "Send to a" }))
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(["a"], "for A only", undefined)
    )
    expect(await screen.findByRole("status")).toHaveTextContent("a is offline")
    fireEvent.click(screen.getByRole("button", { name: "Launch a" }))
    expect(onLaunch).toHaveBeenCalledWith(offline[0])
  })

  it("treats @ in the text as plain text, never as a recipient", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Send to a" }))
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(["a"], "@b this answers A", 8)
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

  it("blocks an offline member from an old ledger (named by terminal number)", () => {
    const onSend = vi.fn()
    const legacy = {
      ...rows[1],
      member: { ...rows[1].member, name: "3" },
      status: "offline" as const,
    }
    render(composer({ onSend, targets: ["3"], rows: [rows[0], legacy] }))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "private instruction" },
    })
    expect(screen.getByRole("button", { name: "Send to 3" })).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unavailable recipients: 3"
    )
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()
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
