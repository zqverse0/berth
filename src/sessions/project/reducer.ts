import type {
  ConversationChange,
  DbConversationSummary,
  ProjectAgentSessionSummary,
} from "@/lib/types"

export function projectAgentSessionIdentity(
  row: ProjectAgentSessionSummary
): string {
  if (row.externalId) return `${row.agentType}:${row.externalId}`
  return `${row.agentType}:db:${row.conversationId ?? "unknown"}`
}

function updatedAtMillis(row: ProjectAgentSessionSummary): number {
  const value = Date.parse(row.updatedAt)
  return Number.isNaN(value) ? 0 : value
}

export function sortProjectAgentSessions(
  rows: ProjectAgentSessionSummary[]
): ProjectAgentSessionSummary[] {
  return rows.sort(
    (left, right) =>
      updatedAtMillis(right) - updatedAtMillis(left) ||
      projectAgentSessionIdentity(left).localeCompare(
        projectAgentSessionIdentity(right)
      )
  )
}

export function mergeProjectAgentSessionRows(
  current: readonly ProjectAgentSessionSummary[],
  incoming: readonly ProjectAgentSessionSummary[]
): ProjectAgentSessionSummary[] {
  const rows = new Map(
    current.map((row) => [projectAgentSessionIdentity(row), row])
  )
  for (const row of incoming) {
    const key = projectAgentSessionIdentity(row)
    const previous = rows.get(key)
    rows.set(key, previous ? { ...previous, ...row } : row)
  }
  return sortProjectAgentSessions([...rows.values()])
}

function rowFromConversation(
  summary: DbConversationSummary,
  previous?: ProjectAgentSessionSummary
): ProjectAgentSessionSummary {
  return {
    agentType: summary.agent_type,
    externalId: summary.external_id,
    conversationId: summary.id,
    conversation: summary,
    title: summary.title_locked
      ? summary.title
      : (previous?.title ?? summary.title),
    model: previous?.model ?? summary.model,
    gitBranch: previous?.gitBranch ?? summary.git_branch,
    messageCount: Math.max(previous?.messageCount ?? 0, summary.message_count),
    startedAt: previous?.startedAt ?? summary.created_at,
    updatedAt:
      Date.parse(previous?.updatedAt ?? "") > Date.parse(summary.updated_at)
        ? previous!.updatedAt
        : summary.updated_at,
    source:
      previous?.source === "native_only" || previous?.source === "both"
        ? "both"
        : "database_only",
    sourceAvailable: previous?.sourceAvailable ?? null,
  }
}

function isRootRegularConversation(summary: DbConversationSummary): boolean {
  return summary.kind === "regular" && summary.parent_id == null
}

function rowMatchesQuery(
  row: ProjectAgentSessionSummary,
  query: string
): boolean {
  if (!query) return true
  return [row.title, row.model, row.gitBranch].some((value) =>
    value?.toLowerCase().includes(query)
  )
}

export function applyConversationChangeToProjectSessions(
  current: ProjectAgentSessionSummary[],
  change: ConversationChange,
  scope: { folderId: number; agentType: string; query: string }
): ProjectAgentSessionSummary[] {
  if (change.kind === "deleted") {
    const next = current.filter((row) => row.conversationId !== change.id)
    return next.length === current.length ? current : next
  }

  const summary = change.summary
  const exactScope =
    summary.folder_id === scope.folderId &&
    summary.agent_type === scope.agentType &&
    isRootRegularConversation(summary)
  if (!exactScope) {
    // A DB conversation may move out of this scope, but an unrelated project
    // must never evict a native-only row merely because it reused the same
    // provider identity.
    const next = current.filter((row) => row.conversationId !== summary.id)
    return next.length === current.length ? current : next
  }

  const existing = current.find(
    (row) =>
      row.conversationId === summary.id ||
      (summary.external_id != null &&
        row.agentType === summary.agent_type &&
        row.externalId === summary.external_id)
  )
  const nextRow = rowFromConversation(summary, existing)
  const belongs = rowMatchesQuery(nextRow, scope.query)

  const withoutExisting = current.filter(
    (row) =>
      row.conversationId !== summary.id &&
      !(
        summary.external_id != null &&
        row.agentType === summary.agent_type &&
        row.externalId === summary.external_id
      )
  )
  if (!belongs) {
    return withoutExisting.length === current.length ? current : withoutExisting
  }

  return sortProjectAgentSessions([...withoutExisting, nextRow])
}
