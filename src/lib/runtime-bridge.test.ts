import { beforeEach, describe, expect, it, vi } from "vitest"

const call = vi.fn()

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call }),
}))

import { getBerthStatus } from "@/lib/agent/berth-project"
import { listBerthTasks } from "@/lib/agent/berth-tasks"
import { runtimeBridgeOperation } from "./runtime-bridge"

describe("runtime bridge", () => {
  beforeEach(() => {
    call.mockReset()
  })

  it("returns a failed response instead of rejecting when the command fails", async () => {
    call.mockRejectedValue({
      code: "database_error",
      message: "Database operation failed",
      detail: "migration error: Folder 77 not found",
    })

    await expect(
      runtimeBridgeOperation({ method: "berth.status", folderId: 77 })
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "database_error",
        message: "migration error: Folder 77 not found",
        method: "berth.status",
      },
    })
  })

  it("wraps the operation payload under the Tauri command argument name", async () => {
    call.mockResolvedValue({ ok: true, result: {}, meta: {} })

    await runtimeBridgeOperation({
      method: "knowledge.snapshot",
      params: { includeTasks: true },
      folderId: 3,
      timeoutMs: 30_000,
    })

    expect(call).toHaveBeenCalledWith("runtime_bridge_operation", {
      args: {
        method: "knowledge.snapshot",
        params: { includeTasks: true },
        folderId: 3,
        timeoutMs: 30_000,
      },
    })
  })

  it("routes Berth status and task list through folderId", async () => {
    call.mockResolvedValue({ ok: true, result: {}, meta: {} })

    await getBerthStatus(42)
    await listBerthTasks(42)

    expect(call).toHaveBeenNthCalledWith(1, "runtime_bridge_operation", {
      args: {
        method: "berth.status",
        params: {},
        folderId: 42,
        timeoutMs: null,
      },
    })
    expect(call).toHaveBeenNthCalledWith(2, "runtime_bridge_operation", {
      args: {
        method: "task.list",
        params: {},
        folderId: 42,
        timeoutMs: null,
      },
    })
  })
})
