import { describe, expect, it } from "vitest"
import { deviceChecklist, type NodeOverview } from "./devices"

const overview = (extra: Partial<NodeOverview> = {}): NodeOverview => ({
  host: "gpu",
  os: "linux",
  projects: [],
  version: "0.37.4",
  window: "/run/remote.sock",
  hostable: false,
  ...extra,
})

const states = (items: ReturnType<typeof deviceChecklist>) =>
  items.map((item) => `${item.id}:${item.state}`)

describe("deviceChecklist", () => {
  it("passes every step when the device is reachable and in sync", () => {
    const items = deviceChecklist({
      check: { ok: true, message: null },
      berth: "/usr/bin/berth",
      overview: overview(),
      localVersion: "0.37.4",
      line: { open: true, error: null },
    })
    expect(states(items)).toEqual([
      "ssh:ok",
      "key:ok",
      "berth:ok",
      "version:ok",
      "host:ok",
    ])
    expect(items[2].raw).toBe("/usr/bin/berth")
  })

  it("a timeout fails the first step with ssh's own words and skips the rest", () => {
    const items = deviceChecklist({
      check: {
        ok: false,
        message: "ssh: connect to host gpu: Operation timed out",
      },
      berth: null,
      overview: null,
      localVersion: "0.37.4",
      line: null,
    })
    expect(states(items)).toEqual([
      "ssh:fail",
      "key:skipped",
      "berth:skipped",
      "version:skipped",
      "host:skipped",
    ])
    expect(items[0].raw).toContain("timed out")
  })

  it("a password-only host reaches ssh but fails the key step", () => {
    const items = deviceChecklist({
      check: { ok: false, message: "Permission denied (publickey,password)." },
      berth: null,
      overview: null,
      localVersion: null,
      line: null,
    })
    expect(states(items).slice(0, 3)).toEqual([
      "ssh:ok",
      "key:fail",
      "berth:skipped",
    ])
  })

  it("names both versions when they differ", () => {
    const [, , , version] = deviceChecklist({
      check: { ok: true, message: null },
      berth: "/b",
      overview: overview({ version: "0.36.0" }),
      localVersion: "0.37.4",
      line: { open: true, error: null },
    })
    expect(version).toMatchObject({
      state: "fail",
      reason: {
        key: "versionMismatch",
        values: { local: "0.37.4", remote: "0.36.0" },
      },
    })
  })

  it("explains a missing Berth, an old Berth and a closed GUI", () => {
    const base = {
      check: { ok: true, message: null },
      localVersion: "0.37.4",
      line: { open: false, error: null },
    }
    expect(
      deviceChecklist({ ...base, berth: null, overview: null })[2].reason?.key
    ).toBe("berthMissing")
    expect(
      deviceChecklist({
        ...base,
        berth: "/b",
        overview: overview({ version: undefined, window: undefined }),
      })
        .slice(3)
        .map((item) => item.reason?.key)
    ).toEqual(["versionUnknown", "berthOutdated"])
    expect(
      deviceChecklist({
        ...base,
        berth: "/b",
        overview: overview({ window: null }),
      })[4].reason?.key
    ).toBe("windowUnavailable")
  })

  it("is pending until the first check returns", () => {
    expect(
      deviceChecklist({
        check: null,
        berth: null,
        overview: null,
        localVersion: null,
        line: null,
      }).every((item) => item.state === "pending")
    ).toBe(true)
  })
})
