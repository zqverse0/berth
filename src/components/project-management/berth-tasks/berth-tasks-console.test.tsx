import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"

const listBerthTasks = vi.fn()

vi.mock("@/lib/agent/berth-tasks", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listBerthTasks: (...args: unknown[]) => listBerthTasks(...args),
}))

import { BerthTasksConsole } from "./berth-tasks-console"

function renderConsole() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <BerthTasksConsole folderId={7} />
    </NextIntlClientProvider>
  )
}

describe("BerthTasksConsole", () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  beforeEach(() => {
    listBerthTasks.mockResolvedValue({
      ok: true,
      result: { tasks: [], diagnostics: [], truncated: false },
      meta: null,
    })
  })

  it("loads tasks directly for the space without an enable step", async () => {
    renderConsole()
    await waitFor(() => expect(listBerthTasks).toHaveBeenCalledWith(7))
    expect(screen.queryByText("Tasks unavailable")).toBeNull()
  })

  it("shows an error box when listing tasks fails", async () => {
    listBerthTasks.mockResolvedValueOnce({
      ok: false,
      error: { kind: "project", message: "not in space", method: "task.list" },
    })
    renderConsole()
    expect(await screen.findByText("not in space")).toBeInTheDocument()
  })
})
