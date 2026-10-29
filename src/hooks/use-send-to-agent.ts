"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { copyTextFromMenu } from "@/lib/utils"
import { planReferenceAction } from "@/lib/content-reference/plan-action"
import { resolveEditorReferenceTarget } from "@/lib/content-reference/resolve-target"
import type { ContentSourceKind } from "@/lib/content-reference/types"
import { useTabStore } from "@/stores/tab-store"
import { useTerminalRuntimeStore } from "@/stores/terminal-runtime-store"

/**
 * 把一段文本放进会话区当前 Agent 终端的输入框：只粘贴、从不回车，由用户补充后自己提交。
 * 发不了（不是 Agent 终端、断开、多行但终端不支持安全粘贴…）就复制到剪贴板并说明原因。
 */
export function useSendToAgent() {
  const t = useTranslations("SendToAgent")
  const tRef = useTranslations("Folder.fileWorkspacePanel")
  const target = useTabStore((s) => {
    const tab = s.tabs.find((candidate) => candidate.id === s.activeTabId)
    return tab?.kind === "terminal" && tab.agentType ? tab : null
  })

  const fallback = useCallback(
    (text: string, reason: string) =>
      void copyTextFromMenu(text).then((copied) =>
        copied
          ? toast.info(t("copiedInstead", { reason }))
          : toast.error(reason)
      ),
    [t]
  )

  const send = useCallback(
    async (text: string) => {
      if (!target) {
        fallback(text, t("noAgent"))
        return
      }
      const result = await useTerminalRuntimeStore
        .getState()
        .pasteText(target.terminalId, text, {
          submit: false,
          source: "document-context",
          tabId: target.id,
          backendInstanceId: target.backendInstanceId,
        })
      if (result.ok) {
        toast.success(t("sent", { name: target.title }))
        return
      }
      fallback(
        text,
        result.reason === "unsafe-multiline"
          ? t("unsafeMultiline")
          : t("unavailable")
      )
    },
    [target, t, fallback]
  )

  /** 整个文件：发一行「请查看 `路径`」，路径按 Agent 终端的 cwd 投影成相对路径。 */
  const sendFile = useCallback(
    async (file: {
      kind?: ContentSourceKind
      absolutePath: string
      workspacePath?: string | null
      fileName: string
    }) => {
      const tabs = useTabStore.getState()
      const plan = target
        ? planReferenceAction(
            {
              kind: file.kind ?? "path-only",
              absolutePath: file.absolutePath,
              workspacePath: file.workspacePath ?? null,
              fileName: file.fileName,
              sourceFolderId: null,
              sourceBackendInstanceId: target.backendInstanceId,
            },
            null,
            resolveEditorReferenceTarget(tabs.activeTabId, tabs.tabs),
            { type: "whole-file" },
            { translate: (key, values) => tRef(key, values) }
          )
        : null
      if (plan?.kind === "terminal-preview") {
        await send(plan.text)
        return
      }
      // 不是 Agent 终端 / 路径在 Agent 那边不可达：退回复制路径
      fallback(
        plan?.kind === "copy-only" ? plan.text : file.absolutePath,
        target ? t("unavailable") : t("noAgent")
      )
    },
    [target, send, fallback, t, tRef]
  )

  return {
    label: target ? t("sendTo", { name: target.title }) : t("send"),
    send,
    sendFile,
  }
}
