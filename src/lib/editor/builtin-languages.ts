import { LanguageDescription, type LanguageSupport } from "@codemirror/language"
import type { Extension } from "@codemirror/state"

interface BuiltinLanguage {
  ids: readonly string[]
  extensions: readonly string[]
  load: (match: string) => Promise<Extension>
}

const builtinLanguages: readonly BuiltinLanguage[] = [
  {
    ids: ["json", "jsonc"],
    extensions: [".json", ".jsonc"],
    load: async () => (await import("@codemirror/lang-json")).json(),
  },
  {
    ids: ["javascript", "typescript", "jsx", "tsx"],
    extensions: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"],
    load: async (match) => {
      const { javascript } = await import("@codemirror/lang-javascript")
      return javascript({
        jsx: match === "jsx" || match === "tsx" || match.endsWith("x"),
        typescript:
          match === "typescript" ||
          match === "tsx" ||
          [".ts", ".mts", ".cts", ".tsx"].includes(match),
      })
    },
  },
  {
    ids: ["html"],
    extensions: [".html", ".htm"],
    load: async () => (await import("@codemirror/lang-html")).html(),
  },
  {
    ids: ["css"],
    extensions: [".css"],
    load: async () => (await import("@codemirror/lang-css")).css(),
  },
  {
    ids: ["markdown", "mdx"],
    extensions: [".md", ".mdx", ".markdown"],
    load: async () => (await import("@codemirror/lang-markdown")).markdown(),
  },
  {
    ids: ["python"],
    extensions: [".py", ".pyi"],
    load: async () => (await import("@codemirror/lang-python")).python(),
  },
  {
    ids: ["rust"],
    extensions: [".rs"],
    load: async () => (await import("@codemirror/lang-rust")).rust(),
  },
  {
    ids: ["yaml"],
    extensions: [".yaml", ".yml"],
    load: async () => (await import("@codemirror/lang-yaml")).yaml(),
  },
  {
    ids: ["sql"],
    extensions: [".sql"],
    load: async () => (await import("@codemirror/lang-sql")).sql(),
  },
]

const loaded = new Map<string, Promise<Extension>>()

function load(language: BuiltinLanguage, match: string): Promise<Extension> {
  const key = `${language.ids[0]}:${match}`
  const existing = loaded.get(key)
  if (existing) return existing
  const pending = language.load(match).catch((error) => {
    loaded.delete(key)
    throw error
  })
  loaded.set(key, pending)
  return pending
}

export function loadBuiltinLanguageById(
  languageId: string | null | undefined
): Promise<Extension> | null {
  if (!languageId || languageId === "plaintext") return null
  const normalized = languageId.toLowerCase()
  const language = builtinLanguages.find((candidate) =>
    candidate.ids.includes(normalized)
  )
  return language ? load(language, normalized) : null
}

export function loadBuiltinLanguageForPath(
  path: string | null | undefined
): Promise<Extension> | null {
  if (!path) return null
  const lower = path.toLowerCase()
  const language = builtinLanguages.find((candidate) =>
    candidate.extensions.some((extension) => lower.endsWith(extension))
  )
  if (!language) return null
  const extension = language.extensions.find((candidate) =>
    lower.endsWith(candidate)
  )
  return load(language, extension ?? language.ids[0])
}

/** 内置语言转成 markdown 围栏代码块的语言描述（按 ``` 后的语言名懒加载）。 */
export function builtinCodeLanguages(): LanguageDescription[] {
  return builtinLanguages.map((language) =>
    LanguageDescription.of({
      name: language.ids[0],
      alias: [...language.ids, ...language.extensions.map((e) => e.slice(1))],
      extensions: language.extensions.map((e) => e.slice(1)),
      load: () => load(language, language.ids[0]) as Promise<LanguageSupport>,
    })
  )
}
