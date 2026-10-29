// Agent 引用文件最常写成行内代码：`src/a.ts`、`a.ts:12`、`a.ts#L12-20`。
// 在 mdast 层把这类行内代码改成链接，交给已有的 MarkdownLink → 文件标签 →
// link-safety → openFilePreview 流程打开（相对路径按当前项目解析）。
//
// 相对路径用 `berth://path/<路径>` 过 rehype：直接写 `./a.ts` 会被 harden 按 URL 规范成 `/a.ts`
// （变成根路径）。MarkdownLink 再用 `projectPathHref` 还原成 `./a.ts`。
//
// ponytail: 只按形状判断（有扩展名白名单），不查文件是否存在；不存在时点击由
// openFilePreview 报错提示。误判多了再改成按项目文件索引核对。

interface MdastNode {
  type: string
  value?: string
  url?: string
  children?: MdastNode[]
}

const CODE_EXT =
  /\.(?:[cm]?[jt]sx?|rs|py|go|java|kts?|swift|rb|php|c|h|cc|cpp|hpp|cs|vue|svelte|css|scss|less|html?|md|mdx|json|jsonc|ya?ml|toml|sql|sh|ps1|txt|lock|xml|svg|tex|ipynb|proto|gradle|ini|env)$/i
const PATH_SHAPE = /^(?:~\/|\.{1,2}\/|\/)?[\w@.+-]+(?:\/[\w@.+\-[\]()]+)*$/
// `:12`、`:12:5`、`:12-20`、`#L12`、`#L12-20`、`#L12-L20`
const LINE_SUFFIX = /(?::(\d+)(?:[-:]\d+)?|#L(\d+)(?:-L?\d+)?)$/

const PROJECT_PATH_URI = "berth://path/"

/** `berth://path/<路径>` → `./<路径>`（link-safety 按当前项目解析）；其他地址 null。 */
export function projectPathHref(href: string | undefined): string | null {
  return href?.startsWith(PROJECT_PATH_URI)
    ? `./${href.slice(PROJECT_PATH_URI.length)}`
    : null
}

/** 行内代码若是文件路径，返回链接地址（相对路径走 `berth://path/`，行号统一成 `#L<n>`）；否则 null。 */
export function inlineCodePathUrl(value: string): string | null {
  const text = value.trim()
  if (!text || text.includes("://")) return null
  const suffix = text.match(LINE_SUFFIX)
  const path = suffix ? text.slice(0, suffix.index) : text
  if (!PATH_SHAPE.test(path) || !CODE_EXT.test(path)) return null
  const line = suffix?.[1] ?? suffix?.[2]
  const located = /^(?:~\/|\.\.\/|\/)/.test(path)
    ? path
    : `${PROJECT_PATH_URI}${path.replace(/^\.\//, "")}`
  return line ? `${located}#L${line}` : located
}

function rewrite(node: MdastNode): void {
  if (!node.children || node.type === "link" || node.type === "linkReference")
    return
  node.children = node.children.map((child) => {
    if (child.type !== "inlineCode" || typeof child.value !== "string") {
      rewrite(child)
      return child
    }
    const url = inlineCodePathUrl(child.value)
    return url
      ? { type: "link", url, children: [{ type: "text", value: child.value }] }
      : child
  })
}

export function remarkInlineCodePaths() {
  return (tree: MdastNode) => rewrite(tree)
}
