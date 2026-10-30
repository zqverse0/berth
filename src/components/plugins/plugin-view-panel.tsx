"use client"

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  BookOpen,
  Copy,
  Download,
  ExternalLink,
  FolderInput,
  GitFork,
  Link,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Send,
  Star,
} from "lucide-react"
import { Virtualizer } from "virtua"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  SidebarHeaderActions,
  SidebarHeaderButton,
  SidebarHeaderTabs,
} from "@/components/layout/sidebar/sidebar-header"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useRepoClone } from "@/hooks/use-repo-clone"
import { useSendToAgent } from "@/hooks/use-send-to-agent"
import { toErrorMessage } from "@/lib/app-error"
import { toast } from "@/lib/notify"
import { openUrl } from "@/lib/platform"
import { copyTextFromMenu, cn } from "@/lib/utils"
import {
  renderCache,
  renderPluginView,
  runPluginAction,
  type ListItem,
  type ViewAction,
  type ViewIcon,
  type ViewResult,
} from "@/lib/plugins/plugin-views"

/** 插件可用的图标名 → 宿主图标（`star-filled` 是已加星的琥珀色实心星）。 */
const ICONS: Record<ViewIcon, ComponentType<{ className?: string }>> = {
  star: Star,
  "star-filled": ({ className }) => (
    <Star className={cn(className, "fill-amber-400 text-amber-400")} />
  ),
  fork: GitFork,
  "external-link": ExternalLink,
  copy: Copy,
  book: BookOpen,
  download: Download,
  "folder-input": FolderInput,
  link: Link,
  send: Send,
}

function ViewIconGlyph({
  icon,
  className,
}: {
  icon?: ViewIcon
  className: string
}) {
  const Icon = icon ? ICONS[icon] : null
  return Icon ? <Icon className={className} /> : null
}

/**
 * 插件视图（第 1 层）的侧栏正文：运行插件的 `render` 拿视图数据，用侧栏自己的组件画。
 * 筛选项进顶栏 tab，刷新进顶栏按钮，下拉在正文顶部，列表行与内置列表同一套样式；插件只给数据与动作。
 * 切回看过的组合时先显示上次结果（`renderCache`），后台重新渲染。
 */
export function PluginViewPanel({
  plugin,
  view,
}: {
  plugin: string
  view: string
}) {
  const t = useTranslations("PluginViews")
  const locale = useLocale()
  const project = useProject()
  const {
    run: runAction,
    describe,
    dialog: actionDialog,
  } = usePluginActionRunner(plugin)
  const [filter, setFilter] = useState<string | null>(null)
  const [dropdown, setDropdown] = useState<string | null>(null)
  const cacheKey = `${plugin}/${view}|${filter ?? ""}|${dropdown ?? ""}`
  const [result, setResult] = useState<ViewResult | null>(
    () => renderCache.get(cacheKey) ?? null
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  // 每次变化重新渲染；`refresh` 为真表示用户点了刷新（插件绕过缓存），动作后的重渲染不绕过。
  const [revision, setRevision] = useState({ count: 0, refresh: false })
  // 等待下一次渲染完成的动作（`rerender` 返回的 Promise）。
  const settlers = useRef<(() => void)[]>([])
  // 长列表虚拟化（与内置星标列表同一做法），只挂可见的行。
  const viewportRef = useRef<HTMLElement | null>(null)
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null)
  const handleViewportRef = useCallback((element: HTMLElement | null) => {
    viewportRef.current = element
    setViewportEl(element)
  }, [])

  useEffect(() => {
    let cancelled = false
    // 没看过这个组合就显示加载态，不拿别的筛选的结果顶替。
    setResult(renderCache.get(cacheKey) ?? null)
    setLoading(true)
    renderPluginView({
      plugin,
      view,
      filter,
      dropdown,
      locale,
      refresh: revision.refresh,
      project,
    })
      .then((next) => {
        renderCache.set(cacheKey, next)
        if (cancelled) return
        setResult(next)
        setError(null)
      })
      .catch((err) => {
        if (!cancelled) setError(toErrorMessage(err))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
        // 等这次渲染的动作（如加星）到此才算完成，按钮的转圈一直持续到新结果出来。
        for (const settle of settlers.current.splice(0)) settle()
      })
    return () => {
      cancelled = true
    }
    // project 按 id 比较，避免每次渲染新对象触发重拉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, locale, project?.id, revision])

  const refresh = useCallback(
    () => setRevision((value) => ({ count: value.count + 1, refresh: true })),
    []
  )
  const rerender = useCallback(
    () =>
      new Promise<void>((resolve) => {
        settlers.current.push(resolve)
        setRevision((value) => ({ count: value.count + 1, refresh: false }))
      }),
    []
  )

  const list = result?.type === "list" ? result : null
  const items = useMemo(() => {
    if (!list) return []
    const needle = query.trim().toLowerCase()
    if (!list.searchable || !needle) return list.items
    return list.items.filter((item) =>
      `${item.title}\n${item.subtitle ?? ""}`.toLowerCase().includes(needle)
    )
  }, [list, query])

  const onAction = useCallback(
    (action: ViewAction) => runAction(action, rerender),
    [runAction, rerender]
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {list?.filters?.length ? (
        <SidebarHeaderTabs
          tabs={list.filters.map((item) => ({
            id: item.id,
            label: item.title,
          }))}
          // 没选过筛选时插件按第一个渲染。
          value={filter ?? list.filters[0].id}
          onChange={setFilter}
        />
      ) : null}
      <SidebarHeaderActions>
        <SidebarHeaderButton
          icon={RefreshCw}
          label={t("refresh")}
          onClick={refresh}
          disabled={loading}
          spinning={loading}
        />
      </SidebarHeaderActions>

      {list?.dropdown || list?.note ? (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          {list.dropdown ? (
            <Select
              value={dropdown ?? list.dropdown.items[0].id}
              onValueChange={setDropdown}
            >
              <SelectTrigger className="w-auto" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {list.dropdown.items.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {list.note ? (
            <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {list.note}
            </p>
          ) : null}
        </div>
      ) : null}

      {list?.searchable ? (
        <div className="shrink-0 border-b px-3 py-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("search")}
            className="h-8"
          />
        </div>
      ) : null}

      {error && (
        <div className="mx-3 mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="min-w-0 break-words whitespace-pre-wrap">
            {error}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={refresh}
            disabled={loading}
          >
            {t("retry")}
          </Button>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1" onViewportRef={handleViewportRef}>
        {loading && !result ? (
          <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("loading")}
          </div>
        ) : result?.type === "detail" ? (
          <p className="p-3 text-sm whitespace-pre-wrap">{result.markdown}</p>
        ) : list && items.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {list.empty || t("empty")}
          </p>
        ) : viewportEl ? (
          <Virtualizer scrollRef={viewportRef} itemSize={72}>
            {items.map((item) => (
              <PluginListRow
                key={item.id}
                item={item}
                onAction={onAction}
                describe={describe}
              />
            ))}
          </Virtualizer>
        ) : null}
      </ScrollArea>
      {actionDialog}
    </div>
  )
}

/** 列表行：与内置仓库列表同一套样式；带 `inline` 的动作是行尾图标按钮，其余进「…」菜单。 */
const PluginListRow = memo(function PluginListRow({
  item,
  onAction,
  describe,
}: {
  item: ListItem
  onAction: (action: ViewAction) => Promise<void>
  describe: (action: ViewAction) => string
}) {
  const t = useTranslations("PluginViews")
  const [pending, setPending] = useState<ViewAction | null>(null)
  const [primary, ...rest] = item.actions ?? []
  const inline = rest.filter((action) => action.inline)
  const menu = rest.filter((action) => !action.inline)
  const run = (action: ViewAction) => {
    setPending(action)
    void onAction(action).finally(() => setPending(null))
  }
  // 悬停或键盘聚焦时才显示的次要操作
  const reveal =
    "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"

  return (
    <div className="group flex items-start gap-0.5 pr-1.5 transition-colors hover:bg-muted/40">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2 py-2 pl-3 text-left disabled:cursor-default"
        onClick={() => primary && run(primary)}
        disabled={!primary}
        title={primary?.title}
      >
        {item.icon && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.icon}
            alt=""
            loading="lazy"
            decoding="async"
            className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-muted"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {item.title}
          </span>
          {item.subtitle && (
            <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {item.subtitle}
            </span>
          )}
          {item.accessories?.length ? (
            <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              {item.accessories.map((accessory, index) => (
                <span
                  key={index}
                  className="inline-flex items-center gap-0.5"
                  title={accessory.tooltip}
                >
                  <ViewIconGlyph icon={accessory.icon} className="h-3 w-3" />
                  {accessory.text}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </button>

      {inline.map((action, index) => (
        <Button
          key={index}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`${action.title}: ${item.title}`}
          title={describe(action)}
          onClick={() => run(action)}
          disabled={pending === action}
          className={cn(
            "mt-1.5 h-7 w-7 shrink-0 text-muted-foreground",
            action.inline === "hover" && pending !== action && reveal
          )}
        >
          {pending === action ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ViewIconGlyph
              icon={action.icon ?? "external-link"}
              className="h-4 w-4"
            />
          )}
        </Button>
      ))}

      {menu.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`${t("more")}: ${item.title}`}
              className={cn(
                "mt-1.5 h-7 w-7 shrink-0 text-muted-foreground",
                reveal
              )}
            >
              {pending && menu.includes(pending) ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <MoreHorizontal className="h-3.5 w-3.5" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {menu.map((action, index) => (
              <DropdownMenuItem key={index} onSelect={() => run(action)}>
                <ViewIconGlyph icon={action.icon} className="size-4" />
                {describe(action)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
})

function useProject() {
  const { activeFolder } = useActiveFolder()
  return useMemo(
    () =>
      activeFolder
        ? {
            id: String(activeFolder.id),
            name: activeFolder.name,
            root: activeFolder.path,
          }
        : null,
    [activeFolder]
  )
}

/**
 * 执行视图动作；`open-view` 的 detail 在只读 Markdown 标签页打开，`clone` / `send-to-agent` 走宿主现成的流程。
 * `describe` 给动作的提示文字（clone 带上要克隆到的目录），`dialog` 是选目录对话框（非桌面端用），需挂在面板里。
 */
function usePluginActionRunner(plugin: string) {
  const t = useTranslations("PluginViews")
  const tClone = useTranslations("RepoClone")
  const workspace = useWorkspaceRuntimeActions()
  const locale = useLocale()
  const project = useProject()
  const { targetDir, clone, dialog } = useRepoClone()
  // 「发给 Agent」的文字由宿主给（带上当前 Agent 名），插件的 title 只作兜底。
  const { label: sendLabel, send: sendText } = useSendToAgent()
  const describe = useCallback(
    (action: ViewAction) =>
      action.type === "clone" && !action.pickDirectory
        ? targetDir
          ? tClone("cloneInto", {
              dir: targetDir.replace(/^\/home\/[^/]+/, "~"),
            })
          : tClone("clonePickDir")
        : action.type === "send-to-agent"
          ? sendLabel
          : action.title,
    [targetDir, tClone, sendLabel]
  )
  const run = useCallback(
    async (action: ViewAction, rerender: () => Promise<void>) => {
      try {
        switch (action.type) {
          case "open-url":
            await openUrl(action.url)
            return
          case "clone":
            await clone(action.url, { pickDirectory: action.pickDirectory })
            return
          case "send-to-agent":
            await sendText(action.text)
            return
          case "copy":
            await copyTextFromMenu(action.text)
            return
          case "script":
            await runPluginAction({
              plugin,
              script: action.script,
              input: action.input ?? null,
              project,
            })
            if (action.refresh) await rerender()
            return
          case "open-view": {
            const params = action.params ?? {}
            const id = `plugin-view:${plugin}/${action.view}?${new URLSearchParams(params)}`
            const open = (title: string, content: string) =>
              workspace.openReadonlyTextPreview({
                id,
                title,
                path: `${action.view}.md`,
                content,
                lifetime: "global",
              })
            open(action.title, t("loading"))
            const result = await renderPluginView({
              plugin,
              view: action.view,
              params,
              filter: null,
              locale,
              project,
            }).catch((err) => {
              open(action.title, t("failed", { error: toErrorMessage(err) }))
              throw err
            })
            if (result.type !== "detail") {
              open(action.title, t("tabNeedsDetail"))
              return
            }
            open(result.title ?? action.title, result.markdown)
            return
          }
        }
      } catch (err) {
        toast.error(toErrorMessage(err))
      }
    },
    [plugin, project, workspace, t, locale, clone, sendText]
  )
  return { run, describe, dialog }
}
