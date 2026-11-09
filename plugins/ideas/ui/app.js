// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// 「想法」侧栏（参考 Memos）：卡片时间线，点开在工作区 tab 的编辑页（editor.js）里看和写正文。
// 后端在 api.js（scripts.run）；讨论与结论由 Agent 写进文件（见包内 usage.md）。

import { h, ideaDate, statusLabel } from "./common.js"

const API = "ui/api.js"
const OPEN = ["待讨论", "讨论中"]

const TEXT = {
  "zh-CN": {
    create: "想到什么，记一笔…",
    untitled: "（空想法）",
    empty: "还没有想法。想到什么就记一笔，之后交给 Agent 一起讨论。",
    disabled: "项目还没启用 Berth：在项目首页点「启用」后再记想法。",
    discuss: "和 Agent 讨论",
    drop: "放下",
    restore: "恢复",
    showArchived: (/** @type {number} */ n) => `已归档（${n}）`,
    hideArchived: "收起已归档",
    discussRequest: (/** @type {string} */ id, /** @type {string} */ path) =>
      `和我讨论想法 ${id}：先运行 \`berth tools show ideas\`，按「处理想法」做（文件 \`${path}\`）。`,
  },
  en: {
    create: "Jot down an idea…",
    untitled: "(empty idea)",
    empty:
      "No ideas yet. Write down whatever comes to mind, then discuss it with an Agent.",
    disabled:
      "Berth is not enabled for this project yet: enable it on the project home first.",
    discuss: "Discuss with an Agent",
    drop: "Drop",
    restore: "Restore",
    showArchived: (/** @type {number} */ n) => `Archived (${n})`,
    hideArchived: "Hide archived",
    discussRequest: (/** @type {string} */ id, /** @type {string} */ path) =>
      `Discuss idea ${id} with me: run \`berth tools show ideas\` and follow 「处理想法」 (file \`${path}\`).`,
  },
}

await berth.ready
const t = berth.ui.locale.startsWith("zh") ? TEXT["zh-CN"] : TEXT.en
/** 页面的全部状态。 */
const model = {
  /** @type {{ main: string, enabled: boolean, ideas: any[] } | null} */
  state: null,
  /** @type {string | null} */ error: null,
  busy: false,
  showArchived: false,
}

const app = /** @type {HTMLElement} */ (document.getElementById("app"))
/** @param {any} input */
const call = (input) => berth.scripts.run(API, input)

async function load() {
  try {
    const next = await call({ action: "list", main: model.state?.main })
    // 多数时候没有变化：不重画，免得闪烁、吞掉正按下的按钮。
    if (!model.error && JSON.stringify(next) === JSON.stringify(model.state)) {
      return
    }
    model.state = next
    model.error = null
  } catch (error) {
    model.error = String(error)
  }
  render()
}

/** @param {() => Promise<void>} action */
async function run(action) {
  model.busy = true
  render()
  try {
    await action()
    model.error = null
  } catch (error) {
    model.error = String(error)
  }
  model.busy = false
  render()
}

/** @param {any} idea */
function replace(idea) {
  const ideas = model.state?.ideas ?? []
  const at = ideas.findIndex((item) => item.id === idea.id)
  if (at >= 0) ideas[at] = idea
}

const create = () =>
  run(async () => {
    const { path } = await call({ action: "create" })
    await berth.files.open(path)
    await load()
  })

/**
 * @param {any} idea
 * @param {string} status
 */
const mark = (idea, status) =>
  run(async () => {
    replace(
      await call({
        action: "setStatus",
        main: model.state?.main,
        id: idea.id,
        status,
      })
    )
  })

/** @param {any} idea */
const discuss = (idea) =>
  run(async () => {
    await berth.agent.attach({
      label: idea.id,
      text: t.discussRequest(idea.id, idea.path),
    })
    if (idea.status === "待讨论") {
      replace(
        await call({
          action: "setStatus",
          main: model.state?.main,
          id: idea.id,
          status: "讨论中",
        })
      )
    }
  })

// ---- 渲染 ----

const relative = new Intl.RelativeTimeFormat(berth.ui.locale, {
  numeric: "auto",
})

/** 一周内说「3 小时前」，更早的写日期。 @param {string} id */
function ideaTime(id) {
  const date = ideaDate(id)
  if (!date) return id
  const minutes = Math.round((date.getTime() - Date.now()) / 60000)
  if (minutes > -60) return relative.format(minutes, "minute")
  if (minutes > -60 * 24)
    return relative.format(Math.round(minutes / 60), "hour")
  if (minutes > -60 * 24 * 7) {
    return relative.format(Math.round(minutes / 60 / 24), "day")
  }
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0")
  return `${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

/** 原话，`#标签` 着色。 @param {string} text */
function ideaText(text) {
  return text
    .split(/(#[\p{L}\p{N}_\-/]+)/u)
    .map((part, index) =>
      index % 2 ? h("span", { class: "tag" }, [part]) : part
    )
}

/**
 * @param {string} label
 * @param {string} icon
 * @param {() => void} onclick
 */
const iconButton = (label, icon, onclick) =>
  h(
    "button",
    {
      class: "icon",
      title: label,
      "aria-label": label,
      disabled: model.busy,
      onclick,
    },
    [icon]
  )

/** @param {any} idea */
function ideaCard(idea) {
  const open = OPEN.includes(idea.status)
  const openFile = () =>
    void berth.files.open(`${model.state?.main}/${idea.path}`)
  return h("li", { class: open ? "card" : "card closed", onclick: openFile }, [
    h("div", { class: "head" }, [
      h("span", {}, [ideaTime(idea.id)]),
      h("span", { class: "status", "data-status": idea.status }, [
        statusLabel(idea.status, berth.ui.locale),
      ]),
      h(
        "span",
        {
          class: "actions",
          onclick: (/** @type {Event} */ e) => e.stopPropagation(),
        },
        [
          open ? iconButton(t.discuss, "💬", () => void discuss(idea)) : null,
          open
            ? iconButton(t.drop, "✕", () => void mark(idea, "已放下"))
            : null,
          idea.status === "已放下"
            ? iconButton(t.restore, "↺", () => void mark(idea, "待讨论"))
            : null,
        ]
      ),
    ]),
    // 卡片整张可点；这个按钮给键盘用
    h(
      "button",
      {
        class: idea.text ? "text" : "text muted",
        onclick: (/** @type {Event} */ e) => {
          e.stopPropagation()
          openFile()
        },
      },
      idea.text ? ideaText(idea.text) : [t.untitled]
    ),
  ])
}

function render() {
  const state = model.state
  app.replaceChildren()
  if (model.error) app.append(h("p", { class: "error" }, [model.error]))
  if (!state) return
  if (!state.enabled) {
    app.append(h("p", { class: "muted center" }, [t.disabled]))
    return
  }

  app.append(
    h("button", { class: "composer", disabled: model.busy, onclick: create }, [
      t.create,
    ])
  )
  const archived = state.ideas.filter((idea) => !OPEN.includes(idea.status))
  const visible = model.showArchived
    ? state.ideas
    : state.ideas.filter((idea) => OPEN.includes(idea.status))
  if (visible.length === 0) {
    app.append(h("p", { class: "muted center" }, [t.empty]))
  }
  app.append(h("ul", {}, visible.map(ideaCard)))
  if (archived.length > 0) {
    app.append(
      h(
        "button",
        {
          class: "toggle",
          onclick: () => {
            model.showArchived = !model.showArchived
            render()
          },
        },
        [model.showArchived ? t.hideArchived : t.showArchived(archived.length)]
      )
    )
  }
}

// 顶层 await 会暂停模块求值：放在最后，render 用到的 const 才都已初始化。
await load()
// 宿主切走侧栏视图时 iframe 只隐藏不卸载：重新可见时重读，可见期间轮询
// （「+」新建、工作区改正文、Agent 写文件都在页面之外）。
// ponytail: 轮询，文件多了卡再换宿主推送文件变更。
let visible = true
new IntersectionObserver(([entry]) => {
  visible = entry.isIntersecting
  if (visible) void load()
}).observe(document.documentElement)
setInterval(() => {
  if (visible && !model.busy) void load()
}, 3000)
