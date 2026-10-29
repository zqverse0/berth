"use client"

import { useSyncExternalStore } from "react"
import { listTerminalSessions } from "@/lib/api"
import type { TerminalDescriptor } from "@/lib/types"

const EMPTY_TERMINAL_INVENTORY: TerminalDescriptor[] = []

export type TerminalInventoryStatus = "idle" | "loading" | "ready" | "error"

export interface TerminalInventoryQueryState {
  descriptors: TerminalDescriptor[]
  status: TerminalInventoryStatus
  hasSuccessfulSnapshot: boolean
  error: string | null
}

const EMPTY_TERMINAL_INVENTORY_STATE: TerminalInventoryQueryState = {
  descriptors: EMPTY_TERMINAL_INVENTORY,
  status: "idle",
  hasSuccessfulSnapshot: false,
  error: null,
}

let queryState: TerminalInventoryQueryState = EMPTY_TERMINAL_INVENTORY_STATE

/**
 * Shared terminal inventory snapshot for UI projections.
 *
 * Explicit consumers (TabProvider startup, window focus, manager visible,
 * create/terminate/remove, transport reconnect, manual refresh) call
 * `refreshTerminalInventory()` at defined boundaries. There is no periodic
 * poll — terminald is the single runtime truth and is queried on demand.
 * Terminal bytes, PTY state and lifecycle commands remain outside this
 * projection store.
 */
let snapshot: TerminalDescriptor[] = EMPTY_TERMINAL_INVENTORY
const listeners = new Set<() => void>()
let snapshotGeneration = 0

/** Coalesce overlapping low-level API calls, without persistent stale caching. */
let inFlight: Promise<TerminalDescriptor[]> | null = null

function sameDescriptor(
  left: TerminalDescriptor,
  right: TerminalDescriptor
): boolean {
  return (
    left.terminalId === right.terminalId &&
    left.backendInstanceId === right.backendInstanceId &&
    left.folderId === right.folderId &&
    left.title === right.title &&
    left.initialCwd === right.initialCwd &&
    left.shell === right.shell &&
    left.status === right.status &&
    left.processId === right.processId &&
    left.createdAt === right.createdAt &&
    left.exitedAt === right.exitedAt
  )
}

function sameInventory(
  left: TerminalDescriptor[],
  right: TerminalDescriptor[]
): boolean {
  return (
    left.length === right.length &&
    left.every((descriptor, index) => sameDescriptor(descriptor, right[index]))
  )
}

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function publishState(
  next: Omit<TerminalInventoryQueryState, "descriptors"> & {
    descriptors?: TerminalDescriptor[]
  }
): void {
  const descriptors = next.descriptors ?? snapshot
  const stableDescriptors = sameInventory(snapshot, descriptors)
    ? snapshot
    : descriptors
  const changed =
    stableDescriptors !== snapshot ||
    queryState.status !== next.status ||
    queryState.hasSuccessfulSnapshot !== next.hasSuccessfulSnapshot ||
    queryState.error !== next.error
  if (!changed) return
  snapshot = stableDescriptors
  queryState = {
    descriptors: stableDescriptors,
    status: next.status,
    hasSuccessfulSnapshot: next.hasSuccessfulSnapshot,
    error: next.error,
  }
  notify()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function getTerminalInventorySnapshot(): TerminalDescriptor[] {
  return snapshot
}

export function getTerminalInventoryQueryState(): TerminalInventoryQueryState {
  return queryState
}

export function subscribeTerminalInventory(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const subscribeWithoutPolling = () => () => {}

/**
 * React projection of the shared terminal inventory. Disabled consumers get a
 * stable empty array and do not keep the fallback poll alive.
 */
export function useTerminalInventorySnapshot(
  enabled: boolean
): TerminalDescriptor[] {
  const current = useSyncExternalStore(
    enabled ? subscribeTerminalInventory : subscribeWithoutPolling,
    getTerminalInventorySnapshot,
    getTerminalInventorySnapshot
  )
  return enabled ? current : EMPTY_TERMINAL_INVENTORY
}

export function useTerminalInventoryQueryState(
  enabled: boolean
): TerminalInventoryQueryState {
  const current = useSyncExternalStore(
    enabled ? subscribeTerminalInventory : subscribeWithoutPolling,
    getTerminalInventoryQueryState,
    getTerminalInventoryQueryState
  )
  return enabled ? current : EMPTY_TERMINAL_INVENTORY_STATE
}

/**
 * Coalesces concurrent `listTerminalSessions()` calls into a single in-flight
 * request. Additional callers receive the same Promise. Failures release the
 * slot so the next caller retries a fresh request.
 *
 * This low-level helper does not cache results or change descriptor semantics.
 */
export function fetchTerminalInventory(): Promise<TerminalDescriptor[]> {
  if (inFlight) return inFlight

  const promise = listTerminalSessions().finally(() => {
    // Identity-safe cleanup: a later request must not be clobbered by an older
    // Promise's finally callback.
    if (inFlight === promise) inFlight = null
  })

  inFlight = promise
  return promise
}

/** Refresh the shared snapshot and return its stable published array. */
export async function refreshTerminalInventory(): Promise<
  TerminalDescriptor[]
> {
  const generation = snapshotGeneration
  // Avoid churning the query state when a refresh is already in flight —
  // coalesced callers share the same Promise and should not re-publish
  // loading→ready for the same request.
  if (!inFlight) {
    publishState({
      status: "loading",
      hasSuccessfulSnapshot: queryState.hasSuccessfulSnapshot,
      error: null,
    })
  }
  try {
    const descriptors = await fetchTerminalInventory()
    if (generation !== snapshotGeneration) return snapshot
    publishState({
      descriptors,
      status: "ready",
      hasSuccessfulSnapshot: true,
      error: null,
    })
    return snapshot
  } catch (error) {
    if (generation === snapshotGeneration) {
      publishState({
        status: "error",
        hasSuccessfulSnapshot: queryState.hasSuccessfulSnapshot,
        error: errorMessage(error),
      })
    }
    throw error
  }
}

/**
 * Test-only reset. It also advances the generation so a request started by a
 * previous test cannot publish into the next test's snapshot.
 */
export function _resetTerminalInventoryQuery(): void {
  snapshotGeneration += 1
  listeners.clear()
  snapshot = EMPTY_TERMINAL_INVENTORY
  queryState = EMPTY_TERMINAL_INVENTORY_STATE
  inFlight = null
}
