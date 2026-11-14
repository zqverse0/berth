import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"

const bridgeMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/runtime-bridge", () => ({
  runtimeBridgeOperation: bridgeMock,
}))

import { StatusBarResources } from "@/components/layout/status-bar/status-bar-resources"

const GB = 1024 ** 3

function renderResources() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBarResources />
    </NextIntlClientProvider>
  )
}

describe("StatusBarResources", () => {
  it("renders nothing until the first snapshot arrives", async () => {
    bridgeMock.mockResolvedValue({ ok: false, error: { message: "x" } })
    const { container } = renderResources()
    await vi.waitFor(() => expect(bridgeMock).toHaveBeenCalled())
    expect(
      container.querySelector("[data-berth-status-resources-trigger]")
    ).toBeNull()
  })

  it("shows machine CPU / memory and Berth groups in the popover", async () => {
    bridgeMock.mockResolvedValue({
      ok: true,
      result: {
        machine: {
          cpuPercent: 12.4,
          cpuCount: 8,
          memoryUsed: 4 * GB,
          memoryTotal: 16 * GB,
          swapUsed: 0,
          swapTotal: 0,
          disks: [{ mount: "/", used: 50 * GB, total: 100 * GB }],
        },
        berth: [
          {
            kind: "ui",
            cpuPercent: 3,
            memory: GB,
            processes: [
              { pid: 10, name: "berth-gui", cpuPercent: 3, memory: GB },
            ],
          },
          { kind: "agents", cpuPercent: 0, memory: 0, processes: [] },
        ],
      },
    })
    renderResources()
    const trigger = await screen.findByLabelText("Resource usage")
    expect(trigger.textContent).toContain("12%")
    expect(trigger.textContent).toContain("Mem 25%")

    fireEvent.click(trigger)
    expect(await screen.findByText("berth-gui")).toBeTruthy()
    expect(screen.getByText("Interface")).toBeTruthy()
    expect(screen.getByText("50.0 GB / 100.0 GB")).toBeTruthy()
    // 没有交换区就不列
    expect(screen.queryByText("Swap")).toBeNull()
    expect(bridgeMock).toHaveBeenCalledWith({ method: "system.resources" })
  })
})
