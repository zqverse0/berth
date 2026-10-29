import {
  formatElementLocationLines,
  normalizeElementSpan,
} from "./element-source"
import {
  BERTH_SOURCE_VERSION,
  type SourcePayload,
  type SourceRef,
  type SourceSpan,
} from "./types"

function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  const parts = normalized.split("/")
  return parts[parts.length - 1] || path
}

function normalizeExcerpt(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\s+$/g, "")
}

function normalizeSpan(span: SourceSpan | undefined): SourceSpan | undefined {
  if (!span) return undefined
  if (span.unit === "lines") {
    const start = Math.min(span.start, span.end)
    const end = Math.max(span.start, span.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1) {
      return undefined
    }
    return { unit: "lines", start, end }
  }
  if (span.unit === "element") {
    return normalizeElementSpan(span)
  }
  if (span.unit === "office") {
    const paths = span.paths
      .map((path) => path.trim().slice(0, 512))
      .filter(Boolean)
      .slice(0, 50)
    return paths.length ? { unit: "office", paths } : undefined
  }
  if (!Number.isFinite(span.page) || span.page < 1) return undefined
  return { unit: "page", page: Math.floor(span.page) }
}

function normalizeTerminalIdentity(
  identity: Extract<SourceRef["identity"], { type: "terminal" }>
): Extract<SourceRef["identity"], { type: "terminal" }> | null {
  const backendInstanceId = identity.backendInstanceId.trim()
  const terminalId = identity.terminalId.trim()
  const session = identity.pane.session.trim()
  const windowName = identity.pane.window.trim()
  const index = Math.floor(identity.pane.index)
  if (!backendInstanceId || !terminalId || !session || !windowName) {
    return null
  }
  if (!Number.isFinite(index) || index < 0) return null
  const cwd = identity.cwd?.trim()
  const title = identity.title?.trim()
  return {
    type: "terminal",
    backendInstanceId,
    terminalId,
    pane: { session, window: windowName, index },
    ...(cwd ? { cwd } : {}),
    ...(title ? { title } : {}),
  }
}

/** 去掉首尾空白后，没有 identity 或没有原文则不是可复制来源。 */
export function normalizeSourceRef(ref: SourceRef): SourceRef | null {
  const excerpt = normalizeExcerpt(ref.excerpt)
  if (!excerpt.trim()) return null
  if (ref.identity.type === "file") {
    const path = ref.identity.path.trim()
    if (!path) return null
    return {
      identity: { type: "file", path },
      span: normalizeSpan(ref.span),
      excerpt,
    }
  }
  if (ref.identity.type === "terminal") {
    const identity = normalizeTerminalIdentity(ref.identity)
    if (!identity) return null
    return { identity, excerpt }
  }
  const url = ref.identity.url.trim()
  if (!url) return null
  const title = ref.identity.title?.trim()
  return {
    identity: { type: "url", url, ...(title ? { title } : {}) },
    span: normalizeSpan(ref.span),
    excerpt,
  }
}

export function sourceToPayload(ref: SourceRef): SourcePayload {
  const normalized = normalizeSourceRef(ref)
  if (!normalized) {
    throw new Error("empty source")
  }
  return {
    v: BERTH_SOURCE_VERSION,
    identity: normalized.identity,
    ...(normalized.span ? { span: normalized.span } : {}),
    excerpt: normalized.excerpt,
  }
}

export function parseSourcePayload(value: unknown): SourceRef | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Partial<SourcePayload>
  if (raw.v !== BERTH_SOURCE_VERSION) return null
  if (!raw.identity || typeof raw.identity !== "object") return null
  if (typeof raw.excerpt !== "string") return null
  if (raw.identity.type === "file") {
    if (typeof raw.identity.path !== "string") return null
    return normalizeSourceRef({
      identity: { type: "file", path: raw.identity.path },
      span: parseSpan(raw.span),
      excerpt: raw.excerpt,
    })
  }
  if (raw.identity.type === "url") {
    if (typeof raw.identity.url !== "string") return null
    return normalizeSourceRef({
      identity: {
        type: "url",
        url: raw.identity.url,
        title:
          typeof raw.identity.title === "string"
            ? raw.identity.title
            : undefined,
      },
      span: parseSpan(raw.span),
      excerpt: raw.excerpt,
    })
  }
  if (raw.identity.type === "terminal") {
    if (typeof raw.identity.backendInstanceId !== "string") return null
    if (typeof raw.identity.terminalId !== "string") return null
    if (!raw.identity.pane || typeof raw.identity.pane !== "object") {
      return null
    }
    const pane = raw.identity.pane as {
      session?: unknown
      window?: unknown
      index?: unknown
    }
    if (typeof pane.session !== "string") return null
    if (typeof pane.window !== "string") return null
    return normalizeSourceRef({
      identity: {
        type: "terminal",
        backendInstanceId: raw.identity.backendInstanceId,
        terminalId: raw.identity.terminalId,
        pane: {
          session: pane.session,
          window: pane.window,
          index: Number(pane.index),
        },
        cwd:
          typeof raw.identity.cwd === "string" ? raw.identity.cwd : undefined,
        title:
          typeof raw.identity.title === "string"
            ? raw.identity.title
            : undefined,
      },
      excerpt: raw.excerpt,
    })
  }
  return null
}

function parseSpan(span: unknown): SourceSpan | undefined {
  if (!span || typeof span !== "object") return undefined
  const raw = span as Partial<SourceSpan> & {
    unit?: string
    selector?: unknown
    tagName?: unknown
    ancestorPath?: unknown
    nearbyText?: unknown
    htmlSnippet?: unknown
  }
  if (raw.unit === "lines") {
    return {
      unit: "lines",
      start: Number(raw.start),
      end: Number(raw.end),
    }
  }
  if (raw.unit === "page") {
    return { unit: "page", page: Number(raw.page) }
  }
  if (raw.unit === "office") {
    return Array.isArray(raw.paths)
      ? normalizeSpan({
          unit: "office",
          paths: raw.paths.filter(
            (value): value is string => typeof value === "string"
          ),
        })
      : undefined
  }
  if (raw.unit === "element") {
    if (typeof raw.selector !== "string" || typeof raw.tagName !== "string") {
      return undefined
    }
    return normalizeElementSpan({
      unit: "element",
      selector: raw.selector,
      tagName: raw.tagName,
      ancestorPath: Array.isArray(raw.ancestorPath)
        ? raw.ancestorPath.filter(
            (value): value is string => typeof value === "string"
          )
        : undefined,
      nearbyText: Array.isArray(raw.nearbyText)
        ? raw.nearbyText.filter(
            (value): value is string => typeof value === "string"
          )
        : undefined,
      htmlSnippet:
        typeof raw.htmlSnippet === "string" ? raw.htmlSnippet : undefined,
    })
  }
  return undefined
}

/** 终端和外部应用看到的极简事实块。 */
export function serializeSourcePlain(ref: SourceRef): string {
  const normalized = normalizeSourceRef(ref)
  if (!normalized) return ""
  const lines: string[] = []
  if (normalized.identity.type === "file") {
    const path = normalized.identity.path
    const span = normalized.span
    if (span?.unit === "lines") {
      lines.push(
        span.start === span.end
          ? `File: \`${path}\` L${span.start}`
          : `File: \`${path}\` L${span.start}–${span.end}`
      )
    } else if (span?.unit === "page") {
      lines.push(`File: \`${path}\` Page ${span.page}`)
    } else {
      lines.push(`File: \`${path}\``)
    }
    if (span?.unit === "element") {
      lines.push(...formatElementLocationLines(span))
    }
    if (span?.unit === "office") {
      lines.push(
        `Elements: ${span.paths.map((path) => `\`${path}\``).join(", ")} (preview element paths)`
      )
    }
  } else if (normalized.identity.type === "terminal") {
    const title =
      normalized.identity.title?.trim() || normalized.identity.terminalId
    const cwd = normalized.identity.cwd?.trim()
    lines.push(cwd ? `Terminal: ${title} (${cwd})` : `Terminal: ${title}`)
    lines.push(`Backend: ${normalized.identity.backendInstanceId}`)
    const pane = normalized.identity.pane
    lines.push(`Pane: ${pane.session}:${pane.window}.${pane.index}`)
  } else {
    lines.push(`URL: ${normalized.identity.url}`)
    if (normalized.identity.title) {
      lines.push(`Title: ${normalized.identity.title}`)
    }
    if (normalized.span?.unit === "element") {
      lines.push(...formatElementLocationLines(normalized.span))
    }
  }
  lines.push("---")
  lines.push(normalized.excerpt)
  return lines.join("\n")
}

export function sourceBadgeLabel(ref: SourceRef): string {
  if (ref.identity.type === "url") {
    return ref.identity.title?.trim() || ref.identity.url
  }
  if (ref.identity.type === "terminal") {
    return ref.identity.title?.trim() || ref.identity.terminalId
  }
  const name = fileNameFromPath(ref.identity.path)
  const span = ref.span
  if (span?.unit === "lines") {
    return span.start === span.end
      ? `${name}:${span.start}`
      : `${name}:${span.start}-${span.end}`
  }
  if (span?.unit === "page") {
    return `${name}:p${span.page}`
  }
  if (span?.unit === "element") {
    return `${name} · ${span.tagName}`
  }
  if (span?.unit === "office") {
    const more = span.paths.length > 1 ? ` +${span.paths.length - 1}` : ""
    return `${name} · ${span.paths[0]}${more}`
  }
  return name
}
