// @ts-check
/// <reference path="../../../berth-plugin.d.ts" />
// 「图库」侧栏：以起手模板为主——新建画板，或带上勾选的附加素材（参考图、风格、提示词）交给 Agent 画。
// 附加素材是用户自己加的可选项：从文件树拖进来入库、写一段要求、移除 / 恢复；勾选状态记在插件存储里。
// 数据经 private/library.js（scripts.run），素材库在插件数据目录，不在插件包里。
// 画好之后的反复修改在Excalidraw 侧栏的「改图」页签里做（private/history.js 存每一版）。

import { copyText } from "../clipboard.js"

const API = "private/library.js"

const TEXT = {
  "zh-CN": {
    kinds: {
      template: "模板",
      reference: "参考图",
      style: "风格",
      prompt: "要求",
    },
    search: "搜索模板",
    extras: "附加（可选）",
    extrasPicked: (/** @type {number} */ n) => `附加（已选 ${n}）`,
    extrasHint:
      "勾选的参考图、风格、要求会随「按这个画」一起交给 Agent。从右侧文件树把图片、.excalidraw、.md 拖到这里即可加入。",
    extrasEmpty: "还没有附加素材。",
    drawExtras: "不用模板，按勾选的画",
    empty: "没有匹配的模板。",
    create: "新建画板",
    draw: "按这个画",
    copy: "复制",
    open: "打开",
    remove: "移除",
    restore: "恢复",
    removedToggle: (/** @type {number} */ n) => `已移除（${n}）`,
    hideRemoved: "收起已移除",
    newPrompt: "＋ 写一段要求",
    promptTitle: "标题",
    promptText: "要求正文",
    save: "保存",
    cancel: "取消",
    added: (/** @type {string} */ title, /** @type {string} */ kind) =>
      `已加入「${kind}」：${title}`,
    copied: "已复制",
    copyFailed: "复制失败，请点「打开」后手动复制",
    request: (/** @type {string[]} */ lines) =>
      `先运行 \`berth tools show excalidraw\`，读 skill \`excalidraw-diagram\` 来画图。\n${lines.join("\n")}\n画好后告诉我画板路径，我在Excalidraw 侧栏的「改图」页签里继续调。\n要求：`,
    template: (/** @type {string} */ title, /** @type {string} */ id) =>
      `以起手模板「${title}」为起点（结构用 \`berth tools call excalidraw private/library.js --input '{"action":"get","id":"${id}"}'\` 取）。`,
    drawing: (/** @type {string} */ file) => `以这个画板为起点：\`${file}\`。`,
    reference: (/** @type {string} */ file) => `参考这张图：\`${file}\`。`,
    style: (/** @type {string} */ file) => `风格按 \`${file}\`。`,
    prompt: (/** @type {string} */ file) => `按这份要求：\`${file}\`。`,
  },
  en: {
    kinds: {
      template: "Template",
      reference: "Reference",
      style: "Style",
      prompt: "Requirement",
    },
    search: "Search templates",
    extras: "Extras (optional)",
    extrasPicked: (/** @type {number} */ n) => `Extras (${n} picked)`,
    extrasHint:
      'Checked references, styles and requirements go to the agent with "Draw like this". Drag images, .excalidraw or .md files here from the file tree to add them.',
    extrasEmpty: "No extras yet.",
    drawExtras: "Draw from the checked extras only",
    empty: "No template matches.",
    create: "New drawing",
    draw: "Draw like this",
    copy: "Copy",
    open: "Open",
    remove: "Remove",
    restore: "Restore",
    removedToggle: (/** @type {number} */ n) => `Removed (${n})`,
    hideRemoved: "Hide removed",
    newPrompt: "+ Write a requirement",
    promptTitle: "Title",
    promptText: "Requirement text",
    save: "Save",
    cancel: "Cancel",
    added: (/** @type {string} */ title, /** @type {string} */ kind) =>
      `Added to ${kind}: ${title}`,
    copied: "Copied",
    copyFailed: "Copy failed; open the file and copy it by hand",
    request: (/** @type {string[]} */ lines) =>
      `Run \`berth tools show excalidraw\` first and follow the \`excalidraw-diagram\` skill.\n${lines.join("\n")}\nTell me the drawing path when done; I'll keep adjusting it in the Excalidraw sidebar’s Revise tab.\nRequirements: `,
    template: (/** @type {string} */ title, /** @type {string} */ id) =>
      `Start from the template "${title}" (get its structure with \`berth tools call excalidraw private/library.js --input '{"action":"get","id":"${id}"}'\`).`,
    drawing: (/** @type {string} */ file) =>
      `Start from this drawing: \`${file}\`.`,
    reference: (/** @type {string} */ file) =>
      `Use this figure as the reference: \`${file}\`.`,
    style: (/** @type {string} */ file) =>
      `Follow the style guide \`${file}\`.`,
    prompt: (/** @type {string} */ file) =>
      `Follow this requirement: \`${file}\`.`,
  },
}

await berth.ready
const t = berth.ui.locale.startsWith("zh") ? TEXT["zh-CN"] : TEXT.en

const model = {
  /** @type {{ dir: string, items: any[], removed: any[] } | null} */
  library: null,
  query: "",
  /** @type {string | null} */ tag: null,
  /** @type {string | null} */ selected: null,
  /** 勾选的附加素材 id。 @type {Set<string>} */
  extras: new Set(),
  showExtras: false,
  /** @type {string | null} */ error: null,
  busy: false,
  showRemoved: false,
  composing: false,
}
/** 缩略图 data URL 缓存（id → url）。 */
const thumbs = new Map()

/**
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {(Node | string | null)[]} [children]
 */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value)
    else if (value === true) el.setAttribute(key, "")
    else if (value !== false && value != null) el.setAttribute(key, value)
  }
  for (const child of children) if (child != null) el.append(child)
  return el
}

const app = /** @type {HTMLElement} */ (document.getElementById("app"))
/** @param {any} input */
const call = (input) => berth.scripts.run(API, input)

const templates = () =>
  (model.library?.items ?? []).filter((item) => item.kind === "template")
const extraItems = () =>
  (model.library?.items ?? []).filter((item) => item.kind !== "template")
/** 勾选里仍在库中的条目（被移除的不算）。 */
const pickedExtras = () =>
  extraItems().filter((item) => model.extras.has(item.id))

async function load() {
  model.library = await call({ action: "list" })
}

/** @param {() => Promise<void>} action */
async function run(action) {
  model.busy = true
  render()
  try {
    await action()
    model.error = null
  } catch (error) {
    model.error = error instanceof Error ? error.message : String(error)
  }
  model.busy = false
  render()
}

/** @param {any} item */
const fileOf = (item) => `${model.library?.dir}/${item.path}`

/** 「按这个画」的引导语：模板（可无）+ 勾选的附加素材，放进当前 Agent 输入框（不发送）。 @param {any} [template] */
function drawRequest(template) {
  const lines = []
  if (template)
    lines.push(
      template.path
        ? t.drawing(fileOf(template))
        : t.template(template.title, template.id)
    )
  for (const item of pickedExtras()) lines.push(t[item.kind](fileOf(item)))
  return t.request(lines)
}

const saveExtras = () => berth.storage.set("extras", [...model.extras])

/** @param {any} item */
const actions = (item) => ({
  create: () =>
    run(async () => {
      const { path } = await call({ action: "create", id: item.id })
      await berth.files.open(path)
    }),
  draw: () =>
    run(() =>
      berth.agent.attach({ label: item.title, text: drawRequest(item) })
    ),
  copy: () =>
    run(async () => {
      const full = await call({ action: "get", id: item.id })
      await copyText(full.prompt ?? "", t.copyFailed)
      await berth.ui.notify(t.copied)
    }),
  open: () => run(() => berth.files.open(fileOf(item))),
  remove: () =>
    run(async () => {
      await call({ action: "remove", id: item.id })
      model.selected = null
      await load()
    }),
})

/** 拖进来的文件入库：模板进列表，其余进附加并直接勾上。 @param {{ path: string, kind: string, name: string }} drop */
const addDropped = (drop) =>
  run(async () => {
    if (drop.kind !== "file")
      throw new Error(`${drop.name}: drag a file, not a folder`)
    const item = await call({ action: "add", path: drop.path })
    await load()
    if (item.kind === "template") {
      model.query = ""
      model.tag = null
      model.selected = item.id
    } else {
      model.extras.add(item.id)
      model.showExtras = true
      await saveExtras()
    }
    await berth.ui.notify(t.added(item.title, t.kinds[item.kind]))
  })

const lazy = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue
    const img = /** @type {HTMLImageElement} */ (entry.target)
    lazy.unobserve(img)
    const id = img.dataset.id ?? ""
    void call({ action: "get", id })
      .then((full) => {
        if (!full.thumbUrl) return
        thumbs.set(id, full.thumbUrl)
        img.src = full.thumbUrl
      })
      .catch(() => undefined)
  }
})

/** 预览：图片（模板在页面目录，其余进入视口才经 library.js 读取），文字素材显示前几行。 @param {any} item */
function preview(item, cls = "thumb") {
  if (item.thumbAsset)
    return h("img", {
      class: cls,
      src: item.thumbAsset,
      alt: "",
      loading: "lazy",
    })
  if (item.thumb) {
    const img = /** @type {HTMLImageElement} */ (
      h("img", { class: cls, alt: "" })
    )
    const cached = thumbs.get(item.id)
    if (cached) img.src = cached
    else {
      img.dataset.id = item.id
      lazy.observe(img)
    }
    return img
  }
  if (item.excerpt && cls === "thumb")
    return h("div", { class: "excerpt" }, [item.excerpt])
  return null
}

/**
 * @param {string} label
 * @param {() => void} onclick
 */
const button = (label, onclick, cls = "action") =>
  h(
    "button",
    {
      class: cls,
      disabled: model.busy,
      onclick: (/** @type {Event} */ e) => {
        e.stopPropagation()
        onclick()
      },
    },
    [label]
  )

/** @param {any} item */
function templateCard(item) {
  const open = model.selected === item.id
  const act = actions(item)
  return h(
    "li",
    {
      class: open ? "card open" : "card",
      onclick: () => {
        model.selected = open ? null : item.id
        render()
      },
    },
    [
      preview(item),
      h("div", { class: "title" }, [item.title]),
      h(
        "div",
        { class: "tags" },
        item.tags
          .filter((/** @type {string} */ tag) => tag !== item.kind)
          .map((/** @type {string} */ tag) =>
            h("span", { class: "tag" }, [tag])
          )
      ),
      open
        ? h("div", { class: "actions" }, [
            button(t.create, act.create),
            button(t.draw, act.draw),
            item.path ? button(t.open, act.open) : null,
            button(t.remove, act.remove, "action quiet"),
          ])
        : null,
    ]
  )
}

/** 附加素材一行：勾选框 + 小图 + 类型·标题，展开后是操作。 @param {any} item */
function extraRow(item) {
  const open = model.selected === item.id
  const act = actions(item)
  const box = /** @type {HTMLInputElement} */ (
    h("input", {
      type: "checkbox",
      checked: model.extras.has(item.id),
      onclick: (/** @type {Event} */ e) => e.stopPropagation(),
      onchange: () => {
        if (box.checked) model.extras.add(item.id)
        else model.extras.delete(item.id)
        void saveExtras()
        render()
      },
    })
  )
  return h(
    "li",
    {
      class: open ? "extra open" : "extra",
      onclick: () => {
        model.selected = open ? null : item.id
        render()
      },
    },
    [
      h("div", { class: "extra-row" }, [
        box,
        preview(item, "mini"),
        h("span", { class: "grow" }, [
          `${t.kinds[item.kind] ?? item.kind} · ${item.title}`,
        ]),
      ]),
      open && item.excerpt
        ? h("div", { class: "excerpt" }, [item.excerpt])
        : null,
      open
        ? h("div", { class: "actions" }, [
            item.hasPrompt ? button(t.copy, act.copy) : null,
            item.path ? button(t.open, act.open) : null,
            button(t.remove, act.remove, "action quiet"),
          ])
        : null,
    ]
  )
}

/** @param {any} item */
function matches(item) {
  if (model.tag && !item.tags.includes(model.tag)) return false
  const query = model.query.trim().toLowerCase()
  if (!query) return true
  return [item.title, item.excerpt ?? "", ...item.tags].some((text) =>
    String(text).toLowerCase().includes(query)
  )
}

function composer() {
  const title = /** @type {HTMLInputElement} */ (
    h("input", { class: "field", placeholder: t.promptTitle })
  )
  const text = /** @type {HTMLTextAreaElement} */ (
    h("textarea", { class: "field", rows: "6", placeholder: t.promptText })
  )
  const save = () =>
    run(async () => {
      const item = await call({
        action: "addText",
        title: title.value,
        text: text.value,
      })
      model.composing = false
      model.extras.add(item.id)
      await saveExtras()
      await load()
    })
  return h("div", { class: "composer" }, [
    title,
    text,
    h("div", { class: "actions" }, [
      h("button", { class: "action", disabled: model.busy, onclick: save }, [
        t.save,
      ]),
      h(
        "button",
        {
          class: "action quiet",
          onclick: () => {
            model.composing = false
            render()
          },
        },
        [t.cancel]
      ),
    ]),
  ])
}

function extrasSection() {
  const items = extraItems()
  const picked = pickedExtras().length
  return h("section", { class: "extras" }, [
    h(
      "button",
      {
        class: "toggle",
        onclick: () => {
          model.showExtras = !model.showExtras
          render()
        },
      },
      [
        `${model.showExtras ? "▾" : "▸"} ${picked ? t.extrasPicked(picked) : t.extras}`,
      ]
    ),
    model.showExtras
      ? h("div", {}, [
          h("p", { class: "hint" }, [t.extrasHint]),
          items.length
            ? h("ul", {}, items.map(extraRow))
            : h("p", { class: "muted center" }, [t.extrasEmpty]),
          model.composing
            ? composer()
            : h(
                "button",
                {
                  class: "new",
                  onclick: () => {
                    model.composing = true
                    render()
                  },
                },
                [t.newPrompt]
              ),
          picked
            ? button(
                t.drawExtras,
                () =>
                  run(() =>
                    berth.agent.attach({ label: t.extras, text: drawRequest() })
                  ),
                "action wide"
              )
            : null,
        ])
      : null,
  ])
}

function removedList() {
  const removed = model.library?.removed ?? []
  if (removed.length === 0) return null
  return h("div", { class: "removed" }, [
    h(
      "button",
      {
        class: "toggle",
        onclick: () => {
          model.showRemoved = !model.showRemoved
          render()
        },
      },
      [model.showRemoved ? t.hideRemoved : t.removedToggle(removed.length)]
    ),
    model.showRemoved
      ? h(
          "ul",
          {},
          removed.map((item) =>
            h("li", { class: "removed-row" }, [
              h("span", { class: "grow" }, [
                `${t.kinds[item.kind] ?? item.kind} · ${item.title}`,
              ]),
              h(
                "button",
                {
                  class: "action quiet",
                  disabled: model.busy,
                  onclick: () =>
                    run(async () => {
                      await call({ action: "restore", id: item.id })
                      await load()
                    }),
                },
                [t.restore]
              ),
            ])
          )
        )
      : null,
  ])
}

function render() {
  app.replaceChildren()
  app.append(
    h("input", {
      class: "search",
      type: "search",
      placeholder: t.search,
      value: model.query,
      oninput: (/** @type {Event} */ e) => {
        model.query = /** @type {HTMLInputElement} */ (e.target).value
        renderList()
      },
    })
  )
  // 模板里最常见的标签
  const counts = new Map()
  for (const item of templates())
    for (const tag of item.tags)
      if (tag !== item.kind) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10)
  if (top.length > 1)
    app.append(
      h(
        "div",
        { class: "chips" },
        top.map(([tag]) =>
          h(
            "button",
            {
              class: tag === model.tag ? "chip active" : "chip",
              onclick: () => {
                model.tag = tag === model.tag ? null : tag
                render()
              },
            },
            [tag]
          )
        )
      )
    )
  if (model.error) app.append(h("p", { class: "error" }, [model.error]))
  app.append(extrasSection())
  app.append(h("ul", { id: "list" }))
  renderList()
  const removed = removedList()
  if (removed) app.append(removed)
}

function renderList() {
  const list = document.getElementById("list")
  if (!list) return
  const visible = templates().filter(matches)
  list.replaceChildren(...visible.map(templateCard))
  if (visible.length === 0)
    list.append(h("p", { class: "muted center" }, [t.empty]))
}

const context = /** @type {import("berth").ViewContext} */ (berth.ui.context)
context.onDrop?.((drop) => {
  if (!app.hidden) void addDropped(drop)
})

try {
  const [, extras] = await Promise.all([
    load(),
    berth.storage.get("extras").catch(() => undefined),
  ])
  if (Array.isArray(extras)) model.extras = new Set(extras)
} catch (error) {
  model.error = error instanceof Error ? error.message : String(error)
}
render()

// 侧栏页面切走只隐藏、不重载：回到页面时重读，Agent 或命令行改过素材库也能看到。
// 只在数据变了才重画，免得吞掉这次点击。
window.addEventListener("focus", () => {
  if (model.busy) return
  void call({ action: "list" })
    .then((next) => {
      if (JSON.stringify(next) === JSON.stringify(model.library)) return
      model.library = next
      render()
    })
    .catch(() => {})
})
