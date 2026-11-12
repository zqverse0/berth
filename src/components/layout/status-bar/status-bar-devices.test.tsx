import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { Device, DeviceTransfer } from "@/lib/devices"
import { StatusBarDevices } from "./status-bar-devices"

const mocks = vi.hoisted(() => ({
  devices: [] as Device[],
  transfers: [] as DeviceTransfer[],
  openDeviceTab: vi.fn(),
}))

vi.mock("@/components/devices/devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/devices/devices")>()),
  useDevices: () => ({
    devices: mocks.devices,
    statusOf: (device: Device) => ({
      state: device.name === "gpu" ? "online" : "offline",
      message: null,
      keyMissing: false,
    }),
    problems: {},
  }),
}))
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ openDeviceTab: mocks.openDeviceTab }),
}))
vi.mock("@/lib/devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/devices")>()),
  useDeviceTransfers: () => ({
    transfers: mocks.transfers,
    dismiss: () => {},
  }),
}))

const device = (id: number, name: string) =>
  ({ id, name, target: name, localDir: `/d/${id}` }) as Device

function renderSegment() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <StatusBarDevices />
    </NextIntlClientProvider>
  )
}

describe("StatusBarDevices", () => {
  beforeEach(() => {
    mocks.devices = []
    mocks.transfers = []
    mocks.openDeviceTab.mockClear()
  })

  it("renders nothing without devices", () => {
    expect(renderSegment().container.textContent).toBe("")
  })

  it("summarizes online devices and transfers, and opens a device page", async () => {
    const user = userEvent.setup()
    mocks.devices = [device(1, "gpu"), device(2, "mac-mini")]
    mocks.transfers = [
      {
        id: 7,
        deviceId: 1,
        source: "/a/data.tar",
        dest: "/b/data.tar",
        sent: 50,
        total: 200,
        state: "running",
        error: null,
      },
    ]
    renderSegment()
    const trigger = screen.getByRole("button", { name: /Devices 1\/2/ })
    expect(trigger.textContent).toContain("Transfer 25%")

    await user.click(trigger)
    expect(screen.getByText("data.tar")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: en.Folder.sidebar.devices.addTitle })
    ).toBeTruthy()
    const offline = screen.getByRole("button", { name: /mac-mini/ })
    expect(offline.textContent).toContain(en.WorkspaceGroups.offlineReason)

    await user.click(offline)
    expect(mocks.openDeviceTab).toHaveBeenCalledWith({
      deviceId: 2,
      title: "mac-mini",
    })
  })
})
