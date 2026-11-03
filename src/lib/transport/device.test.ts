import { describe, expect, it } from "vitest"
import {
  deviceFolderId,
  devicePath,
  deviceTerminalId,
  parseDeviceFolderId,
  parseDeviceRef,
  routeArgs,
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
