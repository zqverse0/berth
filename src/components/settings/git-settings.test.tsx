import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import en from "@/i18n/messages/en.json"
import { GitAccountsSettings } from "./git-settings"

const api = vi.hoisted(() => ({
  getGitHubAccounts: vi.fn(),
  updateGitHubAccounts: vi.fn(),
  deleteAccountToken: vi.fn(),
}))

vi.mock("@/lib/api", () => api)
vi.mock("@/lib/notify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const account = {
  id: "a1",
  server_url: "https://github.com",
  username: "octo",
  scopes: [],
  avatar_url: null,
  is_default: true,
  created_at: "2026-10-03T00:00:00Z",
}

function renderAccounts() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <GitAccountsSettings />
    </NextIntlClientProvider>
  )
}

describe("GitAccountsSettings", () => {
  beforeEach(() => {
    api.getGitHubAccounts.mockResolvedValue({ accounts: [account] })
    api.updateGitHubAccounts.mockImplementation((settings) =>
      Promise.resolve(settings)
    )
    api.deleteAccountToken.mockResolvedValue(undefined)
  })

  it("opens the add form in the page, not in a dialog", async () => {
    const user = userEvent.setup()
    renderAccounts()
    const [addGitHub] = await screen.findAllByRole("button", {
      name: en.VersionControlSettings.addAccount,
    })
    await user.click(addGitHub)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(
      screen.getByPlaceholderText(en.VersionControlSettings.tokenPlaceholder)
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole("button", {
        name: en.VersionControlSettings.removeCancel,
      })
    )
    expect(
      screen.queryByPlaceholderText(en.VersionControlSettings.tokenPlaceholder)
    ).toBeNull()
  })

  it("confirms removal inline in the account row", async () => {
    const user = userEvent.setup()
    renderAccounts()
    await user.click(
      await screen.findByRole("button", {
        name: en.VersionControlSettings.removeConfirmTitle,
      })
    )
    expect(screen.queryByRole("alertdialog")).toBeNull()
    await user.click(
      screen.getByRole("button", {
        name: en.VersionControlSettings.removeConfirm,
      })
    )
    expect(api.deleteAccountToken).toHaveBeenCalledWith("a1")
    expect(api.updateGitHubAccounts).toHaveBeenCalledWith({ accounts: [] })
  })
})
