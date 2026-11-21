import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import zh from "@/i18n/messages/zh-CN.json"
import { saveAutomation } from "@/lib/automations"
import { MemberRoutineDialog } from "./member-routine"

vi.mock("@/lib/automations", () => ({
  listAutomations: async () => [
    { id: 1, task: "10-21-papers", cron: "0 8 * * *", prompt: "x" },
    {
      id: 2,
      member: "codex",
      enabled: true,
      cron: "30 9 * * 1-5",
      timezone: "Asia/Shanghai",
      prompt: "汇报进度",
      nextRunAt: null,
      missedRunGraceMinutes: 60,
      failures: 2,
    },
  ],
  listAutomationRuns: async () => [
    {
      id: 7,
      status: "succeeded",
      stopReason: "answered",
      trigger: "schedule",
      error: null,
      createdAt: "2026-11-21T01:30:00Z",
    },
    {
      id: 8,
      status: "failed",
      stopReason: "execution_failed",
      trigger: "retry",
      error: "这一轮没有回答",
      createdAt: "2026-11-21T01:31:00Z",
    },
  ],
  subscribeAutomationChanges: async () => () => {},
  deleteAutomation: vi.fn(),
  saveAutomation: vi.fn(async () => ({})),
  runAutomation: vi.fn(),
}))

describe("member routine", () => {
  it("edits this member's routine and saves it as a group message", async () => {
    render(
      <NextIntlClientProvider locale="zh-CN" messages={zh}>
        <MemberRoutineDialog
          folderId={3}
          member="codex"
          label="Codex"
          onClose={() => {}}
        />
      </NextIntlClientProvider>
    )
    const text = await screen.findByDisplayValue("汇报进度")
    expect(screen.getByDisplayValue("09:30")).toBeTruthy()
    expect(screen.getByText(/连续失败 2 次/)).toBeTruthy()
    expect(screen.getByText(/已回答/)).toBeTruthy()
    expect(screen.getByText(/这一轮没有回答/)).toBeTruthy()
    fireEvent.change(text, { target: { value: "汇报今天的进度" } })
    fireEvent.click(document.querySelector("[data-routine-save]")!)
    await waitFor(() =>
      expect(saveAutomation).toHaveBeenCalledWith(
        2,
        expect.objectContaining({
          member: "codex",
          agentId: "",
          task: null,
          cron: "30 9 * * 1-5",
          prompt: "汇报今天的进度",
          folderId: 3,
        })
      )
    )
  })
})
