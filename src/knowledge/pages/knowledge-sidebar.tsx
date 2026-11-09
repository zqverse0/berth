"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCw, Search, X } from "lucide-react"
import { toast } from "@/lib/notify"
import { Input } from "@/components/ui/input"
import {
  SidebarHeaderActions,
  SidebarHeaderButton,
} from "@/components/layout/sidebar/sidebar-header"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { readFileForEdit } from "@/lib/api"
import { getBerthStatus } from "@/lib/agent/berth-project"
import { EnableBerthNotice } from "@/components/project-management/enable-berth-notice"
import {
  getStaleKnowledgePaths,
  searchKnowledge,
} from "@/knowledge/api/knowledge-client"
import { InboxList } from "@/knowledge/components/inbox-list"
import { NoteDetail } from "@/knowledge/components/note-detail"
import { NoteRows } from "@/knowledge/components/note-tree"
import {
  HOME_NOTE_PATH,
  VaultEmpty,
  VaultTree,
} from "@/knowledge/components/vault-browse"
import { useKnowledgeFocus } from "@/knowledge/hooks/use-knowledge-focus"
import { useKnowledgeSnapshot } from "@/knowledge/hooks/use-knowledge-snapshot"
import { openCodePath } from "@/knowledge/preview/vault-note"
import {
  knowledgeWatchDirs,
  useKnowledgePathRefresh,
} from "@/knowledge/hooks/use-knowledge-path-refresh"
import {
  codeMentions,
  isVaultNotePath,
  projectRelativePath,
  vaultHealth,
} from "@/knowledge/lib/vault"
import { sendToProjectAgent } from "@/knowledge/lib/send-to-agent"
import type { KnowledgeDocument } from "@/knowledge/model/types"

/**
 * 侧栏「记忆」视图：Agent 维护的笔记，只读阅读（阅读目录、待维护、引用当前文件）。
 * 点笔记先选中，底部显示详情与关联（原首页星图的右栏），「打开笔记」再进主区；
 * 选中与搜索词和首页星图共用（`useKnowledgeFocus`）。
 */
export function KnowledgeSidebar({
  folderId,
  folderPath,
  active,
}: {
  folderId: number
  folderPath: string
  active: boolean
}) {
  const t = useTranslations("Knowledge")
  const workspace = useWorkspaceRuntimeActions()
  const { snapshot, loading, error, refresh } = useKnowledgeSnapshot(
    folderId,
    active
  )
  const [homeContent, setHomeContent] = useState<string | null>(null)
  const [stalePaths, setStalePaths] = useState<string[]>([])
  const [search, setSearch] = useState<{
    query: string
    results: KnowledgeDocument[] | null
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const { selected, select, setQuery } = useKnowledgeFocus()
  const [actionError, setActionError] = useState<string | null>(null)

  const activeFilePath = useWorkspaceFileStore((state) => {
    const tab = state.fileTabs.find((item) => item.id === state.activeFileTabId)
    return tab?.kind === "file" ? (tab.path ?? null) : null
  })
  const activeRelPath = activeFilePath
    ? projectRelativePath(activeFilePath, folderPath)
    : null

  // vault 在主项目：worktree 项目也读写、监听主项目那一份。
  const vaultRoot = snapshot?.root ?? null
  const refreshAll = useCallback(() => refresh().then(() => {}), [refresh])

  const revision = snapshot?.revision
  // `.berth/` 只由「启用 Berth」/ `berth project init` 创建：未启用时不让新建笔记隐式建目录。
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    getBerthStatus(folderId)
      .then((response) => {
        if (!cancelled) setEnabled(!response.ok || response.result.enabled)
      })
      .catch(() => {
        if (!cancelled) setEnabled(true)
      })
    return () => {
      cancelled = true
    }
  }, [active, folderId, revision])

  const watchDirs = useMemo(
    () => (enabled === true ? knowledgeWatchDirs(snapshot) : []),
    [enabled, snapshot]
  )
  useKnowledgePathRefresh({ dirs: watchDirs, active, onRefresh: refreshAll })

  // 过期判断要跑 git：只在面板可见且 vault 变化时计算一次。
  const needsStale = active && revision !== undefined
  useEffect(() => {
    if (!needsStale) return
    let cancelled = false
    getStaleKnowledgePaths(folderId)
      .then((paths) => {
        if (!cancelled) setStalePaths(paths)
      })
      .catch(() => {
        // git 不可用时不标过期。
      })
    return () => {
      cancelled = true
    }
  }, [folderId, needsStale, revision])

  // 目录树由首页结构生成；vault 变化时重读首页。
  useEffect(() => {
    if (!active || !vaultRoot || revision === undefined) return
    let cancelled = false
    readFileForEdit(vaultRoot, HOME_NOTE_PATH)
      .then((file) => {
        if (!cancelled) setHomeContent(file.content)
      })
      .catch(() => {
        if (!cancelled) setHomeContent(null)
      })
    return () => {
      cancelled = true
    }
  }, [active, vaultRoot, revision])

  const health = useMemo(
    () => (snapshot ? vaultHealth(snapshot, stalePaths) : null),
    [snapshot, stalePaths]
  )

  const mentions = useMemo(
    () =>
      snapshot && activeRelPath && !isVaultNotePath(activeRelPath)
        ? codeMentions(snapshot.documents, activeRelPath)
        : [],
    [activeRelPath, snapshot]
  )

  const openPath = useCallback(
    (path: string) => void workspace.openFilePreview(path, { folderId }),
    [folderId, workspace]
  )
  const inVault = (path: string) =>
    `${(vaultRoot ?? folderPath).replace(/[\\/]+$/, "")}/${path}`
  const selectDocument = (document: KnowledgeDocument) => select(document.id)
  const selectedDocument = snapshot?.documents.find((d) => d.id === selected)
  const closeSearch = () => {
    setSearch(null)
    setQuery("")
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setActionError(null)
    try {
      await action()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const runSearch = (query: string) =>
    run(async () => {
      const value = query.trim()
      setSearch({
        query,
        results: value
          ? (await searchKnowledge(folderId, value)).documents
          : null,
      })
    })

  /** 发给本项目的 Agent 并提示；没有在运行的就打开启动栏。 */
  const sendToAgent = async (request: string) => {
    const agent = await sendToProjectAgent(folderId, folderPath, request)
    toast(agent ? t("agent.sent", { agent }) : t("agent.launchFirst"))
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <SidebarHeaderActions>
        <SidebarHeaderButton
          icon={search ? X : Search}
          label={search ? t("closeSearch") : t("search")}
          onClick={() =>
            search ? closeSearch() : setSearch({ query: "", results: null })
          }
        />
        <SidebarHeaderButton
          icon={RefreshCw}
          label={t("refresh")}
          disabled={loading}
          onClick={() => void refreshAll()}
        />
      </SidebarHeaderActions>
      {search ? (
        <div className="border-b px-2.5 py-2">
          <Input
            autoFocus
            value={search.query}
            onChange={(event) => {
              setSearch({ ...search, query: event.target.value })
              setQuery(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing)
                void runSearch(search.query)
              if (event.key === "Escape") closeSearch()
            }}
            placeholder={t("searchPlaceholder")}
            aria-label={t("search")}
            className="h-8"
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error || actionError ? (
          <p className="m-1.5 rounded border border-destructive/30 p-2 text-xs text-destructive">
            {actionError ?? error}
          </p>
        ) : null}
        {enabled !== false && snapshot && !search?.results ? (
          <InboxList
            items={snapshot.inbox}
            onOpen={(item) => openPath(inVault(item.path))}
          />
        ) : null}
        {enabled === false ? (
          <div className="p-2">
            <EnableBerthNotice
              folderId={folderId}
              onEnabled={() => {
                setEnabled(true)
                void refreshAll()
              }}
            />
          </div>
        ) : !snapshot || !health ? null : search?.results ? (
          <NoteRows
            documents={search.results}
            empty={t("noResults")}
            onOpen={selectDocument}
          />
        ) : snapshot.documents.length === 0 ? (
          <VaultEmpty
            busy={busy}
            onAskAgent={() =>
              void run(async () => {
                await sendToAgent(t("empty.agentRequest"))
              })
            }
          />
        ) : (
          <VaultTree
            documents={snapshot.documents}
            homeContent={homeContent}
            health={health}
            mentions={mentions}
            activePath={selectedDocument?.path ?? activeRelPath}
            onOpen={selectDocument}
          />
        )}
      </div>
      {snapshot && selectedDocument ? (
        <div className="max-h-[55%] shrink-0 overflow-auto border-t px-3 py-2.5">
          <NoteDetail
            document={selectedDocument}
            documents={snapshot.documents}
            edges={snapshot.edges}
            onSelect={select}
            onOpenNote={(path) => openPath(inVault(path))}
            onOpenCode={(code) => openCodePath(folderPath, code, openPath)}
          />
        </div>
      ) : null}
    </section>
  )
}
