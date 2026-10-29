/**
 * 项目是否启用 Berth（`.berth/`）与启用；任务、群组、记忆都依赖它。
 */
import {
  runtimeBridgeOperation,
  type RuntimeBridgeResponse,
} from "@/lib/runtime-bridge"

function call<T>(
  folderId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<RuntimeBridgeResponse<T>> {
  return runtimeBridgeOperation<T>({ method, folderId, params })
}

/** 项目是否已启用 Berth（有 `.berth/`）。 */
export function getBerthStatus(folderId: number) {
  return call<{ enabled: boolean }>(folderId, "berth.status")
}

/** 创建项目 `.berth/` 骨架（`berth project init`）；幂等。 */
export function enableBerth(folderId: number) {
  return call<{ root: string; created: string[] }>(folderId, "berth.init")
}
