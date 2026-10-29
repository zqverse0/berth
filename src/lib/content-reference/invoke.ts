import { useTabStore } from "@/stores/tab-store"
import { useTerminalRuntimeStore } from "@/stores/terminal-runtime-store"
import { executeReferencePlan, type ExecuteReferenceOutcome } from "./dispatch"
import { planReferenceAction, type PlanReferenceOptions } from "./plan-action"
import { resolveEditorReferenceTarget } from "./resolve-target"
import type {
  ContentSourceSnapshot,
  ReferenceIntent,
  SelectionPayload,
} from "./types"

function resolveLiveBackendId(
  target: ReturnType<typeof resolveEditorReferenceTarget>
): string {
  if (!target || target.kind === "conversation") return ""
  return (
    useTerminalRuntimeStore.getState().sessions[target.terminalId]
      ?.backendInstanceId ?? target.backendInstanceId
  )
}

/**
 * Plan + execute a reference action against the current primary tab target.
 * Session side-effects run immediately; terminal preview is returned for a
 * confirm dialog.
 */
export function invokeContentReference(
  source: Omit<ContentSourceSnapshot, "sourceBackendInstanceId"> & {
    sourceBackendInstanceId?: string
  },
  intent: ReferenceIntent,
  selection: SelectionPayload | null | undefined,
  options: PlanReferenceOptions
): ExecuteReferenceOutcome {
  const tabState = useTabStore.getState()
  const target = resolveEditorReferenceTarget(
    tabState.activeTabId,
    tabState.tabs
  )
  const snapshot: ContentSourceSnapshot = {
    ...source,
    sourceBackendInstanceId:
      source.sourceBackendInstanceId ?? resolveLiveBackendId(target),
  }
  const plan = planReferenceAction(snapshot, selection, target, intent, options)
  return executeReferencePlan(plan)
}

export type { ExecuteReferenceOutcome }
