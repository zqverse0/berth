import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import zh from "@/i18n/messages/zh-CN.json"
import { cronOf, parseCron, TaskSchedule } from "./task-schedule"

vi.mock("@/hooks/use-agent-profiles", () => ({
  useAgentProfiles: () => ({ agents: [{ id: "claude", name: "Claude" }] }),
}))
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ openFilePreview: vi.fn() }),
}))
vi.mock("@/stores/tab-store", () => ({
  useTabActions: () => ({ openTerminalTab: vi.fn() }),
}))
vi.mock("@/lib/api", () => ({ getTerminalSession: vi.fn() }))
vi.mock("@/lib/terminal/create-and-open-primary-terminal", () => ({
  tabFromDescriptor: vi.fn(),
}))
vi.mock("@/lib/automations", () => ({
  listAutomations: async () => [
    { id: 1, task: "other", cron: "0 9 * * *", agentId: "claude" },
    {
      id: 2,
      task: "10-21-papers",
      enabled: true,
      cron: "0 8 * * *",
      agentId: "claude",
      nextRunAt: null,
    },
  ],
  listAutomationRuns: async () =>
    [
      {
        status: "succeeded",
        stopReason: "result_submitted",
        resultPath: "/r.md",
      },
      { status: "failed", stopReason: "needs_attention" },
      { status: "failed", stopReason: "timeout" },
      { status: "running" },
    ].map((run, id) => ({
      id,
      ...run,
      terminalId: null,
      error: null,
      createdAt: "2026-10-21T00:00:00Z",
    })),
  subscribeAutomationChanges: async () => () => {},
  deleteAutomation: vi.fn(),
  saveAutomation: vi.fn(),
  runAutomation: vi.fn(),
  checkAutomationRun: vi.fn(),
}))

describe("task schedule", () => {
  it("maps time presets to cron and back", () => {
    expect(cronOf("daily", "08:05", "")).toBe("5 8 * * *")
    expect(cronOf("weekdays", "05:00", "")).toBe("0 5 * * 1-5")
    expect(cronOf("custom", "", " 0 */2 * * * ")).toBe("0 */2 * * *")
    expect(parseCron("5 8 * * *")).toEqual({
      frequency: "daily",
      time: "08:05",
    })
    expect(parseCron("0 5 * * 1-5")).toEqual({
      frequency: "weekdays",
      time: "05:00",
    })
    expect(parseCron("0 */2 * * *").frequency).toBe("custom")
  })

  it.each([
    ["en", en],
    ["zh-CN", zh],
  ] as const)(
    "shows this task's runs with their outcome in %s",
    async (locale, messages) => {
      render(
        <NextIntlClientProvider locale={locale} messages={messages}>
          <TaskSchedule folderId={1} task="10-21-papers" />
        </NextIntlClientProvider>
      )
      const status = messages.BerthTasks.automations.runStatus
      for (const label of [
        status.submitted,
        status.attention,
        status.timeout,
        status.running,
      ]) {
        expect(await screen.findByText(new RegExp(label))).toBeTruthy()
      }
      expect(screen.getByText(/0 8 \* \* \*/)).toBeTruthy()
    }
  )
})
