import { ensureSyntaxTree } from "@codemirror/language"
import {
  StateField,
  type EditorState,
  type Transaction,
} from "@codemirror/state"
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view"

/**
 * Live preview 里渲染的嵌入内容：公式（$…$ / $$…$$）与 ```mermaid 图在光标不在其中时替换为
 * 渲染结果，光标进入（或点击渲染结果）即露出源码；图片渲染在源码行下方。
 * KaTeX / Mermaid 引擎按需加载，复用会话渲染已有依赖。
 */

type EmbedKind = "math-inline" | "math-block" | "mermaid"

interface Embed {
  from: number
  to: number
  kind: EmbedKind
  source: string
}

let katexEngine: Promise<typeof import("katex").default> | null = null
function loadKatex() {
  katexEngine ??= Promise.all([
    import("katex"),
    import("@/components/ai-elements/katex-styles"),
  ]).then(([mod]) => mod.default)
  return katexEngine
}

const mermaidSvgCache = new Map<string, Promise<string>>()
let mermaidSeq = 0
function renderMermaid(source: string): Promise<string> {
  const dark = document.documentElement.classList.contains("dark")
  const key = `${dark ? "dark" : "light"}\n${source}`
  let pending = mermaidSvgCache.get(key)
  if (!pending) {
    pending = import("@streamdown/mermaid").then(async ({ mermaid }) => {
      const engine = mermaid.getMermaid({
        startOnLoad: false,
        securityLevel: "strict",
        theme: dark ? "dark" : "default",
      })
      const { svg } = await engine.render(
        `berth-md-mermaid-${++mermaidSeq}`,
        source
      )
      return svg
    })
    // 失败不缓存，改完源码后可重试
    pending.catch(() => mermaidSvgCache.delete(key))
    mermaidSvgCache.set(key, pending)
  }
  return pending
}

class EmbedWidget extends WidgetType {
  constructor(
    readonly kind: EmbedKind,
    readonly source: string,
    readonly from: number
  ) {
    super()
  }

  eq(other: EmbedWidget) {
    return other.kind === this.kind && other.source === this.source
  }

  toDOM(view: EditorView) {
    const el = document.createElement(
      this.kind === "math-inline" ? "span" : "div"
    )
    el.className = `cm-md-embed cm-md-embed-${this.kind}`
    el.dataset.source = this.source
    el.textContent = this.source
    const fail = (error: unknown) => {
      el.classList.add("cm-md-embed-error")
      el.textContent = error instanceof Error ? error.message : String(error)
    }
    if (this.kind === "mermaid") {
      renderMermaid(this.source).then((svg) => {
        el.innerHTML = svg
        view.requestMeasure()
      }, fail)
    } else {
      loadKatex().then((katex) => {
        katex.render(this.source, el, {
          displayMode: this.kind === "math-block",
          throwOnError: false,
        })
        view.requestMeasure()
      }, fail)
    }
    // 单击 / 拖选 / 滚动留给浏览器（选中公式文字、横滚长公式）；双击才展开源码编辑
    el.addEventListener("dblclick", (event) => {
      event.preventDefault()
      const pos = view.posAtDOM(el)
      view.focus()
      view.dispatch({ selection: { anchor: pos >= 0 ? pos : this.from } })
    })
    return el
  }
}

const CODE_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "Frontmatter",
])
const DISPLAY_MATH = /\$\$([\s\S]+?)\$\$/g
const INLINE_MATH = /(?<![\\$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\d$])/g

/** 找出文档里的公式与 mermaid 块；代码块 / 行内代码 / frontmatter 里的 `$` 不算公式。 */
export function findEmbeds(state: EditorState): Embed[] {
  const embeds: Embed[] = []
  const code: Array<[number, number]> = []
  ensureSyntaxTree(state, state.doc.length, 200)?.iterate({
    enter: (node) => {
      if (!CODE_NODES.has(node.name)) return
      code.push([node.from, node.to])
      if (node.name !== "FencedCode") return false
      const info = node.node.getChild("CodeInfo")
      const body = node.node.getChild("CodeText")
      if (
        info &&
        state.doc.sliceString(info.from, info.to).trim().toLowerCase() ===
          "mermaid"
      ) {
        embeds.push({
          from: node.from,
          to: node.to,
          kind: "mermaid",
          source: body ? state.doc.sliceString(body.from, body.to) : "",
        })
      }
      return false
    },
  })
  const taken = (from: number, to: number) =>
    code.some(([a, b]) => from < b && to > a) ||
    embeds.some((e) => from < e.to && to > e.from)
  // ponytail: 整篇正则扫描，超长文档按改动范围增量更新时再拆
  const text = state.doc.toString()
  for (const match of text.matchAll(DISPLAY_MATH)) {
    const from = match.index
    const to = from + match[0].length
    if (taken(from, to) || !match[1].trim()) continue
    const ownLines =
      state.doc.lineAt(from).from === from && state.doc.lineAt(to).to === to
    embeds.push({
      from,
      to,
      kind: ownLines ? "math-block" : "math-inline",
      source: match[1].trim(),
    })
  }
  for (const match of text.matchAll(INLINE_MATH)) {
    const from = match.index
    const to = from + match[0].length
    if (taken(from, to)) continue
    embeds.push({ from, to, kind: "math-inline", source: match[1] })
  }
  return embeds.sort((a, b) => a.from - b.from)
}

function decorate(
  state: EditorState,
  embeds: readonly Embed[],
  ranges: readonly Span[]
): DecorationSet {
  return Decoration.set(
    embeds
      .filter((e) => !ranges.some((r) => r.from <= e.to && r.to >= e.from))
      // 块级替换必须覆盖整行（如列表里缩进的 mermaid 围栏就保留源码）
      .filter(
        (e) =>
          e.kind === "math-inline" ||
          (state.doc.lineAt(e.from).from === e.from &&
            state.doc.lineAt(e.to).to === e.to)
      )
      .map((e) =>
        Decoration.replace({
          widget: new EmbedWidget(e.kind, e.source, e.from),
          block: e.kind !== "math-inline",
        }).range(e.from, e.to)
      )
  )
}

export function markdownEmbeds() {
  return scannedDecorations({
    scan: findEmbeds,
    // 公式 / 代码围栏的边界字符；改动行不含它们且没碰到已有条目时不必重扫
    trigger: /\$|```|~~~/,
    decorate,
    followSelection: true,
  })
}

// 包自带的 imageBlocks 直接把原始路径塞进 <img src>，Tauri 里本地相对路径加载不到，
// 所以自建：图片以块部件渲染在源码行下方（源码由 inlinePreview 在非活动行隐藏），
// src 经 resolveImage 异步解析。
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly resolve: (src: string) => Promise<string | null>
  ) {
    super()
  }

  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div")
    wrap.className = "cm-atomic-image"
    const img = document.createElement("img")
    img.alt = this.alt
    void this.resolve(this.src).then((url) => {
      if (!url) return
      img.src = url
      img.addEventListener("load", () => view.requestMeasure(), { once: true })
    })
    wrap.appendChild(img)
    // 点图片把光标放回源码行，方便改路径
    wrap.addEventListener("mousedown", (event) => {
      event.preventDefault()
      const pos = view.posAtDOM(wrap)
      if (pos < 0) return
      view.focus()
      view.dispatch({ selection: { anchor: Math.max(0, pos - 1) } })
    })
    return wrap
  }

  ignoreEvent(event: Event) {
    return event.type === "mousedown" || event.type === "click"
  }
}

interface ImageRef {
  from: number
  to: number
  src: string
  alt: string
}

const IMAGE_SOURCE = /^!\[([^\]]*)\]\(<?([^\s)"'<>]+)>?(?:\s+["'][^)]*["'])?\)$/

function findImages(state: EditorState): ImageRef[] {
  const images: ImageRef[] = []
  ensureSyntaxTree(state, state.doc.length, 200)?.iterate({
    enter: (node) => {
      // 表格里的图片由表格部件渲染
      if (node.name === "Table") return false
      if (node.name !== "Image") return
      const match = state.doc
        .sliceString(node.from, node.to)
        .match(IMAGE_SOURCE)
      if (match?.[2])
        images.push({
          from: node.from,
          to: node.to,
          src: match[2],
          alt: match[1],
        })
    },
  })
  return images
}

export function imageBlocks(resolve: (src: string) => Promise<string | null>) {
  return scannedDecorations({
    scan: findImages,
    trigger: /!\[/,
    decorate: (state, images) =>
      Decoration.set(
        images.map((image) =>
          Decoration.widget({
            widget: new ImageWidget(image.src, image.alt, resolve),
            block: true,
            side: 1,
          }).range(state.doc.lineAt(image.from).to)
        ),
        true
      ),
  })
}

// Obsidian 式 `![[目标|宽度]]` 嵌入（独占一行）：图片或 Excalidraw 画板，光标不在该行时
// 整行替换为渲染结果。目标由宿主解析成可显示的 URL；带 openPath 的（画板）点击即打开。
export type WikiEmbedLoader = (
  target: string
) => Promise<{ url: string; openPath?: string } | null>

class WikiEmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly width: number | null,
    readonly load: WikiEmbedLoader,
    readonly open: (path: string) => void
  ) {
    super()
  }

  eq(other: WikiEmbedWidget) {
    return other.target === this.target && other.width === this.width
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div")
    wrap.className = "cm-atomic-image cm-md-wiki-embed"
    let openPath: string | undefined
    void this.load(this.target).then(
      (hit) => {
        if (!hit) {
          wrap.classList.add("cm-md-embed-error")
          wrap.textContent = `![[${this.target}]]`
          return
        }
        openPath = hit.openPath
        const img = document.createElement("img")
        img.alt = this.target
        if (this.width) img.style.width = `${this.width}px`
        img.addEventListener("load", () => view.requestMeasure(), {
          once: true,
        })
        img.src = hit.url
        wrap.appendChild(img)
      },
      () => {
        wrap.classList.add("cm-md-embed-error")
        wrap.textContent = `![[${this.target}]]`
      }
    )
    wrap.addEventListener("mousedown", (event) => {
      event.preventDefault()
      if (openPath) {
        this.open(openPath)
        return
      }
      // 图片：光标移回源码行，方便改引用
      const pos = view.posAtDOM(wrap)
      view.focus()
      if (pos >= 0) view.dispatch({ selection: { anchor: pos } })
    })
    return wrap
  }

  ignoreEvent(event: Event) {
    return event.type === "mousedown" || event.type === "click"
  }
}

interface WikiEmbed {
  from: number
  to: number
  target: string
  width: number | null
}

const WIKI_EMBED = /^!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|(\d+)[^\]]*)?\]\]$/

export function findWikiEmbeds(state: EditorState): WikiEmbed[] {
  const code: Array<[number, number]> = []
  ensureSyntaxTree(state, state.doc.length, 200)?.iterate({
    enter: (node) => {
      if (!CODE_NODES.has(node.name)) return
      code.push([node.from, node.to])
      return false
    },
  })
  const embeds: WikiEmbed[] = []
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    if (!line.text.startsWith("![[")) continue
    const match = WIKI_EMBED.exec(line.text.trimEnd())
    if (!match) continue
    if (code.some(([a, b]) => line.from < b && line.to > a)) continue
    embeds.push({
      from: line.from,
      to: line.to,
      target: match[1].trim(),
      width: match[2] ? Number(match[2]) : null,
    })
  }
  return embeds
}

export function wikiEmbeds(
  load: WikiEmbedLoader,
  open: (path: string) => void
) {
  return scannedDecorations({
    scan: findWikiEmbeds,
    trigger: /!\[\[/,
    decorate: (_state, embeds, ranges) => {
      return Decoration.set(
        embeds
          .filter((e) => !ranges.some((r) => r.from <= e.to && r.to >= e.from))
          .map((e) =>
            Decoration.replace({
              widget: new WikiEmbedWidget(e.target, e.width, load, open),
              block: true,
            }).range(e.from, e.to)
          )
      )
    },
    followSelection: true,
  })
}

interface Span {
  from: number
  to: number
}

/** 改动是否可能影响扫描结果：碰到已有条目，或改动前后所在行含触发字符。 */
function touches(tr: Transaction, trigger: RegExp, items: readonly Span[]) {
  let hit = false
  const before = tr.startState.doc
  const after = tr.state.doc
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    if (hit) return
    hit =
      items.some((item) => fromA <= item.to && toA >= item.from) ||
      trigger.test(
        before.sliceString(before.lineAt(fromA).from, before.lineAt(toA).to)
      ) ||
      trigger.test(
        after.sliceString(after.lineAt(fromB).from, after.lineAt(toB).to)
      )
  })
  return hit
}

/**
 * 选区碰到的条目展开源码。鼠标拖选只看按下点：拖过的图 / 公式保持渲染，
 * 否则块高度在拖动中突变，鼠标下的内容跳走，选区跟不上。
 */
function revealRanges(tr: Transaction | null, state: EditorState): Span[] {
  const { main } = state.selection
  return tr?.isUserEvent("select.pointer")
    ? [{ from: main.anchor, to: main.anchor }]
    : [...state.selection.ranges]
}

/**
 * 整篇扫描得到的条目 → 装饰。普通输入（没碰到条目、行里没有触发字符）只平移位置，
 * 不重扫全文；`followSelection` 时光标移动也重算装饰（条目不变，开销 O(条目数)）。
 * ponytail: 改缩进造成的代码块变化不含触发字符会漏判，遇到再把缩进也算作触发
 */
function scannedDecorations<T extends Span>(spec: {
  scan: (state: EditorState) => T[]
  trigger: RegExp
  decorate: (
    state: EditorState,
    items: readonly T[],
    reveal: readonly Span[]
  ) => DecorationSet
  followSelection?: boolean
}) {
  return StateField.define<{ items: T[]; deco: DecorationSet }>({
    create: (state) => {
      const items = spec.scan(state)
      return {
        items,
        deco: spec.decorate(state, items, revealRanges(null, state)),
      }
    },
    update: (value, tr) => {
      if (!tr.docChanged && !(spec.followSelection && tr.selection))
        return value
      const items = !tr.docChanged
        ? value.items
        : touches(tr, spec.trigger, value.items)
          ? spec.scan(tr.state)
          : value.items.map((item) => ({
              ...item,
              from: tr.changes.mapPos(item.from, 1),
              to: tr.changes.mapPos(item.to, -1),
            }))
      return {
        items,
        deco: spec.decorate(tr.state, items, revealRanges(tr, tr.state)),
      }
    },
    provide: (field) => EditorView.decorations.from(field, (v) => v.deco),
  })
}
