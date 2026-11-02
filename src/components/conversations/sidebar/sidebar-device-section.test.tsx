import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { Device, NodeChannelStatus, NodeRequest } from "@/lib/devices"
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

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  subscribe: () => Promise.resolve(() => undefined),
}))

const OVERVIEW = {
  host: "macmini",
  os: "macos",
  projects: [{ id: 4, path: "/Users/k/app", name: "app", is_open: true }],
}

function projectOverview(entries: { name: string; dir: boolean }[]) {
  return {
    result: {
      project: OVERVIEW.projects[0],
      root: {
        version: "r1",
        unchanged: false,
        entries: entries.map((entry) => ({ ...entry, size: 0 })),
      },
      sessions: {
        sessions: [
          {
            session_id: "s1",
            agent: "claude",
            title: "Fix login",
            updated_at: 1,
          },
        ],
      },
      tasks: { tasks: [] },
      notes: { notes: [] },
    },
    body: null,
  }
}

const README = {
  result: { size: 5, version: "v1", binary: false },
  body: btoa("hello"),
}

function device(data: NodeChannelStatus): Device {
  return {
    id: 1,
    name: "macmini",
    target: "macmini",
    localDir: "/data/remote/1",
    node: { berth: "/b/berth", status: { data, terminal: data } },
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

  it("lists the device's projects and opens one with a single request, cache first", async () => {
    mocks.reply = (request, cached) =>
      request.op === "project"
        ? cached
          ? projectOverview([{ name: "README.md", dir: false }])
          : projectOverview([
              { name: "src", dir: true },
              { name: "README.md", dir: false },
            ])
        : null
    renderSection(device({ state: "online" }))
    await userEvent.click(await screen.findByRole("button", { name: "app" }))

    expect(await screen.findByText("README.md")).toBeInTheDocument()
    expect(await screen.findByText("src")).toBeInTheDocument()
    expect(fresh("project")).toHaveLength(1)

    await userEvent.click(screen.getByRole("button", { name: "Sessions" }))
    expect(screen.getByText("Fix login")).toBeInTheDocument()
  })

  it("shows the cache greyed out while offline and never asks the device", async () => {
    mocks.reply = (request, cached) =>
      !cached
        ? { error: { kind: "timeout", message: "timed out" } }
        : request.op === "project"
          ? projectOverview([{ name: "README.md", dir: false }])
          : request.op === "read"
            ? README
            : null
    const { container } = renderSection(
      device({ state: "failed", error: "ssh: no route" })
    )
    await userEvent.click(await screen.findByRole("button", { name: "app" }))
    await userEvent.click(await screen.findByText("README.md"))

    const dialog = await screen.findByRole("dialog")
    const editor = within(dialog).getByRole("textbox")
    await waitFor(() => expect(editor).toHaveValue("hello"))
    expect(editor).toHaveAttribute("readonly")
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled()
    expect(
      container.querySelector(
        `[title="${en.Folder.sidebar.devices.remote.offline}"]`
      )
    ).toHaveClass("opacity-60")
    expect(
      mocks.calls
        .filter((call) => call.method === "device.request")
        .every((call) => call.params.cached === true)
    ).toBe(true)
  })

  it("saves with the version it read and reports a conflict without overwriting", async () => {
    mocks.reply = (request, cached) =>
      cached
        ? null
        : request.op === "project"
          ? projectOverview([{ name: "README.md", dir: false }])
          : request.op === "read"
            ? README
            : request.op === "write"
              ? { error: { kind: "conflict", message: "changed on disk" } }
              : null
    renderSection(device({ state: "online" }))
    await userEvent.click(await screen.findByRole("button", { name: "app" }))
    await userEvent.click(await screen.findByText("README.md"))

    const dialog = await screen.findByRole("dialog")
    const editor = within(dialog).getByRole("textbox")
    await waitFor(() => expect(editor).not.toHaveAttribute("readonly"))
    await userEvent.type(editor, "!")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      en.Folder.sidebar.devices.remote.conflict
    )
    const [write] = fresh("write")
    expect(write.params.request).toEqual({
      op: "write",
      path: "/Users/k/app/README.md",
      version: "v1",
    })
    expect(atob(write.params.body as string)).toBe("hello!")
    expect(editor).toHaveValue("hello!")
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
