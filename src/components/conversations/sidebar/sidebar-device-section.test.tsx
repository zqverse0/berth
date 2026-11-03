import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { Device, NodeChannelStatus, NodeRequest } from "@/lib/devices"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { deviceFolderId } from "@/lib/transport/device"
import { SidebarDeviceSection } from "./sidebar-device-section"

type Call = { method: string; params: Record<string, unknown> }

const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  /** `device.check` 是否探测到对方的 berth。 */
  hasBerth: true,
  /** `device.request` 的回复：按 `cached` 与请求决定。 */
  reply: (() => null) as (request: NodeRequest, cached: boolean) => unknown,
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
      method === "device.check"
        ? {
            ok: true,
            message: null,
            node: mocks.hasBerth ? { berth: "/b/berth", status: null } : null,
          }
        : method === "device.node"
          ? { status: null, overview: OVERVIEW }
          : method === "device.request"
            ? mocks.reply(params.request as NodeRequest, params.cached === true)
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

const OVERVIEW = {
  host: "macmini",
  os: "macos",
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

function device(status: NodeChannelStatus): Device {
  return {
    id: 1,
    name: "macmini",
    target: "macmini",
    localDir: "/data/remote/1",
    node: { berth: "/b/berth", status },
  }
}

function renderSection(target: Device, onChanged = () => undefined) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SidebarDeviceSection
        devices={[target]}
        onChanged={onChanged}
        terminals={new Map()}
        collapsed={{}}
        onToggle={() => undefined}
        addOpen={false}
        onAddOpenChange={() => undefined}
      />
    </NextIntlClientProvider>
  )
}

const fresh = (op: string) =>
  mocks.calls.filter(
    (call) =>
      call.method === "device.request" &&
      call.params.cached !== true &&
      (call.params.request as NodeRequest).op === op
  )

describe("SidebarDeviceSection — node devices", () => {
  beforeEach(() => {
    mocks.calls = []
    mocks.hasBerth = true
  })

  it("lists the device's open projects; clicking one makes it the active project here", async () => {
    renderSection(device({ state: "online" }))
    await userEvent.click(await screen.findByRole("button", { name: "app" }))

    await waitFor(() =>
      expect(useAppWorkspaceStore.getState().activeFolderId).toBe(
        deviceFolderId(1, 4)
      )
    )
    // 以本机身份进工作区，但不混进本机项目列表。
    expect(
      useAppWorkspaceStore
        .getState()
        .allFolders.find((folder) => folder.id === deviceFolderId(1, 4))?.path
    ).toBe("berth-device://1/Users/k/app")
    expect(useAppWorkspaceStore.getState().folders).toEqual([])
  })

  it("greys the cached projects out while offline and does not open them", async () => {
    const { container } = renderSection(
      device({ state: "failed", error: "ssh: no route" })
    )
    expect(await screen.findByRole("button", { name: "app" })).toBeDisabled()
    expect(
      container.querySelector(
        `[title="${en.Folder.sidebar.devices.remote.offline}"]`
      )
    ).toHaveClass("opacity-60")
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
    renderSection(device({ state: "online" }))
    await userEvent.click(
      screen.getAllByRole("button", { name: "Add project on this device" })[0]
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
    expect(
      mocks.calls.some((call) => call.method === "device.addProject")
    ).toBe(false)
  })

  it("a device without Berth only offers an SSH terminal, and reloads once Berth shows up", async () => {
    const plain = { ...device({ state: "online" }), node: null }
    const onChanged = vi.fn()
    renderSection(plain, onChanged)

    expect(
      screen.getByText(en.Folder.sidebar.devices.berthMissing)
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Add project on this device" })
    ).toBeNull()
    expect(
      screen.getAllByRole("button", {
        name: en.Folder.sidebar.devices.openTerminal,
      })
    ).not.toHaveLength(0)
    // 检测时探测到了 berth：重读设备列表，设备变成节点设备。
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })
})
