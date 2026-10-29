"use client"

import { useEffect, useLayoutEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { getCurrentWindow, subscribe } from "@/lib/platform"
import {
  WORKSPACE_OPEN_FILE_EVENT,
  claimOpenFileRequests,
  settleOpenFileRequest,
  type WorkspaceOpenFileClaim,
  type WorkspaceOpenFileOutcome,
  type WorkspaceOpenFilePayload,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { normalizeAbsPath } from "@/lib/files/file-open-target"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"

/** 事件只负责唤醒；回执来自本请求对应的可见文件与实际编辑器落点。 */
export function WorkspaceOpenFileListener() {
  const t = useTranslations("Pointer")
  const { openFilePreview } = useWorkspaceRuntimeActions()
  const actions = useRef({ openFilePreview, t })
  useLayoutEffect(() => {
    actions.current = { openFilePreview, t }
  }, [openFilePreview, t])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    let cancelActive: (() => void) | undefined
    const handled = new Set<number>()
    // 复用既有单槽，后一请求只能在前一请求结算后开始。
    let queue: Promise<void> = Promise.resolve()

    const runClaim = async (
      claim: WorkspaceOpenFileClaim,
      claimedAt: number
    ) => {
      if (disposed || handled.has(claim.request_id)) return
      handled.add(claim.request_id)
      const controller = new AbortController()
      cancelActive = () => controller.abort(new Error("file reveal cancelled"))
      let onReveal!: (outcome: WorkspaceOpenFileOutcome) => void
      const revealed = new Promise<WorkspaceOpenFileOutcome>((resolve) => {
        onReveal = (result) => {
          if (result.state === "failed") {
            controller.abort(new Error(result.message))
          } else {
            resolve(result)
          }
        }
      })
      let onAbort!: () => void
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener("abort", onAbort, { once: true })
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      let outcome: WorkspaceOpenFileOutcome
      try {
        const budget = claim.remaining_ms - (Date.now() - claimedAt)
        if (budget <= 0) throw new Error("file reveal timed out before opening")
        // 同一预算覆盖排队、加载与 reveal，不能在加载完成后重新计时。
        timer = setTimeout(
          () =>
            controller.abort(
              new Error(
                "file reveal timed out; the workspace may still open the file"
              )
            ),
          budget
        )
        outcome = await Promise.race([
          Promise.all([
            actions.current.openFilePreview(claim.path, {
              line: claim.line ?? undefined,
              onReveal,
              signal: controller.signal,
            }),
            revealed,
          ]).then(([, result]) => result),
          aborted,
        ])
        if (outcome.state === "failed") throw new Error(outcome.message)
        if (normalizeAbsPath(outcome.path) !== normalizeAbsPath(claim.path)) {
          throw new Error("file reveal path does not match its target")
        }
        if (
          (claim.line != null && outcome.line === null) ||
          (outcome.line !== null &&
            (!Number.isSafeInteger(outcome.line) || outcome.line < 1))
        ) {
          throw new Error("file line reveal was not confirmed")
        }
      } catch (error) {
        const message = toErrorMessage(error)
        if (!disposed)
          toast.error(actions.current.t("openFailed"), { description: message })
        outcome = { state: "failed", message }
      } finally {
        clearTimeout(timer)
        controller.signal.removeEventListener("abort", onAbort)
        cancelActive = undefined
        const store = useWorkspaceFileStore.getState()
        if (store.pendingFileReveal?.onComplete === onReveal) {
          store.setPendingFileReveal(null)
        }
      }
      // IPC 失败不重放打开动作，也不再发送一个相反的结算结果。
      await settleOpenFileRequest(claim.request_id, outcome)
    }

    const claimAndProcess = () => {
      queue = queue
        .then(async () => {
          if (disposed) return
          const claims = await claimOpenFileRequests()
          const claimedAt = Date.now()
          for (const claim of claims) await runClaim(claim, claimedAt)
        })
        .catch(() => undefined)
    }

    void (async () => {
      const win = await getCurrentWindow()
      if (win && win.label !== "main") return
      if (disposed) return
      const dispose = await subscribe<WorkspaceOpenFilePayload>(
        WORKSPACE_OPEN_FILE_EVENT,
        claimAndProcess
      )
      if (disposed) dispose()
      else {
        unlisten = dispose
        // 订阅安装完成后再领取，覆盖安装期间没有唤醒事件的请求。
        claimAndProcess()
      }
    })()

    return () => {
      disposed = true
      unlisten?.()
      cancelActive?.()
    }
  }, [])

  return null
}
