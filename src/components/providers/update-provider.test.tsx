import { render, screen, act, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppUpdateState } from "@/lib/updater"

// The provider's snapshot/subscribe helpers go through getTransport(), so
// mocking the transport drives the whole provider without stubbing updater.ts.
let snapshot: AppUpdateState = { seq: 0, status: "idle" }
// Per-call overrides for the app_update_state fetch. Falls back to `snapshot`
// when empty.
let liveHandler: ((s: AppUpdateState) => void) | null = null

const call = vi.fn(async (endpoint: string) => {
  if (endpoint === "app_update_state") {
    return snapshot
  }
  throw new Error(`unexpected endpoint: ${endpoint}`)
})
const subscribe = vi.fn(
  async (_event: string, handler: (s: AppUpdateState) => void) => {
    liveHandler = handler
    return () => {}
  }
)
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call, subscribe }),
  isDesktop: () => false,
}))

vi.mock("@/lib/notify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { UpdateProvider, useAppUpdate } from "./update-provider"
import enMessages from "@/i18n/messages/en.json"

function Probe() {
  const u = useAppUpdate()
  return (
    <div data-testid="status">
      {u?.state.status} #{u?.state.seq}
    </div>
  )
}

const makeTree = () => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    <UpdateProvider>
      <Probe />
    </UpdateProvider>
  </NextIntlClientProvider>
)

const text = () => screen.getByTestId("status").textContent

beforeEach(() => {
  call.mockClear()
  subscribe.mockClear()
  liveHandler = null
  snapshot = { seq: 0, status: "idle" }
})

describe("UpdateProvider", () => {
  it("seeds current state from the snapshot on mount", async () => {
    snapshot = { seq: 50, status: "downloading", downloaded: 10, total: 100 }
    render(makeTree())
    await waitFor(() => expect(text()).toBe("downloading #50"))
  })

  it("ignores a malformed payload without poisoning the guard", async () => {
    snapshot = { seq: 50, status: "downloading", downloaded: 10, total: 100 }
    render(makeTree())
    await waitFor(() => expect(text()).toBe("downloading #50"))

    // A malformed legacy payload (no seq/status) must be ignored.
    await act(async () => {
      liveHandler?.({
        version: "9.9.9",
        needRestart: true,
      } as unknown as AppUpdateState)
      await Promise.resolve()
    })
    expect(text()).toBe("downloading #50")

    // A subsequent valid event still applies — the guard wasn't poisoned by an
    // undefined seq.
    await act(async () => {
      liveHandler?.({ seq: 51, status: "installing" })
      await Promise.resolve()
    })
    await waitFor(() => expect(text()).toBe("installing #51"))
  })
})
