import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { ClassifyPopover } from "./classify-popover"

const classifySession = vi.fn()
vi.mock("@/knowledge/api/knowledge-client", () => ({
  listExperts: () => Promise.resolve([{ value: "dev-expert", label: "Dev" }]),
  classifySession: (...args: unknown[]) => classifySession(...args),
}))

describe("ClassifyPopover", () => {
  it("classifies the session and lists what was written", async () => {
    classifySession.mockResolvedValue({
      expert: "_",
      provider: "TypeSafe Jev",
      rounds: 2,
      classified: 2,
      written: [
        {
          id: "abcd1234",
          at: "2026-10-14T13:26:00+00:00",
          category: "correction",
          name: "纠正",
          text: "Only use bash in this project",
          score: 0.96,
          expert: "_",
          agent: "claude_code",
          sessionId: "s1",
          turn: 0,
          file: ".berth/knowledge/记录/纠正.md",
          undone: false,
        },
      ],
      error: null,
    })
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ClassifyPopover folderId={7} agentType="claude_code" sessionId="s1" />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: /Jev classify/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Classify" }))
    expect(
      await screen.findByText("Only use bash in this project")
    ).toBeTruthy()
    expect(screen.getByText("纠正")).toBeTruthy()
    expect(screen.getByText("记录/纠正.md")).toBeTruthy()
    expect(screen.getByText(/2\/2 answered prompts classified/)).toBeTruthy()
    // 没选专家时不传专家（记在 `_` 名下）。
    expect(classifySession).toHaveBeenCalledWith(7, "claude_code", "s1", null)
  })
})
