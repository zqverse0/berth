import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"

const getBerthStatus = vi.fn()
const listBerthTasks = vi.fn()
const enableBerth = vi.fn()

vi.mock("@/lib/agent/berth-project", () => ({
  getBerthStatus: (...args: unknown[]) => getBerthStatus(...args),
  enableBerth: (...args: unknown[]) => enableBerth(...args),
}))
vi.mock("@/lib/agent/berth-tasks", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listBerthTasks: (...args: unknown[]) => listBerthTasks(...args),
}))

import { BerthTasksConsole } from "./berth-tasks-console"

function readyPayload() {
  getBerthStatus.mockResolvedValue({
    ok: true,
    result: { enabled: true },
    meta: null,
  })
  listBerthTasks.mockResolvedValue({
    ok: true,
    result: { tasks: [], diagnostics: [], truncated: false },
    meta: null,
  })
}

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
    readyPayload()
  })

  it("offers Enable Berth for a project without .berth and reloads after enabling", async () => {
    getBerthStatus.mockResolvedValueOnce({
      ok: true,
      result: { enabled: false },
      meta: null,
    })
    enableBerth.mockResolvedValue({
      ok: true,
      result: { root: "/repo/.berth", created: ["README.md"] },
      meta: null,
    })
    renderConsole()
    const enable = await screen.findByRole("button", { name: "Enable Berth" })
    // 未启用时只有启用入口，不渲染任务面板（否则群组列表会报「未启用」）。
    expect(screen.queryByText("Loading…")).toBeNull()
    fireEvent.click(enable)
    await waitFor(() => expect(enableBerth).toHaveBeenCalledWith(7))
    await waitFor(() => expect(listBerthTasks).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: "Enable Berth" })).toBeNull()
  })
})
