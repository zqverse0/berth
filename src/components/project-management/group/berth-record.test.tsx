import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { BerthRecordTurn } from "@/lib/agent/berth-group"
import { BerthSessionView } from "./berth-record"

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => <p>{children}</p>,
}))
const runtimeBridgeOperation = vi.hoisted(() => vi.fn())
vi.mock("@/lib/runtime-bridge", () => ({ runtimeBridgeOperation }))

const turn = (patch: Partial<BerthRecordTurn>): BerthRecordTurn => ({
  ask: 1,
  text: "read launchbar.json",
  at: 1000,
  model: "deepseek-flash",
  usage: null,
  steps: null,
  complete: true,
  items: [{ kind: "text", text: "6 options" }],
  ...patch,
})

function open(turns: BerthRecordTurn[]) {
  runtimeBridgeOperation.mockImplementation(({ params }) =>
    Promise.resolve({
      ok: true,
      result: { session: params.session, turns },
    })
  )
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <BerthSessionView
        tab={{
          id: "berth-session:7:20261030-090000",
          kind: "berth-session",
          folderId: 7,
          session: "20261030-090000",
          title: "Berth",
          description: "20261030-090000",
          path: null,
          readonly: true,
          loading: false,
          saveState: "idle",
          saveError: null,
        }}
      />
    </NextIntlClientProvider>
  )
}

describe("BerthSessionView", () => {
  it("shows each tool call with its full output, folded until opened", async () => {
    open([
      turn({
        usage: {
          calls: 3,
          input: 12300,
          output: 800,
          cached: 9800,
          context: 5100,
        },
        items: [
          { kind: "text", text: "Let me read it." },
          {
            kind: "tool",
            id: "c1",
            name: "read",
            args: { path: "launchbar.json" },
            output: '     1\t{\n     2\t  "version": 1',
            failed: false,
          },
          {
            kind: "tool",
            id: "c2",
            name: "edit",
            args: { path: "a.json" },
            output: "Error: old_text not found",
            failed: true,
          },
          { kind: "text", text: "6 options" },
        ],
      }),
    ])
    expect(runtimeBridgeOperation).toHaveBeenCalledWith({
      method: "group.berthRecord",
      folderId: 7,
      params: { session: "20261030-090000" },
    })
    expect(await screen.findByText("Let me read it.")).toBeInTheDocument()
    expect(screen.getByText("→ read launchbar.json")).toBeInTheDocument()
    expect(screen.getByText("✗ edit a.json")).toHaveClass("text-destructive")
    const read = document.querySelector<HTMLDetailsElement>(
      "[data-record-tool='read']"
    )!
    expect(read.open).toBe(false)
    fireEvent.click(screen.getByText("→ read launchbar.json"))
    expect(read).toHaveTextContent('"version": 1')
    expect(document.querySelector("[data-record-usage]")).toHaveTextContent(
      "3 calls · input 12.3K · output 800 · cached 9.8K · context 5.1K"
    )
  })

  it("shows the step log for a turn that was stopped or failed", async () => {
    open([
      turn({
        complete: false,
        steps: [{ text: "→ bash berth tools list" }],
        items: [{ kind: "text", text: "（已停止）" }],
      }),
    ])
    expect(await screen.findByText("（已停止）")).toBeInTheDocument()
    expect(screen.getByText("→ bash berth tools list")).toBeInTheDocument()
    expect(
      screen.getByText(/This turn was stopped or failed/)
    ).toBeInTheDocument()
  })
})
