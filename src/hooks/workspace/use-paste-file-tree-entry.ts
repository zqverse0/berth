"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { copyFileTreeEntry } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { pullDeviceFile, transferInto } from "@/lib/devices"
import { joinFsPath } from "@/lib/files/path-utils"
import { dismissToast, toast } from "@/lib/notify"
import { readClipboardFiles, writeClipboardFiles } from "@/lib/platform"
import { parseDeviceRef } from "@/lib/transport/device"
import { copyTextFromMenu } from "@/lib/utils"
import {
  useFileTreeClipboardStore,
  type FileTreeClipboardEntry,
} from "@/stores/file-tree-clipboard-store"

const MISSING_COMMAND = /^Command \S+ not found$/
/** {@link usePasteFileTreeEntry} 内部：已开始传到设备（路径里不会有 NUL）。 */
const SENT = "\0sent"

/**
 * 文件树「复制」。本机文件写进系统剪贴板，文件管理器能粘贴；对方设备的文件系统剪贴板放不了，
 * 写入路径文本把旧的文件列表顶掉，粘贴时才会落到内部剪贴板这一条（见 {@link readPasteEntries}）。
 */
export function copyEntryToClipboard(entry: FileTreeClipboardEntry): void {
  useFileTreeClipboardStore.getState().copy(entry)
  const device = parseDeviceRef(entry.absPath)
  if (device) void copyTextFromMenu(device.value)
  // 写失败（如纯 Wayland 下读写不了）时内部剪贴板仍可粘贴。
  else void writeClipboardFiles([entry.absPath]).catch(() => {})
}

/** 现在能粘贴什么：系统剪贴板里有文件就用它（谁后复制谁赢），否则用内部剪贴板。 */
export async function readPasteEntries(): Promise<FileTreeClipboardEntry[]> {
  const system = await readClipboardFiles().catch(() => [])
  if (system.length > 0) return system
  const entry = useFileTreeClipboardStore.getState().entry
  return entry ? [entry] : []
}

/**
 * 把剪贴板里的文件粘贴进 `rootPath`（本机或 `berth-device://` 项目）下的 `destDir`。
 * 同一台机器上由后端复制（含目录）；跨机器走设备传输，只支持文件（对方已有同名文件时传输失败，不覆盖）。
 * 返回最后落到项目里的相对路径；传到设备是异步的（进度在设备侧栏），只传了设备时返回 `null`。
 */
export function usePasteFileTreeEntry() {
  const t = useTranslations("Folder.fileTreeTab")
  const tCommon = useTranslations("Folder.common")

  /** 粘贴一项：落到本机 / 同设备返回相对路径，开始传输返回 {@link SENT}，失败或取消返回 `null`。 */
  const pasteOne = useCallback(
    async (
      entry: FileTreeClipboardEntry,
      rootPath: string,
      destDir: string
    ): Promise<string | null> => {
      const from = parseDeviceRef(entry.absPath)
      const to = parseDeviceRef(rootPath)
      try {
        if (from?.deviceId === to?.deviceId) {
          try {
            return await copyFileTreeEntry(entry.absPath, rootPath, destDir)
          } catch (error) {
            // 对方的 Berth 比本机旧，没有这个命令：文件退回「拉到本机再传回去」。
            if (!from || !MISSING_COMMAND.test(toErrorMessage(error)))
              throw error
            if (entry.kind === "dir") {
              toast.error(t("toasts.pasteNeedsUpgrade"))
              return null
            }
          }
        } else if (entry.kind === "dir") {
          toast.error(t("toasts.transferDirUnsupported"))
          return null
        }
        let local: string | null = entry.absPath
        if (from) {
          let cancel: (() => void) | null = null
          const pulling = toast.info(
            t("toasts.pullingFromDevice", { name: entry.name }),
            {
              action: { label: tCommon("cancel"), onClick: () => cancel?.() },
            }
          )
          try {
            local = await pullDeviceFile(from.deviceId, from.value, (stop) => {
              cancel = stop
            })
          } finally {
            dismissToast(pulling)
          }
          if (!local) return null
        }
        if (to) {
          await transferInto(
            { deviceId: to.deviceId, dir: joinFsPath(to.value, destDir) },
            local
          )
          return SENT
        }
        return await copyFileTreeEntry(local, rootPath, destDir)
      } catch (error) {
        const message = toErrorMessage(error)
        toast.error(t("toasts.pasteFailed"), {
          // 对方节点旧到不认识下载请求。
          description: message.includes("unknown variant `get_begin`")
            ? t("toasts.pasteNeedsUpgrade")
            : message,
        })
        return null
      }
    },
    [t, tCommon]
  )

  return useCallback(
    async (rootPath: string, destDir: string): Promise<string | null> => {
      const entries = await readPasteEntries()
      const results: string[] = []
      for (const entry of entries) {
        const result = await pasteOne(entry, rootPath, destDir)
        if (result !== null) results.push(result)
      }
      if (results.length === 0) return null
      const only = entries.length === 1 ? entries[0].name : null
      const sent = results.includes(SENT)
      if (sent) {
        toast.info(
          only
            ? t("toasts.transferStarted", { name: only })
            : t("toasts.transferStartedCount", { count: results.length })
        )
        return null
      }
      toast.success(
        only
          ? t("toasts.pasted", { name: only })
          : t("toasts.pastedCount", { count: results.length })
      )
      return results[results.length - 1]
    },
    [pasteOne, t]
  )
}
