"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useTabStore } from "@/stores/tab-store"
import type { AgentType } from "@/lib/types"
import { getTerminalSession, getRuntimeCapabilities } from "@/lib/api"
import { extractAppCommandError } from "@/lib/app-error"
import {
  isPersonalTerminalCapable,
  tabFromDescriptor,
} from "@/lib/terminal/create-and-open-primary-terminal"
import { isTerminalTab, type TerminalTab } from "@/lib/workspace/primary-tabs"
import { useTerminalRuntimeStore } from "@/stores/terminal-runtime-store"

/**
 * Handles `/workspace?folderId=X&conversationId=Y&agent=Z` and
 * `/workspace?terminalId=<id>` URLs.
 * Runs once after both folders and tabs have hydrated.
 * Terminal links never auto-create a shell.
 */
export function DeepLinkBootstrap() {
  const tTerminal = useTranslations("Folder.terminal")
  const foldersHydrated = useAppWorkspaceStore((s) => s.foldersHydrated)
  const tabsHydrated = useTabStore((s) => s.tabsHydrated)
  const { openTerminalTab } = useTabActions()
  const { openTranscriptTab } = useWorkspaceRuntimeActions()
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    if (!foldersHydrated || !tabsHydrated) return
    ranRef.current = true

    if (typeof window === "undefined") return

    const params = new URLSearchParams(window.location.search)
    const rawTerminalId = params.get("terminalId")
    const rawFolderId = params.get("folderId")
    const rawConversationId = params.get("conversationId")
    const rawAgent = params.get("agent") as AgentType | null

    const clearDeepLinkParams = (keys: string[]) => {
      try {
        const next = new URLSearchParams(window.location.search)
        for (const key of keys) next.delete(key)
        const qs = next.toString()
        const url = qs ? `/workspace?${qs}` : "/workspace"
        window.history.replaceState({}, "", url)
      } catch {
        /* ignore */
      }
    }

    const clearUrl = () => {
      try {
        window.history.replaceState({}, "", "/workspace")
      } catch {
        /* ignore */
      }
    }

    if (rawTerminalId) {
      void (async () => {
        try {
          await resolveTerminalDeepLink(rawTerminalId, openTerminalTab, {
            invalidLink: tTerminal("invalidLink"),
            upgradeToOpenPersonal: tTerminal("upgradeToOpenPersonal"),
            authorizationRequired: tTerminal("authorizationRequired"),
            notFound: tTerminal("notFound"),
            openLinkedFailed: tTerminal("openLinkedFailed"),
          })
        } finally {
          clearDeepLinkParams(["terminalId"])
        }
      })()
      return
    }

    if (!rawFolderId && !rawConversationId) return

    void (async () => {
      try {
        const folderId = rawFolderId ? Number(rawFolderId) : null
        const conversationId = rawConversationId
          ? Number(rawConversationId)
          : null

        if (folderId == null || !Number.isFinite(folderId)) return
        if (conversationId == null || !Number.isFinite(conversationId)) return
        if (!rawAgent) return

        // Read at run time: this effect fires once when hydration completes,
        // and getState() sees exactly the lists as of that moment.
        const { folders, addFolderToWorkspaceById, conversations } =
          useAppWorkspaceStore.getState()

        let folder = folders.find((f) => f.id === folderId)
        if (!folder) {
          try {
            folder = await addFolderToWorkspaceById(folderId)
          } catch (err) {
            console.error("[DeepLinkBootstrap] open folder failed:", err)
            toast.error("Unable to open linked folder")
            return
          }
        }

        const conversation = conversations.find(
          (c) =>
            c.id === conversationId &&
            c.folder_id === folderId &&
            c.agent_type === rawAgent
        )
        if (!conversation) {
          toast.error("Linked conversation not found")
          return
        }

        openTranscriptTab({
          folderId,
          conversationId,
          agentType: rawAgent,
          title: conversation.title ?? String(conversationId),
        })
      } finally {
        clearUrl()
      }
    })()
  }, [
    foldersHydrated,
    tabsHydrated,
    openTerminalTab,
    openTranscriptTab,
    tTerminal,
  ])

  return null
}

async function resolveTerminalDeepLink(
  terminalId: string,
  openTerminalTab: (tab: TerminalTab, activate?: boolean) => void,
  messages: {
    invalidLink: string
    upgradeToOpenPersonal: string
    authorizationRequired: string
    notFound: string
    openLinkedFailed: string
  }
): Promise<void> {
  const id = terminalId.trim()
  if (!id) {
    toast.error(messages.invalidLink)
    return
  }

  try {
    const caps = await getRuntimeCapabilities()
    if (!isPersonalTerminalCapable(caps)) {
      toast.error(messages.upgradeToOpenPersonal)
      return
    }
  } catch {
    // Continue: local desktop always has capabilities; remote may still answer get.
  }

  const tabs = useTabStore.getState().tabs
  const persisted = tabs.find(
    (tab): tab is TerminalTab => isTerminalTab(tab) && tab.terminalId === id
  )

  const runtime = useTerminalRuntimeStore.getState()

  try {
    const descriptor = await getTerminalSession(id)

    // Running backend but persisted tab points at a previous instance.
    if (
      persisted &&
      persisted.backendInstanceId &&
      persisted.backendInstanceId !== descriptor.backendInstanceId
    ) {
      // A daemon restart creates a fresh in-memory runtime. Drop the stale
      // persisted tab and let the next terminal creation allocate a new window.
      runtime.showInstanceExpired(id)
      return
    }

    openTerminalTab(
      tabFromDescriptor(descriptor, { title: persisted?.title }),
      true
    )
    // Attach happens when the tab view mounts; deep link only opens metadata.
  } catch (err) {
    const appErr = extractAppCommandError(err)
    const code = appErr?.code ?? ""

    if (
      code === "authentication_failed" ||
      code === "permission_denied" ||
      code === "unauthorized"
    ) {
      // Opaque: do not reveal whether the terminal exists.
      toast.error(messages.authorizationRequired)
      return
    }

    if (code === "terminal_instance_expired") {
      runtime.showInstanceExpired(id)
      return
    }

    if (code === "terminal_not_found" || code === "not_found") {
      if (persisted) {
        // Runtime state is memory-only: an absent window is simply stale.
        runtime.showInstanceExpired(id)
        return
      }
      toast.error(messages.notFound)
      return
    }

    console.error("[DeepLinkBootstrap] terminal link failed:", err)
    toast.error(messages.openLinkedFailed)
  }
}
