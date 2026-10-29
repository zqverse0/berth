import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { JevEntry } from "@/knowledge/api/knowledge-client"
import { JevEntries } from "./jev-entries"

const entry: JevEntry = {
  id: "abcd1234",
  at: "2026-10-14T13:26:00+00:00",
  category: "correction",
  name: "纠正",
  score: 0.96,
  text: "Only use bash in this project",
  expert: "dev-expert",
  agent: "claude",
  sessionId: "s1",
  turn: 2,
  file: ".berth/knowledge/记录/纠正.md",
  undone: false,
}
const categories = [
  { id: "correction", name: "纠正" },
  { id: "decision", name: "决定" },
]

describe("JevEntries", () => {
  it("opens the file, undoes and moves an entry", () => {
    const onOpen = vi.fn()
    const onUndo = vi.fn()
    const onMove = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <JevEntries
          entries={[entry, { ...entry, id: "old", undone: true }]}
          categories={categories}
          onOpen={onOpen}
          onUndo={onUndo}
          onMove={onMove}
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByText("记录/纠正.md"))
    expect(onOpen).toHaveBeenCalledWith(entry)
    // 已撤销的那条没有操作。
    expect(
      screen.getAllByRole("button", { name: "Undo (remove from the file)" })
    ).toHaveLength(1)
    expect(screen.getByText("Undone")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Undo (remove from the file)" })
    )
    expect(onUndo).toHaveBeenCalledWith(entry)
    fireEvent.change(
      screen.getByRole("combobox", { name: "Change category" }),
      {
        target: { value: "decision" },
      }
    )
    expect(onMove).toHaveBeenCalledWith(entry, "decision")
  })
})
