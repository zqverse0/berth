import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { LazyPage } from "./lazy-page"

const intl = {
  locale: "en",
  messages: enMessages,
} as const

function Page() {
  return <p>loaded</p>
}

function renderLazy(load: () => Promise<{ default: React.ComponentType }>) {
  return render(
    <NextIntlClientProvider {...intl}>
      <LazyPage load={load}>{(P) => <P />}</LazyPage>
    </NextIntlClientProvider>
  )
}

describe("LazyPage", () => {
  it("renders the page after the import resolves", async () => {
    const load = vi.fn(async () => ({ default: Page }))
    renderLazy(load)
    expect(await screen.findByText("loaded")).toBeInTheDocument()
  })

  it("retries the import after a failure", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("chunk load error"))
      .mockResolvedValueOnce({ default: Page })
    renderLazy(load)
    expect(
      await screen.findByText("This page failed to load.")
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Retry" }))

    expect(await screen.findByText("loaded")).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("does not resolve after unmount", async () => {
    let resolve: (m: { default: React.ComponentType }) => void = () => {}
    const load = vi.fn(
      () => new Promise<{ default: React.ComponentType }>((r) => (resolve = r))
    )
    const { unmount } = renderLazy(load)
    unmount()
    await act(async () => {
      resolve({ default: Page })
    })
    expect(load).toHaveBeenCalledTimes(1)
  })
})
