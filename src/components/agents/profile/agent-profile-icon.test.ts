import { beforeEach, describe, expect, it, vi } from "vitest"

const { launchbar } = vi.hoisted(() => ({ launchbar: vi.fn() }))
vi.mock("@/lib/transport/launchbar", () => ({ launchbar }))

import { clearAgentIconCache, fetchAgentIcon } from "./agent-profile-icon"

describe("fetchAgentIcon", () => {
  beforeEach(() => {
    clearAgentIconCache()
    launchbar.mockReset()
  })

  it("shares one IPC call across concurrent requests for the same agent", async () => {
    launchbar.mockResolvedValue({ type: "icon", dataUrl: "data:x" })
    const results = await Promise.all([
      fetchAgentIcon("pi"),
      fetchAgentIcon("pi"),
      fetchAgentIcon("pi"),
    ])
    expect(results).toEqual(["data:x", "data:x", "data:x"])
    expect(launchbar).toHaveBeenCalledTimes(1)
    await fetchAgentIcon("pi")
    expect(launchbar).toHaveBeenCalledTimes(1)
  })

  it("does not cache failures", async () => {
    launchbar.mockRejectedValueOnce(new Error("boom"))
    expect(await fetchAgentIcon("pi")).toBeNull()
    launchbar.mockResolvedValueOnce({ type: "icon", dataUrl: "data:y" })
    expect(await fetchAgentIcon("pi")).toBe("data:y")
    expect(launchbar).toHaveBeenCalledTimes(2)
  })
})
