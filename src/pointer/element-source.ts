import type { SourceElementSpan } from "./types"

export const ELEMENT_SOURCE_BUDGET = {
  selector: 700,
  tagName: 32,
  ancestorMax: 10,
  ancestorEntry: 160,
  nearbyMax: 8,
  nearbyEntry: 200,
  htmlSnippet: 4096,
  excerpt: 2048,
} as const

export type NativeGrabFields = {
  selector?: string | null
  tagName?: string | null
  id?: string | null
  classList?: string[] | null
  innerText?: string | null
  outerHtml?: string | null
  ancestorPath?: string[] | null
  nearbyText?: string[] | null
  text?: string | null
}

function clip(value: string, max: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max)
}

function clipList(
  values: string[] | null | undefined,
  maxEntries: number,
  maxEntry: number
): string[] | undefined {
  if (!values?.length) return undefined
  const next = values
    .map((value) => clip(String(value), maxEntry))
    .filter(Boolean)
    .slice(0, maxEntries)
  return next.length > 0 ? next : undefined
}

export function normalizeElementSpan(
  span: SourceElementSpan
): SourceElementSpan | undefined {
  const selector = clip(span.selector, ELEMENT_SOURCE_BUDGET.selector)
  const tagName = clip(
    span.tagName.toLowerCase(),
    ELEMENT_SOURCE_BUDGET.tagName
  )
  if (!selector && !tagName) return undefined
  const ancestorPath = clipList(
    span.ancestorPath,
    ELEMENT_SOURCE_BUDGET.ancestorMax,
    ELEMENT_SOURCE_BUDGET.ancestorEntry
  )
  const nearbyText = clipList(
    span.nearbyText,
    ELEMENT_SOURCE_BUDGET.nearbyMax,
    ELEMENT_SOURCE_BUDGET.nearbyEntry
  )
  const htmlSnippet = span.htmlSnippet
    ? clip(span.htmlSnippet, ELEMENT_SOURCE_BUDGET.htmlSnippet) || undefined
    : undefined
  return {
    unit: "element",
    selector: selector || tagName,
    tagName: tagName || "div",
    ...(ancestorPath ? { ancestorPath } : {}),
    ...(nearbyText ? { nearbyText } : {}),
    ...(htmlSnippet ? { htmlSnippet } : {}),
  }
}

export function excerptFromGrab(fields: NativeGrabFields): string {
  const text =
    clip(fields.innerText ?? "", ELEMENT_SOURCE_BUDGET.excerpt) ||
    clip(fields.text ?? "", ELEMENT_SOURCE_BUDGET.excerpt)
  if (text) return text
  const tag = clip(
    (fields.tagName ?? "element").toLowerCase(),
    ELEMENT_SOURCE_BUDGET.tagName
  )
  const id = fields.id?.trim()
  return id ? `<${tag}#${id}>` : `<${tag}>`
}

export function elementSpanFromGrab(
  fields: NativeGrabFields
): SourceElementSpan | undefined {
  const tagName = clip(
    (fields.tagName ?? "").toLowerCase(),
    ELEMENT_SOURCE_BUDGET.tagName
  )
  const id = fields.id?.trim()
  const classes = (fields.classList ?? [])
    .map((value) => String(value).trim())
    .filter(Boolean)
    .slice(0, 3)
  const fallbackSelector = [
    tagName || "div",
    id ? `#${id}` : "",
    classes.map((cls) => `.${cls}`).join(""),
  ].join("")
  return normalizeElementSpan({
    unit: "element",
    selector: fields.selector?.trim() || fallbackSelector,
    tagName: tagName || "div",
    ancestorPath: fields.ancestorPath ?? undefined,
    nearbyText: fields.nearbyText ?? undefined,
    htmlSnippet: fields.outerHtml ?? undefined,
  })
}

/** 复制来源 / Agent 信封共用的元素定位行。 */
export function formatElementLocationLines(span: SourceElementSpan): string[] {
  const normalized = normalizeElementSpan(span)
  if (!normalized) return []
  const lines = [`Selector: \`${normalized.selector}\``]
  lines.push(`Tag: <${normalized.tagName}>`)
  if (normalized.ancestorPath?.length) {
    lines.push(`Ancestor: ${normalized.ancestorPath.join(" > ")}`)
  }
  if (normalized.nearbyText?.length) {
    lines.push("Nearby:")
    for (const text of normalized.nearbyText) {
      lines.push(`- ${text}`)
    }
  }
  return lines
}
