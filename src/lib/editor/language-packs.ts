import type { LRLanguage } from "@codemirror/language"
import type { Extension } from "@codemirror/state"
import {
  loadBuiltinLanguageById,
  loadBuiltinLanguageForPath,
} from "@/lib/editor/builtin-languages"
import {
  editorLanguagePackOperation,
  type InstalledEditorLanguagePack,
} from "@/lib/api"

type LanguageParser = Parameters<typeof LRLanguage.define>[0]["parser"]

interface LanguageModule {
  default?: LanguageParser
  parser?: LanguageParser
  languageData?: Record<string, unknown>
}

const loaded = new Map<string, Promise<Extension>>()
let installedCache: InstalledEditorLanguagePack[] | null = null

export function invalidateEditorLanguagePacks(): void {
  installedCache = null
  loaded.clear()
}

async function installedPacks(): Promise<InstalledEditorLanguagePack[]> {
  if (installedCache) return installedCache
  const snapshot = await editorLanguagePackOperation("installed")
  installedCache = snapshot.installed.filter((pack) => pack.enabled)
  return installedCache
}

function extensionOf(pack: InstalledEditorLanguagePack): Promise<Extension> {
  const key = `${pack.id}@${pack.version}`
  const existing = loaded.get(key)
  if (existing) return existing
  const pending = editorLanguagePackOperation("load", pack.id)
    .then(async (snapshot) => {
      if (!snapshot.moduleSource) throw new Error("Language module is empty")
      const blob = new Blob([snapshot.moduleSource], {
        type: "text/javascript",
      })
      const url = URL.createObjectURL(blob)
      try {
        const loadedModule = (await import(
          /* webpackIgnore: true */ url
        )) as LanguageModule
        const parser = loadedModule.parser ?? loadedModule.default
        if (!parser) throw new Error("Language parser export is missing")
        // @codemirror/language 已随 code-editor 懒 chunk 加载,此处动态引用复用
        // 同一份;若改为顶层值导入会把 CodeMirror 拉回 workspace 首屏静态闭包。
        const { LRLanguage: defineLanguage } =
          await import("@codemirror/language")
        const language = defineLanguage.define({
          parser,
          languageData: loadedModule.languageData,
        })
        return language.extension as Extension
      } finally {
        URL.revokeObjectURL(url)
      }
    })
    .catch((error) => {
      loaded.delete(key)
      throw error
    })
  loaded.set(key, pending)
  return pending
}

export async function loadEditorLanguageById(
  languageId: string | null | undefined
): Promise<Extension> {
  if (!languageId || languageId === "plaintext") return []
  const normalized = languageId.toLowerCase()
  try {
    const packs = await installedPacks()
    const pack = packs.find(
      (candidate) =>
        candidate.id.toLowerCase() === normalized ||
        candidate.languageIds.some((id) => id.toLowerCase() === normalized)
    )
    if (pack) {
      try {
        return await extensionOf(pack)
      } catch {
        // 下载包损坏时使用可信的内置解析器。
      }
    }
  } catch {
    // 本地扩展目录不可读时仍然允许内置语言工作。
  }
  const builtin = loadBuiltinLanguageById(normalized)
  return builtin ? await builtin : []
}

export async function loadEditorLanguageForPath(
  path: string | null | undefined
): Promise<Extension> {
  if (!path) return []
  const normalized = path.toLowerCase()
  try {
    const packs = await installedPacks()
    const pack = packs.find((candidate) =>
      candidate.extensions.some((extension) =>
        normalized.endsWith(
          extension.startsWith(".")
            ? extension.toLowerCase()
            : `.${extension.toLowerCase()}`
        )
      )
    )
    if (pack) {
      try {
        return await extensionOf(pack)
      } catch {
        // 下载包损坏时使用可信的内置解析器。
      }
    }
  } catch {
    // 本地扩展目录不可读时仍然允许内置语言工作。
  }
  const builtin = loadBuiltinLanguageForPath(path)
  return builtin ? await builtin : []
}
