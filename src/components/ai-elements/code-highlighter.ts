// 代码高亮的唯一实现：Streamdown 的 code 插件与 CodeBlock 共用一个 shiki 实例。
//
// 只打包白名单语言与 github 明暗两主题。shiki 完整入口（`@streamdown/code` 用的就是它）带着全部
// 语法、主题的懒加载表，产物里每个语法、主题各一个 chunk（236 + 66 个，约 10.7 MB）。白名单按实际
// 出现的代码围栏语言统计，取累计覆盖 99% 的那些（统计见任务 11-12-resource-footprint「记录 / S9」）；
// 不在白名单的语言显示纯文本。引擎仍用 oniguruma（与完整包相同），高亮结果不变。
import type { ComponentProps } from "react"
import type { Streamdown } from "streamdown"
import type {
  BundledLanguage,
  BundledTheme,
  HighlighterCore,
  LanguageInput,
  TokensResult,
} from "shiki"

type CodePlugin = NonNullable<
  NonNullable<ComponentProps<typeof Streamdown>["plugins"]>["code"]
>

const THEMES: [BundledTheme, BundledTheme] = ["github-light", "github-dark"]

const GRAMMARS: Record<string, () => Promise<{ default: LanguageInput }>> = {
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  solidity: () => import("shiki/langs/solidity.mjs"),
  mermaid: () => import("shiki/langs/mermaid.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  latex: () => import("shiki/langs/latex.mjs"),
  css: () => import("shiki/langs/css.mjs"),
}

// 白名单语言的别名（取自各语法自带的 aliases）。
const ALIASES: Record<string, string> = {
  bash: "shellscript",
  sh: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  ts: "typescript",
  cts: "typescript",
  mts: "typescript",
  rs: "rust",
  md: "markdown",
  py: "python",
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  yml: "yaml",
  mmd: "mermaid",
  ps: "powershell",
  ps1: "powershell",
}

/** 白名单里的语言 id；不认识的返回 null（按纯文本显示）。 */
export function resolveLanguage(language: string): string | null {
  const id = language.trim().toLowerCase()
  const resolved = ALIASES[id] ?? id
  return resolved in GRAMMARS ? resolved : null
}

let highlighter: Promise<HighlighterCore> | null = null
const grammars = new Map<string, Promise<void>>()

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/oniguruma"),
  ]).then(([{ createHighlighterCore }, { createOnigurumaEngine }]) =>
    createHighlighterCore({
      themes: [
        import("shiki/themes/github-light.mjs"),
        import("shiki/themes/github-dark.mjs"),
      ],
      langs: [],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    })
  )
  return highlighter
}

async function load(language: string | null): Promise<HighlighterCore> {
  const core = await getHighlighter()
  if (language) {
    let loading = grammars.get(language)
    if (!loading) {
      loading = GRAMMARS[language]().then((mod) =>
        core.loadLanguage(mod.default)
      )
      // 加载失败不留在表里，下次再试。
      loading.catch(() => grammars.delete(language))
      grammars.set(language, loading)
    }
    await loading
  }
  return core
}

/** 结果缓存上限：流式输出时同一代码块的每个中间状态各占一条，不设上限会随会话一直涨。 */
export const RESULT_CACHE_MAX = 200
const results = new Map<string, TokensResult>()
const waiting = new Map<string, Set<(result: TokensResult) => void>>()

function cacheKey(code: string, language: string): string {
  const head = code.slice(0, 100)
  const tail = code.length > 100 ? code.slice(-100) : ""
  return `${language}:${code.length}:${head}:${tail}`
}

function remember(key: string, result: TokensResult): void {
  results.delete(key)
  results.set(key, result)
  if (results.size > RESULT_CACHE_MAX) {
    results.delete(results.keys().next().value as string)
  }
}

/**
 * 同步取高亮结果：已缓存直接返回；否则返回 null，后台高亮完成后调 `callback`。
 * 明暗两主题同时出（`htmlStyle` 里带 `--shiki-dark`）。
 */
export function highlight(
  code: string,
  language: string,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokensResult) => void
): TokensResult | null {
  const id = resolveLanguage(language)
  const key = cacheKey(code, id ?? "text")
  const cached = results.get(key)
  if (cached) {
    remember(key, cached)
    return cached
  }
  let callbacks = waiting.get(key)
  const started = callbacks !== undefined
  if (!callbacks) {
    callbacks = new Set()
    waiting.set(key, callbacks)
  }
  if (callback) callbacks.add(callback)
  if (started) return null
  load(id)
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then((core) => {
      const result = core.codeToTokens(code, {
        lang: id ?? "text",
        themes: { light: THEMES[0], dark: THEMES[1] },
      })
      remember(key, result)
      for (const notify of waiting.get(key) ?? []) notify(result)
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .catch((error) => console.error("Failed to highlight code:", error))
    .finally(() => waiting.delete(key))
  return null
}

/** Streamdown 的 code 插件（接口同 `@streamdown/code`）。 */
export const code: CodePlugin = {
  name: "shiki",
  type: "code-highlighter",
  highlight: ({ code, language }, callback) =>
    highlight(code, language, callback),
  supportsLanguage: (language) => resolveLanguage(language) !== null,
  getSupportedLanguages: () => Object.keys(GRAMMARS) as BundledLanguage[],
  getThemes: () => THEMES,
}

/** Test-only：清空结果缓存。 */
export function __resetCodeHighlighterForTest(): void {
  results.clear()
  waiting.clear()
}
