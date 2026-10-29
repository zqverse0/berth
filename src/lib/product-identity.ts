export const REFERENCE_SCHEME = "berth"
export const DELEGATION_META_KEY = "berth.delegation"

export function readDelegationMeta(
  meta: Record<string, unknown> | null | undefined
): unknown {
  if (!meta) return undefined
  return meta[DELEGATION_META_KEY]
}

export function hasDelegationMeta(
  meta: Record<string, unknown> | null | undefined
): boolean {
  return readDelegationMeta(meta) !== undefined
}
