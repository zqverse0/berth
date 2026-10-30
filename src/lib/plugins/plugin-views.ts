import { create } from "zustand"
import { getTransport } from "@/lib/transport"

/**
 * 插件视图（docs/plugin-architecture.md §4.1 第 1 层）：插件脚本返回视图数据，宿主原生渲染。
 * 视图数据的类型与 `plugins/berth-plugin.d.ts` 的 `ViewResult` 一致；插件给的数据不可信，渲染时逐项容错。
 */

/** 启用插件声明的一个视图。 */
export type PluginView = {
  plugin: string
  id: string
  /** 字符串或 `{ "<语言>": "<标题>" }`。 */
  title: string | Record<string, string>
  /** data URL。 */
  icon?: string | null
  location: "sidebar" | "tab"
}

/** 宿主的固定图标名（§4.1，只增不改）；图标组件在视图面板里对应。 */
export const VIEW_ICONS = [
  "star",
  "star-filled",
  "fork",
  "external-link",
  "copy",
  "book",
  "download",
  "folder-input",
  "link",
  "send",
] as const
export type ViewIcon = (typeof VIEW_ICONS)[number]

type ActionBase = {
  title: string
  icon?: ViewIcon
  inline?: "hover" | "always"
}

export type ViewAction = ActionBase &
  (
    | { type: "open-url"; url: string }
    | { type: "open-view"; view: string; params?: Record<string, string> }
    | { type: "script"; script: string; input?: unknown; refresh?: boolean }
    | { type: "copy"; text: string }
    | { type: "clone"; url: string; pickDirectory?: boolean }
    | { type: "send-to-agent"; text: string }
  )

export type Accessory = { text: string; icon?: ViewIcon; tooltip?: string }

export type ListItem = {
  id: string
  title: string
  subtitle?: string
  icon?: string
  accessories?: Accessory[]
  actions?: ViewAction[]
}

type Choice = { id: string; title: string }

export type ListView = {
  type: "list"
  filters?: Choice[]
  dropdown?: { items: Choice[] }
  note?: string
  searchable?: boolean
  items: ListItem[]
  empty?: string
}

export type DetailView = {
  type: "detail"
  title?: string
  markdown: string
  actions?: ViewAction[]
}

export type ViewResult = ListView | DetailView

type Project = { id: string; name: string; root: string } | null

type Request =
  | { type: "list" }
  | {
      type: "render"
      plugin: string
      view: string
      params: Record<string, string>
      filter: string | null
      dropdown: string | null
      locale: string
      refresh: boolean
      project: Project
    }
  | {
      type: "action"
      plugin: string
      script: string
      input: unknown
      project: Project
    }

type Response =
  | { type: "list"; views: PluginView[] }
  | { type: "rendered"; view: unknown }
  | { type: "done"; result: unknown }

function pluginViews(request: Request): Promise<Response> {
  return getTransport().call<Response>("plugin_views", { request })
}

export async function renderPluginView(options: {
  plugin: string
  view: string
  params?: Record<string, string>
  filter: string | null
  dropdown?: string | null
  locale: string
  refresh?: boolean
  project: Project
}): Promise<ViewResult> {
  const response = await pluginViews({
    type: "render",
    params: {},
    dropdown: null,
    refresh: false,
    ...options,
  })
  if (response.type !== "rendered") throw new Error("unexpected response")
  return normalizeView(response.view)
}

export async function runPluginAction(options: {
  plugin: string
  script: string
  input: unknown
  project: Project
}): Promise<void> {
  await pluginViews({ type: "action", ...options })
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined

const iconOf = (value: unknown): ViewIcon | undefined =>
  VIEW_ICONS.find((icon) => icon === value)

const choicesOf = (value: unknown): Choice[] =>
  Array.isArray(value)
    ? value.flatMap((choice) => {
        const id = text(choice?.id)
        const title = text(choice?.title)
        return id && title ? [{ id, title }] : []
      })
    : []

function actionOf(value: unknown): ViewAction | null {
  if (!value || typeof value !== "object") return null
  const action = value as Record<string, unknown>
  const title = text(action.title)
  if (!title) return null
  const base: ActionBase = {
    title,
    icon: iconOf(action.icon),
    inline:
      action.inline === "hover" || action.inline === "always"
        ? action.inline
        : undefined,
  }
  switch (action.type) {
    case "open-url":
      return /^https?:\/\//.test(String(action.url ?? ""))
        ? { ...base, type: "open-url", url: String(action.url) }
        : null
    case "open-view": {
      const view = text(action.view)
      const params =
        action.params && typeof action.params === "object"
          ? Object.fromEntries(
              Object.entries(action.params).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string"
              )
            )
          : undefined
      return view ? { ...base, type: "open-view", view, params } : null
    }
    case "script": {
      const script = text(action.script)
      return script
        ? {
            ...base,
            type: "script",
            script,
            input: action.input,
            refresh: action.refresh === true,
          }
        : null
    }
    case "copy":
      return typeof action.text === "string"
        ? { ...base, type: "copy", text: action.text }
        : null
    case "clone":
      return /^(https?:\/\/|git@)/.test(String(action.url ?? ""))
        ? {
            ...base,
            type: "clone",
            url: String(action.url),
            pickDirectory: action.pickDirectory === true,
          }
        : null
    case "send-to-agent":
      return text(action.text)
        ? { ...base, type: "send-to-agent", text: String(action.text) }
        : null
    default:
      return null
  }
}

const actionsOf = (value: unknown): ViewAction[] =>
  Array.isArray(value) ? value.flatMap((action) => actionOf(action) ?? []) : []

/** 插件返回值 → 宿主认识的视图；不认识的条目、动作丢掉，视图类型不认识就报错。 */
export function normalizeView(value: unknown): ViewResult {
  const view = (value ?? {}) as Record<string, unknown>
  if (view.type === "detail") {
    return {
      type: "detail",
      title: text(view.title),
      markdown: typeof view.markdown === "string" ? view.markdown : "",
      actions: actionsOf(view.actions),
    }
  }
  if (view.type !== "list") {
    throw new Error(`unsupported view type: ${String(view.type)}`)
  }
  const dropdown = choicesOf(
    (view.dropdown as Record<string, unknown> | undefined)?.items
  )
  const items = Array.isArray(view.items)
    ? view.items.flatMap((raw): ListItem[] => {
        const item = (raw ?? {}) as Record<string, unknown>
        const id = text(item.id)
        const title = text(item.title)
        if (!id || !title) return []
        const accessories = Array.isArray(item.accessories)
          ? item.accessories.flatMap((accessory) =>
              text(accessory?.text)
                ? [
                    {
                      text: accessory.text,
                      icon: iconOf(accessory.icon),
                      tooltip: text(accessory.tooltip),
                    },
                  ]
                : []
            )
          : []
        return [
          {
            id,
            title,
            subtitle: text(item.subtitle),
            icon: text(item.icon),
            accessories,
            actions: actionsOf(item.actions),
          },
        ]
      })
    : []
  return {
    type: "list",
    filters: choicesOf(view.filters),
    dropdown: dropdown.length ? { items: dropdown } : undefined,
    note: text(view.note),
    searchable: view.searchable === true,
    items,
    empty: text(view.empty),
  }
}

/** 标题按当前语言挑，缺了取 `en`，再缺取第一个。 */
export function localizedTitle(
  title: PluginView["title"],
  locale: string
): string {
  if (typeof title === "string") return title
  return title[locale] ?? title.en ?? Object.values(title)[0] ?? ""
}

/**
 * 上次的渲染结果，按「插件 / 视图 / 筛选 / 下拉 / 参数」记：切回时先显示它，后台再重新渲染。
 * ponytail: 无上限，条目数 = 用户实际切过的组合数；插件多了再加 LRU。
 */
export const renderCache = new Map<string, ViewResult>()

export const pluginSidebarViewId = (view: { plugin: string; id: string }) =>
  `plugin:${view.plugin}/${view.id}` as const

/** 启用插件的视图列表；进入应用与离开设置（可能刚启停插件）时刷新。 */
export const usePluginViewsStore = create<{
  views: PluginView[]
  load: () => Promise<void>
}>((set) => ({
  views: [],
  load: async () => {
    try {
      const response = await pluginViews({ type: "list" })
      if (response.type === "list") set({ views: response.views })
    } catch {
      // 非桌面环境或命令不可用：没有插件视图。
      set({ views: [] })
    }
  },
}))
