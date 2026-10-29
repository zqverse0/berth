/**
 * Runtime bridge client: one Tauri command routing method strings to
 * in-process handlers (knowledge / Berth tasks / collaboration channels).
 */

import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { getTransport } from "@/lib/transport"

export interface RuntimeBridgeMeta {
  binaryPath: string
  binarySource: string
  durationMs: number
  method: string
}

export interface RuntimeBridgeError {
  /** 后端 handler 自定义的错误类别，如 `berth_tasks`、`unknown`。 */
  kind: string
  message: string
  code?: number | string
  data?: unknown
  method: string
}

export type RuntimeBridgeResponse<T = unknown> =
  | { ok: true; result: T; meta: RuntimeBridgeMeta }
  | { ok: false; error: RuntimeBridgeError; result?: T }

export async function runtimeBridgeOperation<T = unknown>(args: {
  method: string
  params?: Record<string, unknown>
  folderId?: number
  timeoutMs?: number
}): Promise<RuntimeBridgeResponse<T>> {
  let raw: unknown
  try {
    raw = await getTransport().call<RuntimeBridgeResponse<T>>(
      "runtime_bridge_operation",
      {
        args: {
          method: args.method,
          params: args.params ?? {},
          folderId: args.folderId ?? null,
          timeoutMs: args.timeoutMs ?? null,
        },
      }
    )
  } catch (cause) {
    // 命令本身失败（如项目刚被删除，`folderId` 已不存在）：同样以 `ok: false` 返回，
    // 调用方只需看 `ok`，不会因为没接住拒绝而冒出未处理的错误。
    const appError = extractAppCommandError(cause)
    return {
      ok: false,
      error: {
        kind: appError?.code ?? "transport",
        message: toErrorMessage(cause),
        method: args.method,
      },
    }
  }
  if (raw && typeof raw === "object" && "ok" in raw) {
    return raw as RuntimeBridgeResponse<T>
  }
  return {
    ok: false,
    error: {
      kind: "unknown",
      message: "Unexpected bridge response shape",
      method: args.method,
    },
  }
}
