import type { ContentSourceKind, SourceCapabilities } from "./types"

export const CAPABILITIES: Record<ContentSourceKind, SourceCapabilities> = {
  "text-editor": {
    attachWholeFile: true,
    attachLineRange: true,
    extractPlainText: true,
    preferImageAttachment: false,
  },
  "text-preview": {
    attachWholeFile: true,
    attachLineRange: false,
    extractPlainText: true,
    preferImageAttachment: false,
  },
  image: {
    attachWholeFile: true,
    attachLineRange: false,
    extractPlainText: false,
    preferImageAttachment: true,
  },
  pdf: {
    attachWholeFile: true,
    attachLineRange: false,
    extractPlainText: true,
    preferImageAttachment: false,
  },
  office: {
    attachWholeFile: true,
    attachLineRange: false,
    extractPlainText: false,
    preferImageAttachment: false,
  },
  diff: {
    attachWholeFile: true,
    attachLineRange: false,
    extractPlainText: true,
    preferImageAttachment: false,
  },
  "path-only": {
    attachWholeFile: true,
    attachLineRange: false,
    extractPlainText: false,
    preferImageAttachment: false,
  },
}

export function getSourceCapabilities(
  kind: ContentSourceKind
): SourceCapabilities {
  return CAPABILITIES[kind]
}
