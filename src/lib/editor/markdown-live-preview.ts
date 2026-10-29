import "@atomic-editor/editor/styles.css"
import {
  atomicMarkdownSyntax,
  highlightMarkdown,
  inlinePreview,
  readOnlyFacet,
  tables,
  wikiLinks,
  type WikiLinksConfig,
} from "@atomic-editor/editor"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { yamlFrontmatter } from "@codemirror/lang-yaml"
import { builtinCodeLanguages } from "./builtin-languages"
import {
  imageBlocks,
  markdownEmbeds,
  wikiEmbeds,
  type WikiEmbedLoader,
} from "./markdown-embeds"
import { syntaxTree } from "@codemirror/language"
import {
  EditorState,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state"
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view"

export interface MarkdownLivePreviewOptions {
  onLinkClick: (url: string) => void
  /** 行内代码是文件路径时返回打开动作（点文字就打开）；null = 普通代码，点击照常编辑 */
  openCodePath: (code: string) => (() => void) | null
  /** 把图片引用解析成可显示的 URL（本地文件读成 data URL）；null = 不显示 */
  resolveImage: (src: string) => Promise<string | null>
  /** `[[双链]]` 的解析 / 补全 / 打开；只在知识库笔记里生效（shouldResolve） */
  wikiLinks: WikiLinksConfig
  /** `![[目标]]` 嵌入：解析成可显示的 URL；画板带 openPath，点击时交给 open */
  wikiEmbed: { load: WikiEmbedLoader; open: (path: string) => void }
  /** 文档首尾的宿主容器（React portal 渲染属性栏 / 关系区），随正文滚动 */
  slots?: { top: HTMLElement; bottom: HTMLElement }
}

/**
 * Markdown Live Preview（Obsidian 式）：光标所在处显示源码，其余渲染；表格可就地编辑。
 * 只改显示，文档文本原样保存。替代通用 markdown 语言包，仅用于文件编辑器（diff / merge 不用）。
 * 主题色由 globals.css 里 `.atomic-cm-editor` 下的 `--atomic-editor-*` 变量映射到应用 token。
 */
export function markdownLivePreview({
  onLinkClick,
  openCodePath,
  resolveImage,
  wikiLinks: wikiLinksConfig,
  wikiEmbed,
  slots,
}: MarkdownLivePreviewOptions): Extension {
  return [
    // frontmatter 按 YAML 解析，否则 `key: v` + `---` 会被当成 setext 标题；
    // GFM 基底：表格、任务列表、删除线需要
    yamlFrontmatter({
      content: markdown({
        base: markdownLanguage,
        extensions: highlightMarkdown,
        codeLanguages: builtinCodeLanguages(),
      }),
    }),
    atomicMarkdownSyntax,
    // 只读跟随编辑器的 readOnly：整篇保持渲染、链接单击打开、表格不可编辑
    readOnlyFacet.compute([EditorState.readOnly], (state) => state.readOnly),
    tables({ onLinkClick }),
    inlinePreview(),
    imageBlocks(resolveImage),
    markdownEmbeds(),
    wikiEmbeds(wikiEmbed.load, wikiEmbed.open),
    wikiLinks(wikiLinksConfig),
    clickToOpen(onLinkClick, openCodePath),
    slots ? slotBlocks(slots.top, slots.bottom) : [],
    EditorView.editorAttributes.of({ class: "atomic-cm-editor" }),
    EditorView.lineWrapping,
  ]
}

/**
 * Obsidian 式点击打开：链接、裸网址、路径形状的行内代码，点文字就打开（库的尾部图标已移除）。
 * 只给可见范围里、光标不在其中的目标打 `cm-berth-open` 标记（手形光标 + 打开地址）；
 * 光标在里面（源码已展开）就是编辑，不拦点击。`[[双链]]` 由 wikiLinks 处理。
 */
function clickToOpen(
  onLinkClick: (url: string) => void,
  openCodePath: (code: string) => (() => void) | null
) {
  const build = (view: EditorView) => {
    const { state } = view
    const tree = syntaxTree(state)
    const ranges: Range<Decoration>[] = []
    for (const { from, to } of view.visibleRanges) {
      tree.iterate({
        from,
        to,
        enter: (node) => {
          if (node.name === "Image" || node.name === "LinkReference")
            return false
          let attributes: Record<string, string> | null = null
          if (node.name === "Link") {
            // `[label](url)`：取 `]` 之后的 URL；引用式链接没有地址
            const close = node.node
              .getChildren("LinkMark")
              .find((m) => state.sliceDoc(m.from, m.to) === "]")
            const dest =
              close &&
              node.node.getChildren("URL").find((u) => u.from >= close.to)
            if (dest)
              attributes = {
                "data-open-link": state.sliceDoc(dest.from, dest.to),
              }
          } else if (node.name === "URL") {
            attributes = {
              "data-open-link": state.sliceDoc(node.from, node.to),
            }
          } else if (node.name === "InlineCode") {
            const code = state
              .sliceDoc(node.from, node.to)
              .replace(/^`+|`+$/g, "")
            if (openCodePath(code)) attributes = { "data-open-code": code }
          } else return
          const editing = state.selection.ranges.some(
            (r) => r.from <= node.to && r.to >= node.from
          )
          if (attributes && !editing)
            ranges.push(
              Decoration.mark({ class: "cm-berth-open", attributes }).range(
                node.from,
                node.to
              )
            )
          return false
        },
      })
    }
    return Decoration.set(ranges)
  }

  const target = (view: EditorView, event: MouseEvent) => {
    if (event.button !== 0) return null
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return null
    const el = event.target instanceof Element ? event.target : null
    if (!el || !view.contentDOM.contains(el)) return null
    // 表格单元格是库自绘的 contenteditable，链接地址在 data-url 上；`.active` = 光标在其中
    const cell = el.closest<HTMLElement>(
      ".cm-atomic-table-cell-source :is(.cm-atomic-link-wrap, .cm-atomic-code-wrap)"
    )
    if (cell) {
      if (cell.classList.contains("active")) return null
      const url = cell.dataset.url
      if (url) return () => onLinkClick(url)
      const code = cell.querySelector(".cm-atomic-inline-code")?.textContent
      return code ? openCodePath(code) : null
    }
    const { openLink, openCode } =
      el.closest<HTMLElement>(".cm-berth-open")?.dataset ?? {}
    if (openLink) return () => onLinkClick(openLink)
    return openCode ? openCodePath(openCode) : null
  }

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(readonly view: EditorView) {
        this.decorations = build(view)
        // 捕获阶段：先于表格单元格自己的监听；pointerdown 阻止默认，光标不进链接、源码不展开
        view.dom.addEventListener("pointerdown", this.onDown, true)
        view.dom.addEventListener("click", this.onClick, true)
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        )
          this.decorations = build(update.view)
      }
      destroy() {
        this.view.dom.removeEventListener("pointerdown", this.onDown, true)
        this.view.dom.removeEventListener("click", this.onClick, true)
      }
      onDown = (event: PointerEvent) => {
        if (target(this.view, event)) event.preventDefault()
      }
      onClick = (event: MouseEvent) => {
        const open = target(this.view, event)
        if (!open) return
        event.preventDefault()
        event.stopPropagation()
        open()
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}

// 宿主容器部件：直接挂调用方持有的稳定元素，CodeMirror 虚拟化卸载 / 重挂时 portal 内容不丢
class SlotWidget extends WidgetType {
  constructor(readonly element: HTMLElement) {
    super()
  }

  eq(other: SlotWidget) {
    return other.element === this.element
  }

  toDOM() {
    return this.element
  }

  // 事件交给容器里的 React 组件处理
  ignoreEvent() {
    return true
  }
}

function slotBlocks(top: HTMLElement, bottom: HTMLElement) {
  const build = (state: EditorState) =>
    Decoration.set([
      Decoration.widget({
        widget: new SlotWidget(top),
        block: true,
        side: -1,
      }).range(0),
      Decoration.widget({
        widget: new SlotWidget(bottom),
        block: true,
        side: 1,
      }).range(state.doc.length),
    ])
  return StateField.define<DecorationSet>({
    create: build,
    update: (deco, tr) => (tr.docChanged ? build(tr.state) : deco),
    provide: (field) => EditorView.decorations.from(field),
  })
}
