import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

let snapshot: unknown = { seq: 1, status: "idle" }
const call = vi.fn(async (endpoint: string) => {
  if (endpoint === "app_update_state") return snapshot
  throw new Error(`unexpected endpoint: ${endpoint}`)
})
const subscribe = vi.fn(async () => () => {})

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call, subscribe }),
  isDesktop: () => true,
}))

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.16.0" }))
vi.mock("@/lib/updater", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/updater")>()),
  checkAppUpdate: async () => ({ currentVersion: "0.16.0", update: null }),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    getSystemProxySettings: vi.fn(),
    updateSystemProxySettings: vi.fn(),
  }
})

vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}))

vi.mock("@/lib/platform", () => ({ openUrl: vi.fn(), isDesktop: () => true }))

// 嵌入的子区块各自有测试，这里只验证本页的更新与代理区块。
// 这里测整页内容：分节过滤（侧栏选中哪节显示哪节）不在本测试范围。
vi.mock("@/components/settings/settings-nav", () => ({
  useGeneralSectionShown: () => () => true,
}))
vi.mock("./backup-settings", () => ({ BackupSettings: () => null }))
vi.mock("./logs-settings", () => ({ LogsSettings: () => null }))
vi.mock("./system-runtime-settings", () => ({
  SystemRuntimeSettings: () => null,
}))
vi.mock("./translate-settings", () => ({ TranslateSettings: () => null }))

import { AdvancedSettings } from "./advanced-settings"
import { UpdateProvider } from "@/components/providers/update-provider"
import enMessages from "@/i18n/messages/en.json"
import { getSystemProxySettings } from "@/lib/api"

const mockGetProxy = vi.mocked(getSystemProxySettings)

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <UpdateProvider>
        <AdvancedSettings />
      </UpdateProvider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  call.mockClear()
  snapshot = { seq: 1, status: "idle" }
  mockGetProxy.mockReset()
  mockGetProxy.mockResolvedValue({
    enabled: true,
    proxy_url: "http://127.0.0.1:7890",
  })
})

describe("AdvancedSettings", () => {
  it("loads proxy settings and the running version", async () => {
    renderPage()

    expect(
      await screen.findByDisplayValue("http://127.0.0.1:7890")
    ).toBeTruthy()
    expect(screen.getByText(/v0\.16\.0/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /roll back/i })).toBeNull()
  })

  it("offers restart once an update is staged", async () => {
    snapshot = { seq: 2, status: "ready_to_restart", version: "0.17.0" }
    renderPage()

    expect(
      await screen.findByRole("button", {
        name: enMessages.SystemSettings.restartToUpdate,
      })
    ).toBeTruthy()
  })
})
