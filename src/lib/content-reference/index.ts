export { CAPABILITIES, getSourceCapabilities } from "./capabilities"
export {
  canReferenceSelection,
  canReferenceWholeFile,
  planReferenceAction,
  type PlanReferenceOptions,
} from "./plan-action"
export { executeReferencePlan, type ExecuteReferenceOutcome } from "./dispatch"
export { invokeContentReference } from "./invoke"
export { normalizeAbsolutePath, projectReferencePath } from "./project-path"
export { resolveEditorReferenceTarget } from "./resolve-target"
export {
  quotePathForShell,
  sanitizeTerminalPaste,
  serializeAgentPlainSelection,
  serializeAgentReference,
  serializeAgentSelection,
  type AgentReferenceTranslate,
} from "./serialize"
export { sourceKindFromTab } from "./source-kind"
export type {
  ContentSourceKind,
  ContentSourceSnapshot,
  DisabledReason,
  EditorReference,
  EditorReferenceRange,
  EditorReferenceTarget,
  PathProjection,
  ReferenceIntent,
  ReferencePlan,
  SelectionPayload,
  ShellPathProjection,
  SourceCapabilities,
} from "./types"
