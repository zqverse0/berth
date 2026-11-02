import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { RemoteAccessStatus } from "@/lib/types"

const status: RemoteAccessStatus = {
  settings: { addresses: ["100.64.0.8"] },
  defaultPort: 7421,
  hasPassword: true,
  listening: ["100.64.0.8:7421"],
  errors: [],
}

const update = vi.fn(async (settings: RemoteAccessStatus["settings"]) => ({
  ...status,
  settings,
  listening: settings.addresses.map((a) => `${a}:7421`),
}))

vi.mock("@/lib/api", () => ({
  getRemoteAccess: async () => status,
  updateRemoteAccess: (...args: [RemoteAccessStatus["settings"]]) =>
    update(...args),
}))
vi.mock("@/lib/notify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { RemoteAccessSettingsSection } from "./remote-access-settings"

describe("RemoteAccessSettingsSection", () => {
  it("a typed address is saved and listed", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <RemoteAccessSettingsSection />
      </NextIntlClientProvider>
    )
    expect(await screen.findByText("http://100.64.0.8:7421/")).toBeDefined()

    const inputs = screen.getAllByRole("textbox", { name: "Listen addresses" })
    expect(inputs).toHaveLength(2)
    await userEvent.type(inputs[1], "100.0.0.1{Enter}")
    expect(update).toHaveBeenCalledWith(
      { addresses: ["100.64.0.8", "100.0.0.1"] },
      undefined
    )
    expect(await screen.findByText("http://100.0.0.1:7421/")).toBeDefined()
  })
})
