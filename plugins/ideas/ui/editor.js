// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// `.idea.md` 的编辑页（tool.json `editor`）：上面编辑用户原话，下面展示 Agent 写的讨论与结论。
// 只改原话这一段，frontmatter 与后面的小节原样保留；读写、保存都归宿主的文本 tab。

import { h, ideaDate, statusLabel } from "./common.js"

await berth.ready
const zh = berth.ui.locale.startsWith("zh")
const t = zh
  ? {
      placeholder: "想到什么，记一笔…  用 #标签 归类",
      discuss: "和 Agent 讨论",
      discussRequest: (/** @type {string} */ id, /** @type {string} */ path) =>
        `和我讨论想法 ${id}：先运行 \`berth tools show ideas\`，按「处理想法」做（文件 \`${path}\`）。`,
      noNotes: "讨论和结论会由 Agent 写在这里。",
    }
  : {
      placeholder: "Jot down an idea…  use #tags to group",
      discuss: "Discuss with an Agent",
      discussRequest: (/** @type {string} */ id, /** @type {string} */ path) =>
        `Discuss idea ${id} with me: run \`berth tools show ideas\` and follow 「处理想法」 (file \`${path}\`).`,
      noNotes: "An Agent writes the discussion and conclusion here.",
    }

const context = /** @type {any} */ (berth.ui.context)
const id = context.path.replace(/^.*\//, "").replace(/(\.idea)?\.md$/, "")

/** 文件 = frontmatter + 原话 + 从第一个二级标题起的小节。 @param {string} content */
function parse(content) {
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content)?.[0] ?? ""
  const body = content.slice(front.length)
  const at = `\n${body}`.indexOf("\n## ")
  return {
    front,
    text: (at < 0 ? body : body.slice(0, at)).trim(),
    rest: at < 0 ? "" : body.slice(at),
    status: /^status:\s*(.+?)\s*$/m.exec(front)?.[1] ?? "待讨论",
  }
}

let file = parse(context.content)

const app = /** @type {HTMLElement} */ (document.getElementById("app"))
const statusEl = h("span", { class: "status" })
const notes = h("div", { class: "notes" })
const input = /** @type {HTMLTextAreaElement} */ (
  h("textarea", {
    placeholder: t.placeholder,
    "aria-label": t.placeholder,
    readonly: context.readOnly,
    oninput: () => {
      autosize()
      file.text = input.value
      context.change(
        `${file.front}${file.front ? "\n" : ""}${input.value.trim()}\n\n${file.rest}`
      )
    },
  })
)
const autosize = () => {
  input.style.height = "auto"
  input.style.height = `${input.scrollHeight}px`
}

const created = ideaDate(id)
app.append(
  h("header", { class: "head" }, [
    h("span", {}, [created ? created.toLocaleString(berth.ui.locale) : id]),
    statusEl,
    h("span", { class: "grow" }),
    h(
      "button",
      {
        class: "ghost",
        onclick: () =>
          void berth.agent.attach({
            label: id,
            text: t.discussRequest(id, context.path),
          }),
      },
      [t.discuss]
    ),
  ]),
  h("div", { class: "memo" }, [input]),
  notes
)

/** 小节里每行一条（`- 11-06 Agent：…`）。 */
function renderNotes() {
  const sections = file.rest
    .split(/^## /m)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [title, ...lines] = part.split("\n")
      return { title, lines: lines.map((l) => l.trim()).filter(Boolean) }
    })
    .filter((section) => section.lines.length > 0)
  notes.replaceChildren(
    ...(sections.length
      ? sections.map((section) =>
          h("section", {}, [
            h("h2", {}, [section.title]),
            h(
              "ul",
              {},
              section.lines.map((line) =>
                h("li", {}, [line.replace(/^[-*]\s+/, "")])
              )
            ),
          ])
        )
      : [h("p", { class: "muted" }, [t.noNotes])])
  )
}

function render() {
  statusEl.textContent = statusLabel(file.status, berth.ui.locale)
  statusEl.setAttribute("data-status", file.status)
  renderNotes()
  if (input.value.trim() !== file.text.trim()) input.value = file.text
  autosize()
}

input.value = file.text
render()
if (!file.text) input.focus()

context.onExternalChange((content) => {
  file = parse(content)
  render()
})
