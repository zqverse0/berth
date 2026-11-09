import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { Device, NodeRequest } from "@/lib/devices"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { deviceFolderId } from "@/lib/transport/device"
import { DeviceFeed } from "@/components/conversations/sidebar/device-projects"
import { DevicePage } from "./device-page"

type Call = { method: string; params: Record<string, unknown> }

const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  devices: [] as Device[],
  /** `device.check` 的回复 */
  check: { ok: true, message: null } as { ok: boolean; message: string | null },
  hasBerth: true,
  /** `device.request` 的回复 */
  reply: (() => null) as (request: NodeRequest) => unknown,
  closeFileTab: vi.fn(async () => {}),
}))

vi.mock("@/lib/runtime-bridge", () => ({
  runtimeBridgeOperation: async ({
    method,
    params = {},
  }: {
    method: string
    params?: Record<string, unknown>
  }) => {
    mocks.calls.push({ method, params })
    const result =
      method === "device.list"
        ? mocks.devices
        : method === "device.check"
          ? {
              ...mocks.check,
              node:
                mocks.check.ok && mocks.hasBerth
                  ? { berth: "/b/berth", status: null }
                  : null,
            }
          : method === "device.node"
            ? { status: null, overview: OVERVIEW }
            : method === "device.request"
              ? mocks.reply(params.request as NodeRequest)
              : null
    return { ok: true, result }
  },
}))

// 不真连对方 GUI。
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  connectDevice: () => undefined,
}))
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  subscribe: () => Promise.resolve(() => undefined),
}))
vi.mock("@/lib/updater", () => ({
  getCurrentAppVersion: async () => "0.37.4",
}))
vi.mock("@/lib/terminal/terminal-inventory-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/terminal/terminal-inventory-query")
  >()),
  useTerminalInventorySnapshot: () => [],
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTerminalTab: vi.fn(), switchTab: vi.fn() }),
  useTabStore: (selector: (s: { tabs: unknown[] }) => unknown) =>
    selector({ tabs: [] }),
}))
vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ closeFileTab: mocks.closeFileTab }),
}))
vi.mock("@/components/layout/sidebar/agent-launch", () => ({
  DeviceLaunchPanel: () => null,
}))

const OVERVIEW = {
  host: "macmini",
  os: "macos",
  version: "0.36.0",
  window: "/r.sock",
  projects: [
    {
      id: 4,
      path: "/Users/k/app",
      name: "app",
      parent_id: null,
      alias: null,
      git_branch: "main",
      sort_order: 0,
      pinned_at: null,
    },
  ],
}

function device(node = true): Device {
  return {
    id: 1,
    name: "macmini",
    target: "macmini",
    localDir: "/data/remote/1",
    node: node ? { berth: "/b/berth", status: { state: "online" } } : null,
  }
}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <DevicePage deviceId={1} />
    </NextIntlClientProvider>
  )
}

const fresh = (op: string) =>
  mocks.calls.filter(
    (call) =>
      call.method === "device.request" &&
      (call.params.request as NodeRequest).op === op
  )

const checks = en.DevicePage

describe("DevicePage", () => {
  beforeEach(() => {
    mocks.calls = []
    mocks.devices = [device()]
    mocks.check = { ok: true, message: null }
    mocks.hasBerth = true
    mocks.closeFileTab.mockClear()
  })

  it("shows the checklist; a version mismatch names both versions", async () => {
    renderPage()
    const list = await screen.findByRole("region", { name: checks.checklist })
    await waitFor(() =>
      expect(
        list.querySelector('[data-check="version"]')?.getAttribute("data-state")
      ).toBe("fail")
    )
    expect(
      list.querySelector('[data-check="ssh"]')?.getAttribute("data-state")
    ).toBe("ok")
    expect(within(list).getByText(/0\.37\.4 here, 0\.36\.0 there/)).toBeTruthy()
  })

  it("an unreachable device fails the first check with ssh's own words", async () => {
    mocks.check = {
      ok: false,
      message: "ssh: connect to host macmini: Operation timed out",
    }
    renderPage()
    const list = await screen.findByRole("region", { name: checks.checklist })
    await waitFor(() =>
      expect(within(list).getByText(/Operation timed out/)).toBeTruthy()
    )
    expect(
      list.querySelector('[data-check="berth"]')?.getAttribute("data-state")
    ).toBe("skipped")
  })

  it("adds a project by registering it in the device's Berth, without mounting", async () => {
    mocks.reply = (request) =>
      request.op === "dirs"
        ? {
            result: request.path
              ? { path: request.path, dirs: [] }
              : { path: "/Users/k", dirs: ["code"] },
            body: null,
          }
        : request.op === "project_add"
          ? { result: { id: 5, name: "code" }, body: null }
          : null
    renderPage()
    await userEvent.click(
      await screen.findByRole("button", { name: "Add project on this device" })
    )
    await userEvent.click(await screen.findByRole("button", { name: "code" }))
    await waitFor(() =>
      expect(screen.getByLabelText("Directory on the device")).toHaveValue(
        "/Users/k/code"
      )
    )
    await userEvent.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() => expect(fresh("project_add")).toHaveLength(1))
    expect(fresh("project_add")[0].params.request).toEqual({
      op: "project_add",
      path: "/Users/k/code",
    })
  })

  it("a device without Berth offers only an SSH terminal and reloads once Berth shows up", async () => {
    mocks.devices = [device(false)]
    const reloads: number[] = []
    window.addEventListener("berth:devices-changed", () => reloads.push(1))
    renderPage()

    expect(
      await screen.findByRole("button", {
        name: en.Folder.sidebar.devices.openTerminal,
      })
    ).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: "Add project on this device" })
    ).toBeNull()
    // 检测时探测到了 berth：通知各处重读设备列表
    await waitFor(() => expect(reloads.length).toBeGreaterThan(0))
  })

  it("removes the device only after confirmation and closes its page", async () => {
    renderPage()
    await userEvent.click(
      await screen.findByRole("button", {
        name: en.Folder.sidebar.devices.remove,
      })
    )
    expect(mocks.calls.some((call) => call.method === "device.remove")).toBe(
      false
    )
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: en.Folder.sidebar.devices.remove,
      })
    )
    await waitFor(() =>
      expect(mocks.calls.some((call) => call.method === "device.remove")).toBe(
        true
      )
    )
    expect(mocks.closeFileTab).toHaveBeenCalledWith("device:1")
  })
})

describe("DeviceFeed", () => {
  it("brings an online device's projects into this workspace under their device identity", async () => {
    render(<DeviceFeed deviceId={1} live onUpdate={() => undefined} />)

    // 以本机身份进工作区（负 id、设备路径），但不混进本机项目列表；对方项目由项目列表按工作区显示。
    await waitFor(() =>
      expect(
        useAppWorkspaceStore
          .getState()
          .allFolders.find((folder) => folder.id === deviceFolderId(1, 4))?.path
      ).toBe("berth-device://1/Users/k/app")
    )
    expect(useAppWorkspaceStore.getState().folders).toEqual([])
  })
})
