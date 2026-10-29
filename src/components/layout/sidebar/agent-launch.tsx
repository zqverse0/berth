"use client"

import { useEffect } from "react"
import {
  AlertTriangle,
  ChevronLeft,
  CornerDownLeft,
  Download,
  Loader2,
  Plus,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { AgentProfileIcon } from "@/components/agents/profile/agent-profile-icon"
import { LAUNCHBAR_COMPONENTS } from "@/components/launchbar/registry"
import { useLaunchbar } from "@/components/launchbar/use-launchbar"
import { ColorTerminalIcon } from "@/components/layout/status-bar/status-bar-terminal"
import { usageTextColorClass } from "@/components/layout/status-bar/status-bar-usage"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAgentProfiles } from "@/hooks/use-agent-profiles"
import { useOpenWorkbenchPanel } from "@/hooks/workspace/use-open-workbench-panel"
import { createAndOpenFolderTerminal } from "@/lib/terminal/create-and-open-primary-terminal"
import type { UsageState } from "@/lib/transport/usage"
import { cn } from "@/lib/utils"
import { useStatusBarLaunchStore } from "@/stores/agent-launch-store"
import {
  PANE_POPOVER_FIT,
  TAB_TOOLBAR_BUTTON,
  usePaneBoundary,
} from "@/components/tabs/workspace-tab-strip"
import {
  programReady,
  useToolsSettingsStore,
} from "@/stores/tools-settings-store"

/** 选中 Agent 的启动栏表单与启动按钮；新建协作对话框也复用它。 */
export function AgentLaunchShelfContent({
  agentId,
  workingDirectory,
  folderId,
  expert,
  onClose,
  prepareLaunch,
}: {
  agentId: string
  workingDirectory: string
  folderId?: number | null
  expert?: string | null
  onClose: () => void
  prepareLaunch?: () => Promise<Record<string, string | boolean>>
}) {
  const tProjectSessions = useTranslations("Folder.projectSessions")

  const {
    selectedName,
    binding,
    renderedItems,
    launchbarValues,
    launchbarDiagnostics,
    launchingCli,
    busy,
    showLaunchButton,
    handleValueChange,
    handleVendorChange,
    handleModelChange,
    handleInspectSession,
    handleLaunchCli,
  } = useLaunchbar({
    workingDirectory,
    folderId,
    agentId,
    expert,
    onLaunched: onClose,
    prepareLaunch,
  })

  // 按 Enter 键触发启动
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        const target = e.target instanceof Element ? e.target : null
        // 表单本身也在弹层里：只跳过表单里下拉框自己弹层中的输入框。
        const popover = target?.closest("[data-slot='popover-content']")
        if (
          target &&
          (target.closest("[role='listbox']") ||
            (target.tagName === "INPUT" &&
              popover &&
              !popover.querySelector("[data-agent-launch-view]")) ||
            target.tagName === "TEXTAREA")
        ) {
          return
        }
        if (showLaunchButton && !busy) {
          e.preventDefault()
          void handleLaunchCli()
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [showLaunchButton, busy, handleLaunchCli])

  return (
    <>
      {/* 中间：单列参数表单，开关/输入自带标签 */}
      <div className="flex flex-col gap-3">
        {(renderedItems ?? []).map((item) => {
          const Component = LAUNCHBAR_COMPONENTS[item.component]
          if (!Component) return null
          const value =
            item.optionsFrom === "providerVendor"
              ? (binding?.vendor ?? "")
              : launchbarValues[item.id] || null
          const onChange =
            item.optionsFrom === "providerVendor"
              ? handleVendorChange
              : item.optionsFrom === "providerModels"
                ? (next: string) => void handleModelChange(next)
                : (next: string) => handleValueChange(item.id, next)
          const isSelect = item.component === "select"
          return (
            <div
              key={item.id}
              className={cn(
                "flex min-w-0 flex-col gap-1",
                !isSelect && "justify-end"
              )}
            >
              {isSelect && (
                <span className="text-[11px] font-medium text-muted-foreground select-none">
                  {item.label}
                </span>
              )}
              <div className="w-full [&_button[role=combobox]]:w-full [&_button[role=combobox]]:max-w-full [&_button[role=combobox]]:h-8 [&_button[role=combobox]]:justify-between [&_label]:w-full [&_label]:justify-between [&_label_input]:h-8 [&_span[class*='border-border']]:w-full [&_span[class*='border-border']]:h-8 [&_span[class*='border-border']]:justify-between">
                <Component
                  item={item}
                  inline
                  value={value}
                  onChange={onChange}
                  onInspect={
                    item.optionsFrom === "projectSessions"
                      ? (next) => void handleInspectSession(next)
                      : undefined
                  }
                />
              </div>
            </div>
          )
        })}
        {launchbarDiagnostics.map((message) => (
          <p
            key={message}
            role="alert"
            className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-2 font-medium"
          >
            {message}
          </p>
        ))}
      </div>

      {/* 底部：通栏启动按钮，Enter 同效 */}
      {showLaunchButton && (
        <div className="shrink-0 pt-2.5 border-t border-border/60">
          <Button
            variant="default"
            className="h-9 w-full justify-center gap-2 text-sm font-medium"
            onClick={() => void handleLaunchCli()}
            disabled={busy}
            title={tProjectSessions("pressEnterToLaunch")}
          >
            {launchingCli ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {tProjectSessions("launchAgent", {
              name: selectedName ?? agentId,
            })}
            <kbd className="ml-1 inline-flex items-center rounded border border-primary-foreground/30 px-1 py-0.5 text-primary-foreground/80">
              <CornerDownLeft className="size-3" aria-hidden="true" />
            </kbd>
          </Button>
        </div>
      )}
    </>
  )
}

/**
 * 启动栏顶部的程序提示，只在需要用户处理时出现：没装 / 跑不起来 / 有新版本。
 * 与设置 → 工具 共用检测与更新（`useToolsSettingsStore`）。
 */
function AgentProgramNotice({ agentId }: { agentId: string }) {
  const t = useTranslations("ToolsSettings")
  const program = useToolsSettingsStore((state) => state.programs[agentId])
  const updateCheck = useToolsSettingsStore(
    (state) => state.updateChecks[agentId]
  )
  const run = useToolsSettingsStore((state) => state.installs[agentId])
  const { loadProgram, checkUpdate, runInstall, selectTool } =
    useToolsSettingsStore.getState()
  const { openSettings } = useOpenWorkbenchPanel()
  const ready = programReady(program)

  // 每次打开都重测本地程序（可能刚在终端里装好）；最新版本每次运行只查一次。
  useEffect(() => {
    void loadProgram(agentId)
  }, [agentId, loadProgram])
  useEffect(() => {
    if (ready && updateCheck === undefined) void checkUpdate(agentId)
  }, [agentId, checkUpdate, ready, updateCheck])

  const info = program && !("error" in program) ? program : null
  if (!info) return null
  const update =
    ready && updateCheck && "updateAvailable" in updateCheck
      ? updateCheck
      : null
  if (ready && !update?.updateAvailable && !run?.running && !run?.error)
    return null

  const openInSettings = () => {
    selectTool(agentId)
    openSettings("tools")
  }
  const actionClass = "h-6 shrink-0 px-2 text-xs"
  let message: string
  let action: React.ReactNode = null
  if (run?.running) {
    message =
      run.log ?? t(info.installed ? "programUpdating" : "programInstalling")
  } else if (!info.installed) {
    message = t("shelfMissing")
    action = info.installScript ? (
      <Button
        size="sm"
        className={actionClass}
        onClick={() => void runInstall(agentId, false)}
      >
        <Download className="mr-1 h-3 w-3" />
        {t("programInstall")}
      </Button>
    ) : (
      <Button
        size="sm"
        variant="outline"
        className={actionClass}
        onClick={openInSettings}
      >
        {t("shelfOpenSettings")}
      </Button>
    )
  } else if (!ready) {
    message = t("programBroken", { error: info.runtimeError ?? "" })
    action = (
      <Button
        size="sm"
        variant="outline"
        className={actionClass}
        onClick={openInSettings}
      >
        {t("shelfOpenSettings")}
      </Button>
    )
  } else {
    message = t("updateAvailable", { version: update?.latest ?? "" })
    action = info.canUpdate ? (
      <Button
        size="sm"
        variant="outline"
        className={actionClass}
        onClick={() => void runInstall(agentId, true)}
      >
        <Download className="mr-1 h-3 w-3" />
        {t("programUpdate")}
      </Button>
    ) : null
  }

  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-md border px-2 py-1.5",
        ready
          ? "border-border/60 text-muted-foreground"
          : "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400"
      )}
    >
      {run?.running ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
      ) : !ready ? (
        <AlertTriangle className="size-3.5 shrink-0" />
      ) : null}
      <span className="min-w-0 flex-1 truncate" title={run?.error ?? message}>
        {run?.error && !run.running ? run.error : message}
      </span>
      {run?.running ? null : action}
    </div>
  )
}

/** 选中 Agent 的启动表单：程序提示 + 启动栏参数 + 启动按钮。 */
export function AgentLaunchForm({
  agentId,
  workingDirectory,
  folderId,
  expert,
  onClose,
}: {
  agentId: string
  workingDirectory: string
  folderId?: number | null
  /** 预选的专家（启动栏 `optionsFrom: "experts"` 那一项）。 */
  expert?: string | null
  onClose: () => void
}) {
  return (
    <div data-agent-launch-view className="flex flex-col gap-3">
      <AgentProgramNotice agentId={agentId} />
      <AgentLaunchShelfContent
        agentId={agentId}
        workingDirectory={workingDirectory}
        folderId={folderId}
        expert={expert}
        onClose={onClose}
      />
    </div>
  )
}

/**
 * 群组 tab 栏右侧的「+」：先选 Agent，再在同一弹层里填启动栏启动；最后一项新建普通终端。
 * 其他入口经 `openLaunchShelf` 打开同一个弹层，带了 Agent 就直接到表单。
 */
export function AgentLaunchMenu() {
  const t = useTranslations("Folder.auxPanel")
  const tSessions = useTranslations("Folder.projectSessions")
  const tTerminal = useTranslations("Folder.terminal")
  const open = useStatusBarLaunchStore((s) => s.launchOpen)
  const agentId = useStatusBarLaunchStore((s) => s.activeLaunchAgentId)
  const preset = useStatusBarLaunchStore((s) => s.launchPreset)
  const usage = useStatusBarLaunchStore((s) =>
    s.usageStates?.find((u) => u.subject === s.activeLaunchAgentId)
  )
  const { openLaunchShelf, closeLaunchShelf, setActiveLaunchAgentId } =
    useStatusBarLaunchStore.getState()
  const { agents } = useAgentProfiles()
  const { trackTrigger, content: paneContent } = usePaneBoundary()
  const { activeFolder } = useActiveFolder()

  return (
    <Popover
      open={open}
      onOpenChange={(next) => (next ? openLaunchShelf() : closeLaunchShelf())}
    >
      <PopoverTrigger asChild>
        <button
          ref={trackTrigger}
          type="button"
          data-agent-launch-trigger
          className={TAB_TOOLBAR_BUTTON}
          title={t("launch")}
          aria-label={t("launch")}
        >
          <Plus className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...paneContent}
        className={cn("w-80 p-0 text-xs", PANE_POPOVER_FIT)}
      >
        {agentId ? (
          <div className="flex max-h-[70vh] min-h-0 flex-col gap-3 overflow-y-auto p-3">
            <div className="flex items-center gap-2">
              <AgentLaunchHeader
                agentId={agentId}
                name={agents.find((a) => a.id === agentId)?.name ?? agentId}
                usageState={usage}
                onBack={() => setActiveLaunchAgentId(null)}
              />
            </div>
            <AgentLaunchForm
              key={agentId}
              agentId={agentId}
              workingDirectory={
                preset?.workingDirectory ?? activeFolder?.path ?? ""
              }
              folderId={preset?.folderId ?? activeFolder?.id ?? null}
              expert={preset?.expert ?? null}
              onClose={closeLaunchShelf}
            />
          </div>
        ) : (
          <div role="menu" aria-label={t("launch")} className="p-1">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                role="menuitem"
                data-agent-id={agent.id}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] hover:bg-accent"
                onClick={() => setActiveLaunchAgentId(agent.id)}
              >
                <AgentProfileIcon
                  agentId={agent.id}
                  name={agent.name}
                  className="size-4"
                  fallback={
                    <AgentIcon agentType={agent.id} className="size-4" />
                  }
                />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              </button>
            ))}
            <div role="separator" className="-mx-1 my-1 h-px bg-border" />
            <button
              type="button"
              role="menuitem"
              disabled={!activeFolder}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              onClick={() => {
                if (!activeFolder) return
                closeLaunchShelf()
                void createAndOpenFolderTerminal(
                  { cwd: activeFolder.path, folderId: activeFolder.id },
                  tTerminal
                )
              }}
            >
              <ColorTerminalIcon className="size-4" />
              <span className="min-w-0 flex-1 truncate">
                {tSessions("newTerminal")}
              </span>
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** 启动表单顶部：返回 Agent 列表、Agent 图标与名称、用量。 */
export function AgentLaunchHeader({
  agentId,
  name,
  usageState,
  onBack,
}: {
  agentId: string
  name: string
  usageState?: UsageState | null
  onBack: () => void
}) {
  const t = useTranslations("Folder.auxPanel")
  const usageWindows = (usageState?.windows ?? []).filter(
    (w) => typeof w.usedPercent === "number"
  )
  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={t("launchBack")}
        title={t("launchBack")}
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-secondary/50">
        <AgentProfileIcon
          agentId={agentId}
          name={name}
          className="size-3.5"
          fallback={<AgentIcon agentType={agentId} className="size-3.5" />}
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold">
        {name}
      </span>
      {usageWindows.map((w, idx) => (
        <span
          key={w.id || idx}
          className="flex shrink-0 items-baseline gap-1 tabular-nums text-[11px]"
        >
          {w.label && <span className="text-muted-foreground">{w.label}</span>}
          <span
            className={cn(
              "font-medium",
              usageTextColorClass(w.usedPercent as number)
            )}
          >
            {w.usedPercent}%
          </span>
        </span>
      ))}
    </>
  )
}
