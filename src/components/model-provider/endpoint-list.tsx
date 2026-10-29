"use client"

import { useTranslations } from "next-intl"
import { Copy, KeyRound, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ProxyAccess } from "@/lib/model-provider"
import { copyTextToClipboard } from "@/lib/utils"

/**
 * Berth 自己要看懂格式的协议：注入 Agent、拉模型列表、决策面板。其余接口
 * （搜索、工具类 API……）一律 `other`，Berth 只按名字转发，不认格式。
 * 存储仍是 `discovery_json.endpoints.{名字: {apiUrl}}`；`chat` 即 OpenAI 兼容。
 */
export const KNOWN_ENDPOINTS = [
  "chat",
  "claude",
  "gemini",
  "systemone",
] as const
export type KnownEndpoint = (typeof KNOWN_ENDPOINTS)[number]
export type EndpointKind = KnownEndpoint | "other"

export interface EndpointRow {
  kind: EndpointKind
  /** 仅 `other` 用：代理路径 `/p/<id>/<name>` 的最后一段。 */
  name: string
  apiUrl: string
}

/** 行在 `endpoints` 里的键。 */
export function endpointKey(row: EndpointRow): string {
  return row.kind === "other" ? row.name.trim() : row.kind
}

const CUSTOM_NAME = /^[a-z0-9][a-z0-9-]*$/

/** 保存前校验；返回 `ModelProviderSettings.endpoints.*` 下的错误 key，没有问题返回 null。 */
export function endpointError(
  rows: EndpointRow[]
):
  | "endpoints.nameInvalid"
  | "endpoints.nameReserved"
  | "endpoints.duplicate"
  | null {
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row.apiUrl.trim()) continue
    const key = endpointKey(row)
    if (row.kind === "other") {
      if (!CUSTOM_NAME.test(key)) return "endpoints.nameInvalid"
      if ((KNOWN_ENDPOINTS as readonly string[]).includes(key)) {
        return "endpoints.nameReserved"
      }
    }
    if (seen.has(key)) return "endpoints.duplicate"
    seen.add(key)
  }
  return null
}

/** 填写的地址是否已以版本段结尾（`/v1`、`/v1beta`）。示例按 SDK 的通常约定补齐。 */
function versionSuffix(url: string, fallback: string): string {
  return /\/v\d+[a-z]*\/?$/i.test(url.trim()) ? "" : fallback
}

const TOKEN = "$(berth provider token)"

type ExampleLabel =
  | "chat"
  | "image"
  | "embedding"
  | "sdk"
  | "decision"
  | "other"

/** 每种端点的调用示例：路径取各协议规范的标准路径，地址前缀换成代理地址。 */
export function endpointExamples(
  row: EndpointRow,
  address: string
): { label: ExampleLabel; code: string }[] {
  const json = `-H "Content-Type: application/json"`
  switch (row.kind) {
    case "chat": {
      const base = address + versionSuffix(row.apiUrl, "/v1")
      const auth = `-H "Authorization: Bearer ${TOKEN}"`
      return [
        {
          label: "chat",
          code: `curl ${base}/chat/completions ${auth} ${json} \\\n  -d '{"model":"<model>","messages":[{"role":"user","content":"hi"}]}'`,
        },
        {
          label: "image",
          code: `curl ${base}/images/generations ${auth} ${json} \\\n  -d '{"model":"<model>","prompt":"a cat"}'`,
        },
        {
          label: "embedding",
          code: `curl ${base}/embeddings ${auth} ${json} \\\n  -d '{"model":"<model>","input":"hello"}'`,
        },
        {
          label: "sdk",
          code: `from openai import OpenAI\nclient = OpenAI(base_url="${base}", api_key="<token>")`,
        },
      ]
    }
    case "claude": {
      const base = address + versionSuffix(row.apiUrl, "/v1")
      return [
        {
          label: "chat",
          code: `curl ${base}/messages -H "x-api-key: ${TOKEN}" \\\n  -H "anthropic-version: 2023-06-01" ${json} \\\n  -d '{"model":"<model>","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'`,
        },
      ]
    }
    case "gemini": {
      const base = address + versionSuffix(row.apiUrl, "/v1beta")
      return [
        {
          label: "chat",
          code: `curl "${base}/models/<model>:generateContent" -H "x-goog-api-key: ${TOKEN}" ${json} \\\n  -d '{"contents":[{"parts":[{"text":"hi"}]}]}'`,
        },
      ]
    }
    case "systemone": {
      const url = row.apiUrl.trim().replace(/\/+$/, "")
      const path = url.endsWith("/systemone")
        ? ""
        : versionSuffix(url, "/v1") + "/systemone"
      return [
        {
          label: "decision",
          code: `curl ${address}${path} -H "Authorization: Bearer ${TOKEN}" ${json} \\\n  -d '{"model":"<model>","state":"...","questions":{"q":{"type":"noul","instructions":"...","criteria":{"true":"...","false":"..."}}}}'`,
        },
      ]
    }
    case "other":
      return [
        {
          label: "other",
          code: `# ${row.apiUrl.trim()}/<path>  →  ${address}/<path>\ncurl "${address}/<path>" -H "<header>: ${TOKEN}"`,
        },
      ]
  }
}

/** 在 Berth 外使用这个服务商的三条现成命令（复制即用，不用记编号）。 */
export function outsideCommands(
  providerId: number
): { label: "script" | "dotenv" | "agent"; code: string }[] {
  return [
    {
      label: "script",
      code: `berth provider run ${providerId} -- python your_script.py`,
    },
    {
      label: "dotenv",
      code: `berth provider env ${providerId} --dotenv > .env`,
    },
    {
      label: "agent",
      code: `berth provider run ${providerId} --agent <tool-id>`,
    },
  ]
}

/**
 * 服务商端点列表：只列用户添加的行，每行「类型 + 地址」（`other` 另填名字）。
 * 档案已保存时，每行下方给出代理调用地址、复制令牌与调用示例——脚本与外部
 * 工具都只拿代理地址 + 令牌，真 Key 留在 keyring。
 */
export function EndpointList({
  rows,
  onChange,
  providerId,
  access,
}: {
  rows: EndpointRow[]
  onChange: (next: EndpointRow[]) => void
  /** 已保存档案的 id；新建时没有，不显示调用地址。 */
  providerId?: number
  access?: ProxyAccess | null
}) {
  const t = useTranslations("ModelProviderSettings")
  const used = new Set(rows.map((row) => row.kind))

  const update = (index: number, patch: Partial<EndpointRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const add = () => {
    const kind = KNOWN_ENDPOINTS.find((item) => !used.has(item)) ?? "other"
    onChange([...rows, { kind, name: "", apiUrl: "" }])
  }

  return (
    <div className="space-y-2">
      {access && !access.listening && providerId != null ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          {t("endpoints.proxyDown", { address: access.baseUrl })}
        </p>
      ) : null}
      {rows.map((row, index) => {
        const key = endpointKey(row)
        const address =
          access && providerId != null && key && row.apiUrl.trim()
            ? `${access.baseUrl}/p/${providerId}/${key}`
            : null
        return (
          <div key={index} className="space-y-1">
            <div className="flex items-center gap-1.5">
              <Select
                value={row.kind}
                onValueChange={(kind) =>
                  update(index, { kind: kind as EndpointKind })
                }
              >
                <SelectTrigger
                  className="h-8 w-36 shrink-0 text-xs"
                  aria-label={t("endpoints.kind")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KNOWN_ENDPOINTS.map((kind) => (
                    <SelectItem
                      key={kind}
                      value={kind}
                      disabled={kind !== row.kind && used.has(kind)}
                    >
                      {t(`endpoints.kinds.${kind}`)}
                    </SelectItem>
                  ))}
                  <SelectItem value="other">
                    {t("endpoints.kinds.other")}
                  </SelectItem>
                </SelectContent>
              </Select>
              {row.kind === "other" ? (
                <Input
                  value={row.name}
                  onChange={(event) =>
                    update(index, { name: event.target.value })
                  }
                  placeholder={t("endpoints.namePlaceholder")}
                  aria-label={t("endpoints.name")}
                  className="h-8 w-28 shrink-0 font-mono text-xs"
                />
              ) : null}
              <Input
                value={row.apiUrl}
                onChange={(event) =>
                  update(index, { apiUrl: event.target.value })
                }
                placeholder={t(`endpoints.placeholders.${row.kind}`)}
                aria-label={t("endpoints.url")}
                className="h-8 min-w-0 flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-6 shrink-0"
                aria-label={t("endpoints.remove")}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
            {address ? (
              <div className="space-y-1 pl-1 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-1">
                  <span className="shrink-0">{t("endpoints.callAddress")}</span>
                  <code className="min-w-0 truncate font-mono">{address}</code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    aria-label={t("endpoints.copyAddress")}
                    title={t("endpoints.copyAddress")}
                    onClick={() => void copyTextToClipboard(address)}
                  >
                    <Copy className="h-3 w-3" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    aria-label={t("endpoints.copyToken")}
                    title={t("endpoints.copyToken")}
                    onClick={() => void copyTextToClipboard(access!.token)}
                  >
                    <KeyRound className="h-3 w-3" aria-hidden />
                  </Button>
                </div>
                <details>
                  <summary className="cursor-pointer select-none">
                    {t("endpoints.examples")}
                  </summary>
                  <div className="mt-1 space-y-1.5">
                    <p>
                      {t("endpoints.rule", {
                        url: row.apiUrl.trim(),
                        address,
                      })}
                    </p>
                    {endpointExamples(row, address).map((example) => (
                      <div key={example.label}>
                        <div className="flex items-center justify-between">
                          <span>
                            {t(`endpoints.exampleLabels.${example.label}`)}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5"
                            aria-label={t("endpoints.copyExample")}
                            onClick={() =>
                              void copyTextToClipboard(example.code)
                            }
                          >
                            <Copy className="h-3 w-3" aria-hidden />
                          </Button>
                        </div>
                        <pre className="overflow-x-auto rounded bg-muted p-1.5 font-mono text-[10.5px] leading-snug text-foreground/80">
                          {example.code}
                        </pre>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            ) : null}
          </div>
        )
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 w-full text-xs"
        onClick={add}
      >
        <Plus className="mr-1 h-3 w-3" aria-hidden />
        {t("endpoints.add")}
      </Button>
      {providerId != null ? (
        <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none">
            {t("endpoints.outside.title")}
          </summary>
          <div className="mt-1 space-y-1.5">
            {outsideCommands(providerId).map((item) => (
              <div key={item.label}>
                <div className="flex items-center justify-between">
                  <span>{t(`endpoints.outside.${item.label}`)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    aria-label={t("endpoints.copyExample")}
                    onClick={() => void copyTextToClipboard(item.code)}
                  >
                    <Copy className="h-3 w-3" aria-hidden />
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded bg-muted p-1.5 font-mono text-[10.5px] leading-snug text-foreground/80">
                  {item.code}
                </pre>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}
