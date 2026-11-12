import { describe, expect, it, vi } from "vitest"
import {
  deviceFolderId,
  deviceSession,
  devicePath,
  deviceTerminalId,
  parseDeviceFolderId,
  parseDeviceRef,
  routeArgs,
  subscribeDevices,
} from "./device"

describe("device routing", () => {
  it("local calls stay local", () => {
    expect(routeArgs({ rootPath: "/home/a", folderId: 3 })).toBeNull()
    expect(routeArgs(undefined)).toBeNull()
  })

  it("calls on a device project go to that device with its own values", () => {
    expect(
      routeArgs({
        rootPath: devicePath(4, "/srv/app"),
        path: "src/main.ts",
        folderId: deviceFolderId(4, 12),
      })
    ).toEqual({
      deviceId: 4,
      args: { rootPath: "/srv/app", path: "src/main.ts", folderId: 12 },
    })
  })

  it("ids round-trip and never collide with local ids", () => {
    expect(parseDeviceFolderId(deviceFolderId(7, 999))).toEqual({
      deviceId: 7,
      folderId: 999,
    })
    expect(parseDeviceFolderId(5)).toBeNull()
  })

  it("rejects a call spanning two devices", () => {
    expect(() =>
      routeArgs({ a: devicePath(1, "/x"), b: devicePath(2, "/y") })
    ).toThrow()
  })

  it("terminal ids route to their device and come back as the raw id", () => {
    const channel = new (class Channel {
      id = 9
      toJSON() {
        return "__CHANNEL__:9"
      }
    })()
    const routed = routeArgs({
      terminalId: deviceTerminalId(4, "abc.1"),
      clientId: "c",
      onOutput: channel,
    })
    expect(routed?.deviceId).toBe(4)
    expect(routed?.args.terminalId).toBe("abc.1")
    // 类实例（Tauri Channel）原样保留，不被深拷贝成普通对象。
    expect(routed?.args.onOutput).toBe(channel)
    expect(parseDeviceRef(devicePath(4, "/srv/a"))).toEqual({
      deviceId: 4,
      value: "/srv/a",
    })
  })
})

const sessions = vi.hoisted(
  () => [] as { onEvent: (name: string, payload: unknown) => void }[]
)
vi.mock("./remote-line", () => ({
  createRemoteSession: (options: {
    onEvent: (name: string, payload: unknown) => void
  }) => {
    sessions.push(options)
    return { open: true, setEvents: () => {}, call: async () => null }
  },
}))

describe("device broadcasts", () => {
  it("unscoped wake-ups arrive without a path; scoped ones need one", () => {
    deviceSession(7, async () => 1)
    const wake = vi.fn()
    const scoped = vi.fn()
    const offWake = subscribeDevices("agent://changed", wake, false)
    const offScoped = subscribeDevices("agent://changed", scoped)
    sessions.at(-1)!.onEvent("agent://changed", null)
    expect(wake).toHaveBeenCalledTimes(1)
    expect(scoped).not.toHaveBeenCalled()
    offWake()
    offScoped()
    sessions.at(-1)!.onEvent("agent://changed", null)
    expect(wake).toHaveBeenCalledTimes(1)
  })
})
