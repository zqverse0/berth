"use client"

import { useMemo, useState, type ReactNode } from "react"
import { Plus } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
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
import { createUniqueRootFile } from "@/lib/files/create-unique-root-file"
import { openInPlaceOptions } from "@/lib/files/file-open-target"
import type { WorkspaceFileOpenOptions } from "@/lib/workspace/workspace-runtime"
import { toErrorMessage } from "@/lib/app-error"
import { toast } from "@/lib/notify"
import {
  localizedTitle,
  runPluginAction,
  usePluginViewsStore,
  type PluginEditor,
  type PluginView,
} from "@/lib/plugins/plugin-views"
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

// 一键新建的预设：空文件即空白笔记；插件编辑器的 `new` 接在后面（空文件即空画板等）
const FILE_PRESETS = [
  { key: "markdown", stem: "untitled", ext: ".md" },
] as const

type FilePreset = { key: string; label: string; stem: string; ext: string }

/** 插件编辑器的 `new`：文件名按编辑器后缀切成 stem + ext（`drawing.excalidraw.md`）。 */
function pluginFilePresets(
  editors: readonly PluginEditor[],
  locale: string
): FilePreset[] {
  return editors.flatMap((editor) =>
    editor.new.map((file) => {
      const lower = file.name.toLowerCase()
      const suffix =
        editor.suffixes
          .filter((candidate) => lower.endsWith(candidate))
          .sort((a, b) => b.length - a.length)[0] ??
        (file.name.includes(".") ? file.name.slice(file.name.indexOf(".")) : "")
      return {
        key: `${editor.plugin}/${editor.id}/${file.name}`,
        label: localizedTitle(file.title, locale),
        stem:
          file.name.slice(0, file.name.length - suffix.length) || "untitled",
        ext: file.name.slice(file.name.length - suffix.length),
      }
    })
  )
}

function NewFileMenuRow({
  label,
  ext,
  title,
  disabled,
  onClick,
}: {
  label: string
  ext?: string
  title?: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-50"
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {ext}
      </span>
    </button>
  )
}

/** 在当前项目根目录新建文件并打开：输入完整文件名，或点预设类型。 */
function NewFileButton() {
  const t = useTranslations("Folder.fileTreeTab")
  const { activeFolder } = useActiveFolder()
  const { openFilePreview } = useWorkspaceRuntimeActions()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)
  const { trackTrigger, content: paneContent } = usePaneBoundary()
  const locale = useLocale()
  const editors = usePluginViewsStore((state) => state.editors)
  const views = usePluginViewsStore((state) => state.views)
  const presets = useMemo<FilePreset[]>(
    () => [
      ...FILE_PRESETS.map((preset) => ({
        ...preset,
        label: t(`createDialog.${preset.key}`),
      })),
      ...pluginFilePresets(editors, locale),
    ],
    [editors, locale, t]
  )
  if (!activeFolder) return null

  const createAndOpen = async (
    make: () => Promise<string>,
    options: (path: string) => WorkspaceFileOpenOptions | undefined
  ) => {
    setCreating(true)
    try {
      const path = await make()
      setOpen(false)
      setName("")
      void openFilePreview(path, options(path))
    } catch (error) {
      toast.error(t("toasts.createFailed"), {
        description: toErrorMessage(error),
      })
    } finally {
      setCreating(false)
    }
  }

  const create = (preset?: FilePreset) => {
    const trimmed = name.trim()
    if (!trimmed && !preset) return
    return createAndOpen(
      () =>
        // 预设：填了名字就用它（去掉重复的后缀），否则用默认名；重名自动加序号
        preset
          ? createUniqueRootFile(
              activeFolder.path,
              (trimmed.endsWith(preset.ext)
                ? trimmed.slice(0, -preset.ext.length)
                : trimmed) || preset.stem,
              preset.ext
            )
          : createFileTreeEntry(activeFolder.path, "", trimmed, "file"),
      () => ({ folderId: activeFolder.id })
    )
  }

  // 插件视图的 `new`：文件由插件脚本建（位置、内容它定），可能不在当前项目里
  const createFromPlugin = (
    plugin: string,
    item: NonNullable<PluginView["new"]>[number]
  ) =>
    createAndOpen(
      async () => {
        const result = await runPluginAction({
          plugin,
          script: item.script,
          input: item.input,
          project: {
            id: String(activeFolder.id),
            name: activeFolder.name,
            root: activeFolder.path,
          },
        })
        const path = (result as { path?: unknown } | null)?.path
        if (typeof path !== "string") {
          throw new Error(`${plugin}: ${item.script} returned no path`)
        }
        return path
      },
      (path) => openInPlaceOptions(path, activeFolder.path)
    )

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
          {presets.map((preset) => (
            <NewFileMenuRow
              key={preset.key}
              label={preset.label}
              ext={preset.ext}
              title={t("createDialog.presetHint")}
              disabled={creating}
              onClick={() => void create(preset)}
            />
          ))}
          {views.flatMap((view) =>
            (view.new ?? []).map((item) => (
              <NewFileMenuRow
                key={`${view.plugin}/${view.id}/${item.script}`}
                label={localizedTitle(item.title, locale)}
                ext={
                  editors.find((editor) => editor.plugin === view.plugin)
                    ?.suffixes[0]
                }
                disabled={creating}
                onClick={() => void createFromPlugin(view.plugin, item)}
              />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
