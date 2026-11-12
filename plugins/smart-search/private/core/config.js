// 配置：`<插件数据目录>/config.json`（0600），键名与原 smart-search CLI 一致，方便「导入旧配置」。
// 读出给页面时 key 打码；脚本内存里才有明文。

/** 可配置的键与默认值（null = 无默认，必须用户填）。默认值与原 config.py 一致。 */
export const DEFAULTS = {
  XAI_API_URL: "https://api.x.ai/v1",
  XAI_API_KEY: null,
  XAI_MODEL: "grok-4-fast",
  XAI_TOOLS: "web_search,x_search",
  OPENAI_COMPATIBLE_API_URL: null,
  OPENAI_COMPATIBLE_API_KEY: null,
  OPENAI_COMPATIBLE_MODEL: "grok-4-fast",
  OPENAI_COMPATIBLE_STREAM: "false",
  EXA_API_KEY: null,
  EXA_BASE_URL: "https://api.exa.ai",
  EXA_TIMEOUT_SECONDS: "30",
  CONTEXT7_API_KEY: null,
  CONTEXT7_BASE_URL: "https://context7.com",
  CONTEXT7_TIMEOUT_SECONDS: "30",
  ZHIPU_API_KEY: null,
  ZHIPU_API_URL: "https://open.bigmodel.cn/api",
  ZHIPU_SEARCH_ENGINE: "search_std",
  ZHIPU_TIMEOUT_SECONDS: "30",
  TAVILY_API_KEY: null,
  TAVILY_API_URL: "https://api.tavily.com",
  TAVILY_ENABLED: "true",
  TAVILY_TIMEOUT_SECONDS: "30",
  FIRECRAWL_API_KEY: null,
  FIRECRAWL_API_URL: "https://api.firecrawl.dev/v2",
  SMART_SEARCH_VALIDATION_LEVEL: "balanced",
  SMART_SEARCH_FALLBACK_MODE: "auto",
  SMART_SEARCH_MINIMUM_PROFILE: "standard",
  SMART_SEARCH_RETRY_MAX_ATTEMPTS: "3",
  SMART_SEARCH_RETRY_MAX_WAIT: "10",
  AI_TIMEOUT_SECONDS: "120",
  RECORDS_RETENTION_DAYS: "90",
}

export const isSecret = (key) => key.endsWith("_API_KEY")

const CHOICES = {
  SMART_SEARCH_VALIDATION_LEVEL: ["fast", "balanced", "strict"],
  SMART_SEARCH_FALLBACK_MODE: ["auto", "off"],
  SMART_SEARCH_MINIMUM_PROFILE: ["standard", "off"],
  OPENAI_COMPATIBLE_STREAM: ["true", "false"],
  TAVILY_ENABLED: ["true", "false"],
}
const NUMBERS = new Set([
  "EXA_TIMEOUT_SECONDS",
  "CONTEXT7_TIMEOUT_SECONDS",
  "ZHIPU_TIMEOUT_SECONDS",
  "TAVILY_TIMEOUT_SECONDS",
  "SMART_SEARCH_RETRY_MAX_ATTEMPTS",
  "SMART_SEARCH_RETRY_MAX_WAIT",
  "AI_TIMEOUT_SECONDS",
  "RECORDS_RETENTION_DAYS",
])
const XAI_TOOLS = ["web_search", "x_search"]

/** 旧 CLI 的配置文件（「导入旧配置」）。 */
export const LEGACY_FILE = "~/.hermes/smart-search/config.json"

const file = (deps) => `${deps.stateDir}/config.json`

/** 已保存的值（只含用户填过的键）。 */
export async function load(deps) {
  try {
    const saved = JSON.parse(await deps.fs.readText(file(deps)))
    return saved && typeof saved === "object" ? saved : {}
  } catch (error) {
    if (error?.reason === "not-found") return {}
    throw error
  }
}

const save = (deps, saved) =>
  deps.fs.writeText(file(deps), JSON.stringify(saved, null, 2) + "\n", {
    mode: 0o600,
  })

/** 校验一个值，返回规范化后的字符串；不合法抛错。 */
export function validate(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`unknown config key ${key}`)
  const text = String(value ?? "").trim()
  if (!text) throw new Error(`${key} is empty; use unset to clear it`)
  if (CHOICES[key]) {
    const lower = text.toLowerCase()
    if (!CHOICES[key].includes(lower))
      throw new Error(`${key} must be one of ${CHOICES[key].join(", ")}`)
    return lower
  }
  // 重试次数可以是 0（不重试），其余数值必须为正
  const floor = key === "SMART_SEARCH_RETRY_MAX_ATTEMPTS" ? 0 : Number.MIN_VALUE
  if (NUMBERS.has(key) && !(Number(text) >= floor && Number.isFinite(Number(text))))
    throw new Error(`${key} must be a ${floor ? "positive" : "non-negative"} number`)
  if (key === "XAI_TOOLS") {
    const bad = text
      .split(",")
      .map((tool) => tool.trim().toLowerCase())
      .filter((tool) => tool && !XAI_TOOLS.includes(tool))
    if (bad.length)
      throw new Error(`XAI_TOOLS: unsupported ${bad.join(", ")} (${XAI_TOOLS.join(", ")})`)
  }
  if (/_(URL)$/.test(key) && !/^https?:\/\//.test(text))
    throw new Error(`${key} must be an http(s) URL`)
  return text
}

export async function set(deps, key, value) {
  const saved = await load(deps)
  saved[key] = validate(key, value)
  await save(deps, saved)
}

export async function unset(deps, key) {
  const saved = await load(deps)
  delete saved[key]
  await save(deps, saved)
}

/** 从旧 CLI 配置导入：只导入本插件认识的键，已填的值以旧配置为准。返回导入的键名。 */
export async function importLegacy(deps, path = LEGACY_FILE) {
  const legacy = JSON.parse(await deps.fs.readText(path))
  const saved = await load(deps)
  const imported = []
  for (const [key, value] of Object.entries(legacy ?? {})) {
    if (!(key in DEFAULTS)) continue
    try {
      saved[key] = validate(key, value)
      imported.push(key)
    } catch {
      // 旧配置里不合法的值跳过，不挡其他键
    }
  }
  await save(deps, saved)
  return imported
}

export const mask = (value) => (value ? `…${String(value).slice(-4)}` : "")

/** 给页面看的配置：每个键的值（key 打码）、默认值、是否用户填过。 */
export async function view(deps) {
  const saved = await load(deps)
  return Object.fromEntries(
    Object.entries(DEFAULTS).map(([key, fallback]) => {
      const value = saved[key]
      return [
        key,
        {
          value: isSecret(key) ? mask(value) : (value ?? null),
          default: fallback,
          saved: value !== undefined,
          secret: isSecret(key),
        },
      ]
    })
  )
}

/** 运行时用的配置：合并默认值，转成各模块要的类型。 */
export async function resolve(deps) {
  const saved = await load(deps)
  const get = (key) => saved[key] ?? DEFAULTS[key] ?? ""
  const number = (key) => {
    const value = Number(get(key))
    return get(key) !== "" && Number.isFinite(value) ? value : Number(DEFAULTS[key])
  }
  const seconds = (key) => number(key) * 1000
  const tavilyEnabled = get("TAVILY_ENABLED") !== "false"
  return {
    // 原 CLI 的 RETRY_MAX_ATTEMPTS 是「重试次数」，总尝试数 = 它 + 1
    retry: {
      attempts: number("SMART_SEARCH_RETRY_MAX_ATTEMPTS") + 1,
      maxWaitMs: seconds("SMART_SEARCH_RETRY_MAX_WAIT"),
    },
    retryAttempts: number("SMART_SEARCH_RETRY_MAX_ATTEMPTS"),
    validation: get("SMART_SEARCH_VALIDATION_LEVEL"),
    fallback: get("SMART_SEARCH_FALLBACK_MODE"),
    minimumProfile: get("SMART_SEARCH_MINIMUM_PROFILE"),
    retentionDays: number("RECORDS_RETENTION_DAYS"),
    xai: get("XAI_API_KEY")
      ? {
          url: get("XAI_API_URL").replace(/\/+$/, ""),
          key: get("XAI_API_KEY"),
          model: get("XAI_MODEL"),
          tools: get("XAI_TOOLS")
            .split(",")
            .map((tool) => tool.trim().toLowerCase())
            .filter((tool, index, all) => tool && all.indexOf(tool) === index),
          timeoutMs: seconds("AI_TIMEOUT_SECONDS"),
        }
      : null,
    openai:
      get("OPENAI_COMPATIBLE_API_URL") && get("OPENAI_COMPATIBLE_API_KEY")
        ? {
            url: get("OPENAI_COMPATIBLE_API_URL"),
            key: get("OPENAI_COMPATIBLE_API_KEY"),
            model: openrouterModel(
              get("OPENAI_COMPATIBLE_MODEL"),
              get("OPENAI_COMPATIBLE_API_URL")
            ),
            stream: get("OPENAI_COMPATIBLE_STREAM") === "true",
            timeoutMs: seconds("AI_TIMEOUT_SECONDS"),
          }
        : null,
    exa: get("EXA_API_KEY")
      ? {
          url: get("EXA_BASE_URL"),
          key: get("EXA_API_KEY"),
          timeoutMs: seconds("EXA_TIMEOUT_SECONDS"),
        }
      : null,
    // Context7 公开可用，不填 key 也能用
    context7: {
      url: get("CONTEXT7_BASE_URL").replace(/\/+$/, ""),
      key: get("CONTEXT7_API_KEY"),
      timeoutMs: seconds("CONTEXT7_TIMEOUT_SECONDS"),
    },
    zhipu: get("ZHIPU_API_KEY")
      ? {
          url: get("ZHIPU_API_URL").replace(/\/+$/, ""),
          key: get("ZHIPU_API_KEY"),
          engine: get("ZHIPU_SEARCH_ENGINE"),
          timeoutMs: seconds("ZHIPU_TIMEOUT_SECONDS"),
        }
      : null,
    tavily:
      get("TAVILY_API_KEY") && tavilyEnabled
        ? {
            url: get("TAVILY_API_URL").replace(/\/+$/, ""),
            key: get("TAVILY_API_KEY"),
            timeoutMs: seconds("TAVILY_TIMEOUT_SECONDS"),
          }
        : null,
    firecrawl: get("FIRECRAWL_API_KEY")
      ? {
          url: get("FIRECRAWL_API_URL").replace(/\/+$/, ""),
          key: get("FIRECRAWL_API_KEY"),
        }
      : null,
  }
}

/** OpenRouter 要 `:online` 后缀才联网（原 config.apply_model_suffix_for_url）。 */
const openrouterModel = (model, url) =>
  url.includes("openrouter") && !model.includes(":online")
    ? `${model}:online`
    : model
