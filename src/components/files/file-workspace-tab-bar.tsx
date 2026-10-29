"use client"

import { useState, type ReactNode } from "react"
import { Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useSettingsWorkspace } from "@/contexts/settings-workspace-context"
import { useWorkspaceLayoutProjection } from "@/hooks/workspace/use-workspace-layout"
import { WorkspaceTabShell } from "@/components/tabs/workspace-tab-shell"
import {
  PANE_POPOVER_FIT,
  TAB_TOOLBAR_BUTTON,
  usePaneBoundary,
  WorkspaceTabStrip,
} from "@/components/tabs/workspace-tab-strip"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { createFileTreeEntry } from "@/lib/api"
import { createUniqueRootFile } from "@/lib/files/create-drawing-file"
import { toErrorMessage } from "@/lib/app-error"
import { toast } from "@/lib/notify"
import { workspaceTabKey } from "@/lib/workspace/workspace-tab-placement"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"
import { cn } from "@/lib/utils"

// Desktop main-workspace tab strip. Settings is a mode entered from the
// activity bar, not a tab here.
export function FileWorkspaceTabBar() {
  const { activeTabByPane } = useWorkspaceLayoutProjection()
  const { isActive: settingsActive, closeSettings } = useSettingsWorkspace()
  const tHome = useTranslations("ProjectHome")
  const homeOver = useAppUiStore((state) => state.projectHomeOver)
  const activeKey = activeTabByPane.files
    ? workspaceTabKey(activeTabByPane.files)
    : ""
  const homeShown =
    !settingsActive && (activeKey === "" || homeOver === activeKey)
  // 软件图标：随时叫出 / 收起项目首页（没有 tab 时首页本来就在）；在设置里点它先退出设置。
  const showHome = () => {
    if (settingsActive) {
      closeSettings()
      const files = useWorkspaceLayoutStore.getState().activeTabByPane.files
      useAppUiStore.setState({
        projectHomeOver: files ? workspaceTabKey(files) : null,
      })
      return
    }
    if (activeKey === "") return
    useAppUiStore.setState({ projectHomeOver: homeShown ? null : activeKey })
  }
  // 与 Agent tab 同一外壳的图标 tab，固定在条首；尾部带全部标签菜单与新建文件。
  const homeTab = (tabListMenu: ReactNode) => (
    <div role="tablist" className="flex shrink-0 items-stretch pl-2 pt-1.5">
      <WorkspaceTabShell
        dataAttributes={{ "data-home-tab": "" }}
        fit
        active={homeShown}
        title={tHome("home")}
        ariaLabel={tHome("home")}
        closeLabel=""
        onSelect={showHome}
        icon={
          // eslint-disable-next-line @next/next/no-img-element -- 静态导出，直接引用软件图标
          <img
            src="/icon-32x32.png"
            alt=""
            className={cn(
              "size-4 transition-opacity",
              !homeShown && "opacity-70 group-hover/tab:opacity-100"
            )}
          />
        }
        label={null}
        actions={
          <>
            {tabListMenu}
            <NewFileButton />
          </>
        }
      />
    </div>
  )

  return (
    <WorkspaceTabStrip pane="files" className="w-full" leadingTabs={homeTab} />
  )
}

// 一键新建的预设：空文件即空白笔记 / 空画板
const FILE_PRESETS = [
  { key: "markdown", stem: "untitled", ext: ".md" },
  { key: "excalidrawMd", stem: "drawing", ext: ".excalidraw.md" },
  { key: "excalidraw", stem: "drawing", ext: ".excalidraw" },
] as const

/** 在当前项目根目录新建文件并打开：输入完整文件名，或点预设类型。 */
function NewFileButton() {
  const t = useTranslations("Folder.fileTreeTab")
  const { activeFolder } = useActiveFolder()
  const { openFilePreview } = useWorkspaceRuntimeActions()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)
  const { trackTrigger, content: paneContent } = usePaneBoundary()
  if (!activeFolder) return null

  const create = async (preset?: (typeof FILE_PRESETS)[number]) => {
    const trimmed = name.trim()
    if (!trimmed && !preset) return
    setCreating(true)
    try {
      // 预设：填了名字就用它（去掉重复的后缀），否则用默认名；重名自动加序号
      const path = preset
        ? await createUniqueRootFile(
            activeFolder.path,
            (trimmed.endsWith(preset.ext)
              ? trimmed.slice(0, -preset.ext.length)
              : trimmed) || preset.stem,
            preset.ext
          )
        : await createFileTreeEntry(activeFolder.path, "", trimmed, "file")
      setOpen(false)
      setName("")
      void openFilePreview(path, { folderId: activeFolder.id })
    } catch (error) {
      toast.error(t("toasts.createFailed"), {
        description: toErrorMessage(error),
      })
    } finally {
      setCreating(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={trackTrigger}
          type="button"
          className={TAB_TOOLBAR_BUTTON}
          title={t("createDialog.newFile")}
          aria-label={t("createDialog.newFile")}
        >
          <Plus className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...paneContent}
        className={cn("w-64 p-2", PANE_POPOVER_FIT)}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={creating}
            placeholder={t("createDialog.placeholderFile")}
            aria-label={t("createDialog.newFile")}
          />
        </form>
        <div className="mt-1.5 flex flex-col">
          {FILE_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              disabled={creating}
              title={t("createDialog.presetHint")}
              onClick={() => void create(preset)}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-50"
            >
              <span className="truncate">
                {t(`createDialog.${preset.key}`)}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {preset.ext}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
