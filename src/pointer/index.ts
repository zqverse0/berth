export {
  BERTH_SOURCE_HTML_ATTR,
  BERTH_SOURCE_MIME,
  BERTH_SOURCE_VERSION,
  type PointerSelection,
  type PointerSelectionAction,
  type PointerSelectionActionContext,
  type SourceIdentity,
  type SourceElementSpan,
  type SourcePayload,
  type SourceRef,
  type SourceSpan,
} from "./types"
export {
  normalizeSourceRef,
  parseSourcePayload,
  serializeSourcePlain,
  sourceBadgeLabel,
  sourceToPayload,
} from "./serialize"
export {
  copyPlainFromMenu,
  copyPlainToClipboard,
  copySourceFromMenu,
  copySourceToClipboard,
  encodeSourceHtml,
  parseSourceFromClipboardData,
  parseSourceFromHtml,
} from "./clipboard"
export {
  findPdfPageNumber,
  isPointerOwnedTarget,
  readDomExcerpt,
  resolveContextMenuSelection,
  selectionHasText,
  selectionTouchesTarget,
  shouldInterceptContextMenu,
  sourceFromDomSelection,
} from "./capture"
export { sourceRefToReference } from "./source-reference"
export {
  ELEMENT_SOURCE_BUDGET,
  elementSpanFromGrab,
  excerptFromGrab,
  formatElementLocationLines,
  normalizeElementSpan,
  type NativeGrabFields,
} from "./element-source"
export { PointerProvider, useOptionalPointer, usePointer } from "./provider"
export { pointerMenuItems } from "./menu"
export { PreviewSelectionLayer } from "./adapters/preview-selection-layer"
export { bindPdfReadingSelection } from "./adapters/pdf-reading-selection"
export {
  bindTerminalPointer,
  readTerminalSourceIdentity,
} from "./adapters/terminal"
export {
  computeMenuPosition,
  type ComputeMenuPositionOptions,
  type ElementSize,
  type MenuAnchor,
  type MenuPosition,
  type ViewportSize,
} from "./position"
