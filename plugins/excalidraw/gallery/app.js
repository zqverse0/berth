// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// 「图库」侧栏：浏览起手模板与素材库（参考图、风格、提示词），新建画板或把素材交给 Agent 画；
// 从文件树拖文件进来入库、写提示词、移除 / 恢复。数据经 private/library.js（scripts.run），
// 素材库在插件数据目录，不在插件包里。

const API = "private/library.js"
const GROUPS = /** @type {const} */ ([
  "template",
  "reference",
  "style",
  "prompt",
])

const TEXT = {
  "zh-CN": {
    groups: {
      template: "模板",
      reference: "参考",
      style: "风格",
      prompt: "提示词",
    },
    search: "搜索标题、标签或内容",
    dropHint: "从右侧文件树把图片、.excalidraw、.md 拖到这里即可加入图库",
    empty: "没有匹配的素材。",
    missing:
      "素材库还没收集：在终端运行插件包里的 private/collect.py（约 300 MB，含 PaperBananaBench）。也可以直接拖自己的文件进来。",
    create: "新建画板",
    draw: "按这个画",
    copy: "复制",
    open: "打开",
    remove: "移除",
    restore: "恢复",
    removedToggle: (/** @type {number} */ n) => `已移除（${n}）`,
    hideRemoved: "收起已移除",
    newPrompt: "＋ 新建提示词",
    promptTitle: "标题",
    promptText: "提示词正文",
    save: "保存",
    cancel: "取消",
    added: (/** @type {string} */ title, /** @type {string} */ group) =>
      `已加入「${group}」：${title}`,
    copied: "已复制",
    copyFailed: "复制失败，请点「打开」后手动复制",
    request: (/** @type {string} */ skill, /** @type {string} */ what) =>
      `先运行 \`berth tools show excalidraw\`，读 skill \`${skill}\` 来画图。${what}\n要求：`,
    template: (/** @type {string} */ title, /** @type {string} */ id) =>
      `以起手模板「${title}」为起点（结构用 \`berth tools call excalidraw private/library.js --input '{"action":"get","id":"${id}"}'\` 取）。`,
    drawing: (/** @type {string} */ file) => `以这个画板为起点：\`${file}\`。`,
    reference: (/** @type {string} */ file) => `参考这张图：\`${file}\`。`,
    style: (/** @type {string} */ file) => `风格按 \`${file}\`。`,
    prompt: (/** @type {string} */ file) => `按这份提示词的要求：\`${file}\`。`,
  },
  en: {
    groups: {
      template: "Templates",
      reference: "References",
      style: "Styles",
      prompt: "Prompts",
    },
    search: "Search titles, tags or text",
    dropHint:
      "Drag images, .excalidraw or .md files here from the file tree to add them",
    empty: "Nothing matches.",
    missing:
      "The library has not been collected yet: run private/collect.py from the plugin package (~300 MB including PaperBananaBench). You can also drag your own files in.",
    create: "New drawing",
    draw: "Draw like this",
    copy: "Copy",
    open: "Open",
    remove: "Remove",
    restore: "Restore",
    removedToggle: (/** @type {number} */ n) => `Removed (${n})`,
    hideRemoved: "Hide removed",
    newPrompt: "+ New prompt",
    promptTitle: "Title",
    promptText: "Prompt text",
    save: "Save",
    cancel: "Cancel",
    added: (/** @type {string} */ title, /** @type {string} */ group) =>
      `Added to ${group}: ${title}`,
    copied: "Copied",
    copyFailed: "Copy failed; open the file and copy it by hand",
    request: (/** @type {string} */ skill, /** @type {string} */ what) =>
      `Run \`berth tools show excalidraw\` first and follow the \`${skill}\` skill. ${what}\nRequirements: `,
    template: (/** @type {string} */ title, /** @type {string} */ id) =>
      `Start from the template "${title}" (get its structure with \`berth tools call excalidraw private/library.js --input '{"action":"get","id":"${id}"}'\`).`,
    drawing: (/** @type {string} */ file) =>
      `Start from this drawing: \`${file}\`.`,
    reference: (/** @type {string} */ file) =>
      `Use this figure as the reference: \`${file}\`.`,
    style: (/** @type {string} */ file) =>
      `Follow the style guide \`${file}\`.`,
    prompt: (/** @type {string} */ file) => `Follow this prompt: \`${file}\`.`,
  },
}

await berth.ready
const t = berth.ui.locale.startsWith("zh") ? TEXT["zh-CN"] : TEXT.en

const model = {
  /** @type {{ dir: string, missing?: boolean, items: any[], removed: any[] } | null} */
  library: null,
  /** @type {(typeof GROUPS)[number]} */ group: "template",
  query: "",
  /** @type {string | null} */ tag: null,
  /** @type {string | null} */ selected: null,
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

/** 按条目类型拼「按这个画」的引导语，放进当前 Agent 输入框（不发送）。 @param {any} item */
function drawRequest(item) {
  if (item.kind === "template")
    return t.request(
      "excalidraw-diagram",
      item.path ? t.drawing(fileOf(item)) : t.template(item.title, item.id)
    )
  if (item.kind === "style")
    return t.request("research-figure", t.style(fileOf(item)))
  if (item.kind === "prompt") {
    const skill = item.tags.includes("excalidraw")
      ? "excalidraw-diagram"
      : "research-figure"
    return t.request(skill, t.prompt(fileOf(item)))
  }
  return t.request("research-figure", t.reference(fileOf(item)))
}

/** 插件页面没有剪贴板权限时退回 execCommand。 @param {string} text */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    const area = h("textarea", {}, [text])
    document.body.append(area)
    area.select()
    const ok = document.execCommand("copy")
    area.remove()
    if (!ok) throw new Error(t.copyFailed)
  }
}

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
      await copyText(full.prompt ?? "")
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

/** 拖进来的文件入库，切到它所在的分组。 @param {{ path: string, kind: string, name: string }} drop */
const addDropped = (drop) =>
  run(async () => {
    if (drop.kind !== "file")
      throw new Error(`${drop.name}: drag a file, not a folder`)
    const item = await call({ action: "add", path: drop.path })
    await load()
    model.group = item.kind
    model.tag = null
    model.selected = item.id
    await berth.ui.notify(t.added(item.title, t.groups[item.kind]))
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
function preview(item) {
  if (item.thumbAsset)
    return h("img", {
      class: "thumb",
      src: item.thumbAsset,
      alt: "",
      loading: "lazy",
    })
  if (item.thumb) {
    const img = /** @type {HTMLImageElement} */ (
      h("img", { class: "thumb", alt: "" })
    )
    const cached = thumbs.get(item.id)
    if (cached) img.src = cached
    else {
      img.dataset.id = item.id
      lazy.observe(img)
    }
    return img
  }
  if (item.excerpt) return h("div", { class: "excerpt" }, [item.excerpt])
  return null
}

/** @param {any} item */
function itemCard(item) {
  const open = model.selected === item.id
  const act = actions(item)
  const button = (
    /** @type {string} */ label,
    /** @type {() => void} */ onclick,
    cls = "action"
  ) =>
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
            item.kind === "template" ? button(t.create, act.create) : null,
            button(t.draw, act.draw),
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
  if (item.kind !== model.group) return false
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
      await load()
      model.selected = item.id
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
                `${t.groups[item.kind] ?? item.kind} · ${item.title}`,
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
  const items = model.library?.items ?? []
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
  app.append(
    h(
      "div",
      { class: "groups" },
      GROUPS.map((group) =>
        h(
          "button",
          {
            class: group === model.group ? "group active" : "group",
            onclick: () => {
              model.group = group
              model.tag = null
              model.selected = null
              model.composing = false
              render()
            },
          },
          [
            `${t.groups[group]} ${items.filter((item) => item.kind === group).length}`,
          ]
        )
      )
    )
  )
  // 当前分组里最常见的标签
  const counts = new Map()
  for (const item of items)
    if (item.kind === model.group)
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
  app.append(h("p", { class: "hint" }, [t.dropHint]))
  if (model.error) app.append(h("p", { class: "error" }, [model.error]))
  if (model.library?.missing && model.group !== "template")
    app.append(h("p", { class: "muted center" }, [t.missing]))
  if (model.group === "prompt")
    app.append(
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
          )
    )
  app.append(h("ul", { id: "list" }))
  renderList()
  const removed = removedList()
  if (removed) app.append(removed)
}

function renderList() {
  const list = document.getElementById("list")
  if (!list) return
  const visible = (model.library?.items ?? []).filter(matches)
  list.replaceChildren(...visible.map(itemCard))
  if (visible.length === 0)
    list.append(h("p", { class: "muted center" }, [t.empty]))
}

const context = /** @type {import("berth").ViewContext} */ (berth.ui.context)
context.onDrop?.((drop) => void addDropped(drop))

try {
  await load()
} catch (error) {
  model.error = error instanceof Error ? error.message : String(error)
}
render()
