import type { ReferenceAttrs } from "@/components/chat/composer/types"
import { buildFileUri, buildFileUriWithRange } from "@/lib/reference-link"
import { isHttpDocumentUrl } from "@/lib/web-document"

import { normalizeSourceRef, sourceBadgeLabel } from "./serialize"
import type { SourceRef } from "./types"

function fileUri(
  ref: Extract<SourceRef["identity"], { type: "file" }>,
  span: SourceRef["span"]
): string {
  if (span?.unit === "lines") {
    return buildFileUriWithRange(ref.path, { start: span.start, end: span.end })
  }
  const base = buildFileUri(ref.path)
  if (span?.unit === "page") return `${base}#page=${span.page}`
  return base
}

/** 把出处变成输入框已有的 reference 徽章。 */
export function sourceRefToReference(ref: SourceRef): ReferenceAttrs | null {
  const normalized = normalizeSourceRef(ref)
  if (!normalized) return null
  const label = sourceBadgeLabel(normalized)
  if (normalized.identity.type === "file") {
    return {
      refType: "file",
      id: normalized.identity.path,
      label,
      uri: fileUri(normalized.identity, normalized.span),
      meta: {
        fileKind: "file",
        ...(normalized.span?.unit === "page"
          ? { page: normalized.span.page }
          : {}),
      },
    }
  }
  if (normalized.identity.type === "terminal") return null
  if (!isHttpDocumentUrl(normalized.identity.url)) return null
  return {
    refType: "url",
    id: normalized.identity.url,
    label,
    uri: normalized.identity.url,
    meta: { sourceUrl: normalized.identity.url },
  }
}
