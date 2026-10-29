import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import {
  Check,
  ChevronDown,
  Cpu,
  Eye,
  Lock,
  MessagesSquare,
  Search,
  Server,
  Shield,
  SlidersHorizontal,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { useScrollbarSafeDismiss } from "@/hooks/use-scrollbar-safe-dismiss"
import { cn } from "@/lib/utils"
import { isLaunchbarOptionSource, sanitizeLaunchbarProtocols } from "./format"
import type { LaunchbarConfig, LaunchbarItem } from "./types"

/** 注册表分发给每个组件的统一 props：item 即文件里的配置项。 */
export interface LaunchbarComponentProps {
  item: LaunchbarItem
  value: string | null
  onChange: (value: string) => void
  /** 查看动态选项对应的只读内容；空值选项不展示。 */
  onInspect?: (value: string) => void
  /** 选项列表在原位展开（融入侧栏），而不是浮层弹出。 */
  inline?: boolean
}

/** 白名单注册表：launchbar.json 的 `component` 字段 → React 组件。
 *
 * agent 只能引用这里列出的组件；文件里出现未注册的 component 时该项
 * 被跳过并产生诊断（见 validateLaunchbarConfig），不会渲染任意内容。
 */
export const LAUNCHBAR_COMPONENTS: Record<
  string,
  ComponentType<LaunchbarComponentProps>
> = {
  select: LaunchbarSelect,
  input: LaunchbarInput,
  switch: LaunchbarSwitch,
}

function renderLaunchbarItemIcon(item: LaunchbarItem) {
  const className = "size-3.5 shrink-0 text-muted-foreground"
  if (item.optionsFrom === "providerVendor" || item.id === "provider") {
    return <Server className={className} />
  }
  if (item.optionsFrom === "providerModels" || item.id === "model") {
    return <Cpu className={className} />
  }
  if (item.optionsFrom === "experts" || item.id === "expert") {
    return <SlidersHorizontal className={className} />
  }
  if (item.optionsFrom === "projectSessions") {
    return <MessagesSquare className={className} />
  }
  if (item.id.includes("mode") || item.id.includes("permission")) {
    return <Shield className={className} />
  }
  if (item.id.includes("sandbox")) {
    return <Lock className={className} />
  }
  return <SlidersHorizontal className={className} />
}

function useLaunchbarTranslations() {
  try {
    const t = useTranslations("Folder.projectSessions")
    return {
      search: t("launchbarSearch"),
      noMatches: t("launchbarNoMatches"),
      view: t("launchbarViewSession"),
    }
  } catch {
    return {
      search: "Search options…",
      noMatches: "No matching options",
      view: "View",
    }
  }
}

export function LaunchbarSelect({
  item,
  value,
  onChange,
  onInspect,
  inline = false,
}: LaunchbarComponentProps) {
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const listId = useId()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { contentRef, onPointerDownOutside, onFocusOutside } =
    useScrollbarSafeDismiss()
  const {
    search: searchPlaceholder,
    noMatches: noMatchesText,
    view: viewLabel,
  } = useLaunchbarTranslations()
  const canInspect = typeof onInspect === "function"

  const options = useMemo(() => item.options ?? [], [item.options])
  const selectedOption = useMemo(
    () => options.find((opt) => opt.value === value) ?? null,
    [options, value]
  )

  const filteredOptions = useMemo(() => {
    if (!searchQuery.trim()) return options
    const q = searchQuery.toLowerCase().trim()
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(q) ||
        opt.value.toLowerCase().includes(q)
    )
  }, [options, searchQuery])

  const showSearch = options.length > 5

  const parseOptionLabel = useCallback((label: string) => {
    const dotIndex = label.indexOf(" · ")
    if (dotIndex >= 0) {
      return {
        primary: label.slice(0, dotIndex),
        secondary: label.slice(dotIndex + 3),
      }
    }
    return { primary: label, secondary: null }
  }, [])

  const displayLabel = useMemo(() => {
    if (selectedOption) {
      return parseOptionLabel(selectedOption.label).primary
    }
    return item.label
  }, [selectedOption, item.label, parseOptionLabel])

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      const selectedIdx = options.findIndex((opt) => opt.value === value)
      setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0)
    } else {
      setSearchQuery("")
    }
  }

  useEffect(() => {
    if (inline && open && showSearch) searchInputRef.current?.focus()
  }, [inline, open, showSearch])

  useEffect(() => {
    if (!open) return
    const activeEl = listRef.current?.querySelector(
      `[data-index="${activeIndex}"]`
    ) as HTMLElement | null
    activeEl?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, open])

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((prev) =>
        prev < filteredOptions.length - 1 ? prev + 1 : 0
      )
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((prev) =>
        prev > 0 ? prev - 1 : filteredOptions.length - 1
      )
    } else if (e.key === "Enter") {
      e.preventDefault()
      const target = filteredOptions[activeIndex]
      if (target) {
        onChange(target.value)
        setOpen(false)
      }
    } else if (e.key === "Escape") {
      e.preventDefault()
      setOpen(false)
    }
  }

  const trigger = (
    <button
      type="button"
      role="combobox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-haspopup="listbox"
      aria-label={item.label}
      onClick={inline ? () => handleOpenChange(!open) : undefined}
      title={
        selectedOption ? `${item.label}: ${selectedOption.label}` : item.label
      }
      className={cn(
        "flex h-6.5 max-w-56 items-center gap-1.5 rounded-md border px-2 text-xs font-normal transition-colors select-none",
        "border-border/40 bg-muted/60 text-foreground hover:border-border/60 hover:bg-muted shadow-none",
        open && "border-border/80 bg-muted text-foreground ring-1 ring-ring/30"
      )}
    >
      {renderLaunchbarItemIcon(item)}
      <span
        className={cn(
          "min-w-0 truncate",
          !selectedOption && "text-muted-foreground"
        )}
      >
        {displayLabel}
      </span>
      <ChevronDown
        className={cn(
          "size-3 shrink-0 text-muted-foreground/80 transition-transform duration-150",
          inline && "ml-auto",
          open && "rotate-180 text-foreground"
        )}
      />
    </button>
  )
  const panel = (
    <>
      {showSearch ? (
        <div className="flex items-center gap-2 border-b border-border/40 px-2.5 py-1.5 text-muted-foreground">
          <Search className="size-3.5 shrink-0 opacity-70" strokeWidth={1.75} />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
            onChange={(e) => {
              setSearchQuery(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleKeyDown}
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => {
                setSearchQuery("")
                setActiveIndex(0)
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={item.label}
        tabIndex={showSearch ? -1 : 0}
        onKeyDown={handleKeyDown}
        className="flex max-h-56 flex-col gap-0.5 overflow-y-auto overscroll-contain p-1 outline-hidden"
      >
        {filteredOptions.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            {noMatchesText}
          </div>
        ) : (
          filteredOptions.map((option, index) => {
            const isSelected = option.value === value
            const isHighlighted = index === activeIndex
            const { primary, secondary } = parseOptionLabel(option.label)
            const showInspect = canInspect && option.value !== ""
            return (
              <div
                key={option.value || "__new__"}
                data-index={index}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  "flex w-full items-center gap-0.5 rounded-lg",
                  isSelected
                    ? "bg-accent font-medium text-accent-foreground"
                    : isHighlighted
                      ? "bg-accent/50 text-accent-foreground"
                      : "text-foreground hover:bg-accent/40 hover:text-accent-foreground"
                )}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                  className="flex min-w-0 flex-1 items-center justify-between gap-2.5 px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer select-none"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate leading-5">{primary}</span>
                    {secondary && (
                      <span className="truncate text-[10px] leading-3 text-muted-foreground">
                        {secondary}
                      </span>
                    )}
                  </div>
                  {isSelected && (
                    <Check
                      className="size-3.5 shrink-0 text-primary"
                      strokeWidth={2}
                    />
                  )}
                </button>
                {showInspect ? (
                  <button
                    type="button"
                    aria-label={viewLabel}
                    title={viewLabel}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onChange(option.value)
                      onInspect(option.value)
                      setOpen(false)
                    }}
                    className="mr-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-background/60 hover:text-foreground"
                  >
                    <Eye className="size-3.5" strokeWidth={2} />
                  </button>
                ) : null}
              </div>
            )
          })
        )}
      </div>
    </>
  )

  if (inline) {
    return (
      <div className="flex flex-col gap-1">
        {trigger}
        {open ? (
          <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/30">
            {panel}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onOpenAutoFocus={(e) => {
          if (showSearch) {
            e.preventDefault()
            searchInputRef.current?.focus()
          }
        }}
        onPointerDownOutside={onPointerDownOutside}
        onFocusOutside={onFocusOutside}
        className="w-auto min-w-48 max-w-80 gap-0 overflow-hidden rounded-xl border border-border/60 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-xl outline-hidden"
      >
        {panel}
      </PopoverContent>
    </Popover>
  )
}

function LaunchbarInput({ item, value, onChange }: LaunchbarComponentProps) {
  return (
    <label className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-xs text-muted-foreground">
        {item.label}
      </span>
      <Input
        value={value ?? ""}
        placeholder={item.placeholder ?? item.label}
        onChange={(event) => onChange(event.target.value)}
        className="h-6.5 w-40 rounded-md border-border/40 bg-muted/60 text-xs hover:border-border/60 focus-visible:border-border/80"
      />
    </label>
  )
}

function LaunchbarSwitch({ item, value, onChange }: LaunchbarComponentProps) {
  const checked = value === "true"
  return (
    <span className="flex h-6.5 shrink-0 items-center gap-1.5 rounded-md border border-border/30 bg-muted/40 px-2">
      <Switch
        id={`launchbar-${item.id}`}
        checked={checked}
        onCheckedChange={(next) => onChange(next ? "true" : "false")}
        className="scale-90"
      />
      <Label
        htmlFor={`launchbar-${item.id}`}
        className="cursor-pointer text-xs font-normal text-muted-foreground select-none hover:text-foreground"
      >
        {item.label}
      </Label>
    </span>
  )
}

/** 对已解析的 launchbar 配置做渲染前校验：剔除坏项并返回诊断。
 *
 * 每条诊断只针对一个 item，坏项被跳过，其余照常渲染——agent 写坏一个
 * 组件不影响别的项显示。
 */
export function validateLaunchbarConfig(config: LaunchbarConfig): {
  items: LaunchbarItem[]
  diagnostics: { itemId: string; message: string }[]
} {
  const items: LaunchbarItem[] = []
  const diagnostics: { itemId: string; message: string }[] = []
  for (const item of config.items ?? []) {
    if (typeof item.id !== "string" || item.id.length === 0) {
      diagnostics.push({ itemId: "(missing id)", message: "item 缺少 id" })
      continue
    }
    if (!LAUNCHBAR_COMPONENTS[item.component]) {
      diagnostics.push({
        itemId: item.id,
        message: `未知组件 "${item.component}"，可用: ${Object.keys(LAUNCHBAR_COMPONENTS).join(", ")}`,
      })
      continue
    }
    if (
      item.optionsFrom != null &&
      !isLaunchbarOptionSource(item.optionsFrom)
    ) {
      diagnostics.push({
        itemId: item.id,
        message: `未知 optionsFrom "${item.optionsFrom}"`,
      })
      continue
    }
    if (
      item.component === "select" &&
      item.optionsFrom == null &&
      (item.options ?? []).length === 0
    ) {
      diagnostics.push({
        itemId: item.id,
        message: "select 组件缺少 options",
      })
      continue
    }
    const protocols = sanitizeLaunchbarProtocols(item.protocols)
    items.push(
      protocols.length > 0 || item.protocols != null
        ? { ...item, protocols }
        : item
    )
  }
  return { items, diagnostics }
}

/** 宿主通道：只驱动 Berth 自己的绑定，不进入 `--berth-launch-inputs`。 */
export function isHostChannelLaunchbarItem(item: LaunchbarItem): boolean {
  return item.optionsFrom === "providerVendor"
}

/**
 * 把当前选择收成交给 `launch.js` 的 typed inputs。
 *
 * 空值不提交；`providerVendor` 是宿主通道。字段 id 由 launchbar.json
 * 声明，宿主不做品牌白名单——新静态项不必改 Berth。
 */
export function collectLaunchbarInputs(
  items: readonly LaunchbarItem[],
  values: Readonly<Record<string, string>>
): Record<string, string | boolean> {
  const inputs: Record<string, string | boolean> = {}
  for (const item of items) {
    if (isHostChannelLaunchbarItem(item)) continue
    const value = values[item.id]
    if (value == null || value === "") continue
    if (item.component === "switch") {
      inputs[item.id] = value === "true"
    } else {
      inputs[item.id] = value
    }
  }
  return inputs
}
