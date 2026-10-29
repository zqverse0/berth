import { getTransport } from "@/lib/transport"
import type {
  TranslateSettings,
  TranslateTextRequest,
  TranslateTextResult,
} from "@/lib/types"

/** 与 Host `ENGINE_TIMEOUT_MS` 对齐，并留一点 IPC 余量。 */
const TRANSLATE_TIMEOUT_MS = 12_000

export const TRANSLATE_PROVIDER_AUTO = "auto" as const

export const TRANSLATE_FREE_PROVIDERS = [
  "tencenttransmart",
  "huoshanweb",
  "googleapi",
  "google",
] as const

export const TRANSLATE_COMMERCIAL_PROVIDERS = [
  "deepl",
  "openaiCompatible",
] as const

export type TranslateProviderId =
  | typeof TRANSLATE_PROVIDER_AUTO
  | (typeof TRANSLATE_FREE_PROVIDERS)[number]
  | (typeof TRANSLATE_COMMERCIAL_PROVIDERS)[number]

export const TRANSLATE_COMMERCIAL_DOCS: Record<
  (typeof TRANSLATE_COMMERCIAL_PROVIDERS)[number],
  string
> = {
  deepl: "https://www.deepl.com/pro-api",
  openaiCompatible: "https://platform.openai.com/api-keys",
}

export const TRANSLATE_COMMERCIAL_DEFAULT_URLS: Record<
  (typeof TRANSLATE_COMMERCIAL_PROVIDERS)[number],
  string
> = {
  deepl: "https://api-free.deepl.com",
  openaiCompatible: "https://api.openai.com/v1",
}

export function isTranslateProviderId(
  value: string
): value is TranslateProviderId {
  return (
    value === TRANSLATE_PROVIDER_AUTO ||
    (TRANSLATE_FREE_PROVIDERS as readonly string[]).includes(value) ||
    (TRANSLATE_COMMERCIAL_PROVIDERS as readonly string[]).includes(value)
  )
}

/**
 * 划词翻译。未指定引擎时 Host 使用设置页默认值（未配置则为免费竞速）。
 */
export async function translateText(
  request: TranslateTextRequest
): Promise<TranslateTextResult> {
  const text = request.text.trim()
  if (!text) {
    throw new Error("Empty text")
  }
  return getTransport().call(
    "translate_text",
    {
      request: {
        text,
        sourceLang: request.sourceLang ?? null,
        targetLang: request.targetLang ?? null,
        provider: request.provider ?? null,
        apiKey: request.apiKey ?? null,
        baseUrl: request.baseUrl ?? null,
        region: request.region ?? null,
        model: request.model ?? null,
      },
    },
    { timeoutMs: TRANSLATE_TIMEOUT_MS }
  )
}

export async function getTranslateSettings(): Promise<TranslateSettings> {
  return getTransport().call("get_translate_settings")
}

export async function updateTranslateSettings(
  settings: TranslateSettings
): Promise<TranslateSettings> {
  return getTransport().call("update_translate_settings", { settings })
}
