"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCw, Search, X } from "lucide-react"
import { toast } from "@/lib/notify"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  SidebarHeaderActions,
  SidebarHeaderButton,
  SidebarHeaderTabs,
} from "@/components/layout/sidebar/sidebar-header"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { readFileForEdit } from "@/lib/api"
import { getBerthStatus } from "@/lib/agent/berth-project"
import { EnableBerthNotice } from "@/components/project-management/enable-berth-notice"
import {
  addIdea,
  getClassifierSettings,
  getStaleKnowledgePaths,
  listJevEntries,
  moveJevEntry,
  listIdeas,
  saveClassifierConfig,
  searchKnowledge,
  setIdeaStatus,
  undoJevEntry,
  type ClassifierConfig,
  type JevEntry,
} from "@/knowledge/api/knowledge-client"
import { JevCalls } from "@/knowledge/components/jev-calls"
import { JevEntries } from "@/knowledge/components/jev-entries"
import { listDecisionCalls, type DecisionCall } from "@/lib/model-provider"
import { IdeaStream } from "@/knowledge/components/idea-stream"
import { NoteRows } from "@/knowledge/components/note-tree"
import {
  HOME_NOTE_PATH,
  VaultEmpty,
  VaultTree,
} from "@/knowledge/components/vault-browse"
import { useKnowledgeSnapshot } from "@/knowledge/hooks/use-knowledge-snapshot"
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
import type {
  Idea,
  IdeaStatus,
  KnowledgeDocument,
} from "@/knowledge/model/types"

type KnowledgeTab = "ideas" | "jev" | "notes"
/** 「Jev 动态」里看调用记录还是写入。 */
type JevView = "calls" | "writes"
/** 看调用记录时多久重读一次：后台分类随时在调。 */
const CALLS_POLL_MS = 10_000

/**
 * 侧栏「记忆」视图，两个 tab：
 * - 想法：用户随手记，交给 Agent 讨论；
 * - 知识：Agent 维护的笔记，只读阅读（阅读目录、待维护、引用当前文件）。
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
  const tClassifier = useTranslations("ClassifierSettings")
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
  const [view, setView] = useState<KnowledgeTab>("ideas")
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [jevEntries, setJevEntries] = useState<JevEntry[]>([])
  const [jevView, setJevView] = useState<JevView>("calls")
  const [jevCalls, setJevCalls] = useState<DecisionCall[]>([])
  /** 「Jev 动态」里的开关与改类选项；文件写错（null）时不显示，设置页会说明。 */
  const [classifier, setClassifier] = useState<ClassifierConfig | null>(null)
  const [busy, setBusy] = useState(false)
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
  // 想法不在快照里，单独读；vault 有变化时一起刷新。
  const loadIdeas = useCallback(
    () =>
      listIdeas(folderId)
        .then(setIdeas)
        .catch(() => {
          // 未启用时由启用提示接管。
        }),
    [folderId]
  )
  // 写入日志在 `.berth/local/`，不在监听范围：面板打开、切换分组和手动刷新时重读。
  const loadJev = useCallback(
    () =>
      listJevEntries(folderId)
        .then(setJevEntries)
        .catch(() => {}),
    [folderId]
  )
  // 调用记录按主项目路径筛选：worktree 项目看到的也是主项目那一份。
  const loadCalls = useCallback(
    () =>
      vaultRoot
        ? listDecisionCalls(vaultRoot)
            .then(setJevCalls)
            .catch(() => {})
        : Promise.resolve(),
    [vaultRoot]
  )
  useEffect(() => {
    if (!active || view !== "jev" || jevView !== "calls") return
    void loadCalls()
    const timer = window.setInterval(() => void loadCalls(), CALLS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [active, view, jevView, loadCalls])
  useEffect(() => {
    if (active) void loadIdeas()
  }, [active, loadIdeas])
  useEffect(() => {
    if (active && view === "jev") void loadJev()
  }, [active, view, loadJev])
  useEffect(() => {
    if (!active || view !== "jev") return
    getClassifierSettings()
      .then((settings) => setClassifier(settings.config))
      .catch(() => {})
  }, [active, view])
  const refreshAll = useCallback(
    () =>
      Promise.all([refresh(), loadIdeas(), loadJev(), loadCalls()]).then(
        () => {}
      ),
    [loadCalls, loadJev, loadIdeas, refresh]
  )

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

  const hasIdeas = ideas.length > 0
  const watchDirs = useMemo(
    () => (enabled === true ? knowledgeWatchDirs(snapshot, hasIdeas) : []),
    [enabled, hasIdeas, snapshot]
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
  const openDocument = (document: KnowledgeDocument) =>
    openPath(inVault(document.path))

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

  /** 发给本项目的 Agent 并提示；没有在运行的就打开启动栏，返回是否已发出。 */
  const sendToAgent = async (request: string) => {
    const agent = await sendToProjectAgent(folderId, folderPath, request)
    toast(agent ? t("agent.sent", { agent }) : t("agent.launchFirst"))
    return agent !== null
  }

  const saveIdea = async (text: string) => {
    let saved = false
    await run(async () => {
      const idea = await addIdea(folderId, text)
      setIdeas((current) => [idea, ...current])
      saved = true
    })
    return saved
  }

  const updateIdea = (idea: Idea) =>
    setIdeas((current) =>
      current.map((item) => (item.id === idea.id ? idea : item))
    )

  const discussIdea = (idea: Idea) =>
    run(async () => {
      const sent = await sendToAgent(t("ideas.discussRequest", { id: idea.id }))
      if (sent && idea.status === "待讨论")
        updateIdea(await setIdeaStatus(folderId, idea.id, "讨论中"))
    })

  const markIdea = (idea: Idea, status: IdeaStatus) =>
    run(async () => updateIdea(await setIdeaStatus(folderId, idea.id, status)))

  const replaceEntry = (old: JevEntry, next: JevEntry) =>
    setJevEntries((current) =>
      current.map((item) => (item === old ? next : item))
    )
  const undoEntry = (entry: JevEntry) =>
    run(async () => replaceEntry(entry, await undoJevEntry(folderId, entry.id)))
  const moveEntry = (entry: JevEntry, category: string) =>
    run(async () =>
      replaceEntry(entry, await moveJevEntry(folderId, entry.id, category))
    )
  const setClassifierEnabled = (enabled: boolean) =>
    classifier &&
    void run(async () =>
      setClassifier(await saveClassifierConfig({ ...classifier, enabled }))
    )

  return (
    <section className="flex h-full min-h-0 flex-col">
      <SidebarHeaderTabs<KnowledgeTab>
        tabs={[
          { id: "ideas", label: t("tabs.ideas") },
          { id: "jev", label: t("tabs.jev") },
          { id: "notes", label: t("tabs.notes") },
        ]}
        value={view}
        onChange={(next) => {
          setView(next)
          setSearch(null)
        }}
      />
      <SidebarHeaderActions>
        {view === "notes" ? (
          <SidebarHeaderButton
            icon={search ? X : Search}
            label={search ? t("closeSearch") : t("search")}
            onClick={() =>
              setSearch(search ? null : { query: "", results: null })
            }
          />
        ) : null}
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
            onChange={(event) =>
              setSearch({ ...search, query: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing)
                void runSearch(search.query)
              if (event.key === "Escape") setSearch(null)
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
        ) : view === "ideas" ? (
          <IdeaStream
            ideas={ideas}
            busy={busy}
            onAdd={saveIdea}
            onOpen={(idea) => openPath(inVault(idea.path))}
            onDiscuss={(idea) => void discussIdea(idea)}
            onDrop={(idea) => void markIdea(idea, "已放下")}
            onRestore={(idea) => void markIdea(idea, "待讨论")}
          />
        ) : view === "jev" ? (
          <div className="space-y-2 px-2 py-1.5">
            {classifier ? (
              <div className="flex items-start gap-2 rounded border p-2 text-xs">
                <p className="flex-1 text-muted-foreground">
                  {classifier.enabled
                    ? t("jev.running")
                    : tClassifier("enablePrompt")}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setClassifierEnabled(!classifier.enabled)}
                >
                  {classifier.enabled
                    ? t("jev.pause")
                    : tClassifier("enableNow")}
                </Button>
              </div>
            ) : null}
            <div className="flex gap-1 text-xs" role="tablist">
              {(["calls", "writes"] as const).map((item) => (
                <Button
                  key={item}
                  size="sm"
                  role="tab"
                  aria-selected={jevView === item}
                  variant={jevView === item ? "secondary" : "ghost"}
                  className="h-6 px-2"
                  onClick={() => setJevView(item)}
                >
                  {t(item === "calls" ? "jev.viewCalls" : "jev.viewWrites")}
                </Button>
              ))}
            </div>
            {jevView === "calls" ? (
              jevCalls.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("jev.callsEmpty")}
                </p>
              ) : (
                <JevCalls calls={jevCalls} />
              )
            ) : jevEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("jev.empty")}</p>
            ) : (
              <JevEntries
                entries={jevEntries}
                categories={classifier?.categories}
                onOpen={(entry) => openPath(inVault(entry.file))}
                onUndo={(entry) => void undoEntry(entry)}
                onMove={(entry, category) => void moveEntry(entry, category)}
              />
            )}
          </div>
        ) : !snapshot || !health ? null : search?.results ? (
          <NoteRows
            documents={search.results}
            empty={t("noResults")}
            onOpen={openDocument}
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
            activePath={activeRelPath}
            onOpen={openDocument}
          />
        )}
      </div>
    </section>
  )
}
