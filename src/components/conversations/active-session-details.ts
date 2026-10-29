import type {
  DbConversationSummary,
  MessageTurn,
  SessionStats,
} from "@/lib/types"
import type { ConversationRuntimeSession } from "@/stores/conversation-runtime-store"

/** The slice of an open tab needed to locate its active runtime session. */
export interface ActiveSessionTabRef {
  conversationId: number | null
  /** Virtual (negative) runtime key a new conversation streams under before it
   *  reconciles to its persisted `conversationId`. */
  runtimeConversationId?: number
}

export interface ActiveSessionDetails {
  summary: DbConversationSummary | null
  stats: SessionStats | null
  model: string | null
}

/** The slice of a runtime session this resolver reads. */
export type RuntimeSessionForDetails = Pick<
  ConversationRuntimeSession,
  "detail"
>

/**
 * Pick the conversation's model from its turns. Only assistant turns carry a
 * `model`, and a conversation can switch models mid-session, so the most recent
 * turn with a model is the best "current model" signal. Returns `null` when no
 * turn records one (e.g. before the first assistant reply).
 *
 * This is the reliable source: `DbConversationSummary.model` is only populated
 * for imported conversations, staying `null` for sessions started live in-app.
 */
export function pickModelFromTurns(turns: MessageTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const model = turns[i]?.model
    if (model) return model
  }
  return null
}

/**
 * Resolve the active conversation tab's summary + token usage the same way the
 * tab view renders them. The runtime lookup keys on
 * `runtimeConversationId ?? conversationId`, and falls back to the workspace
 * summary so the Session Details dialog can open before `detail` has loaded.
 */
export function resolveActiveSessionDetails(
  tab: ActiveSessionTabRef | null,
  getSession: (id: number) => RuntimeSessionForDetails | null,
  conversations: DbConversationSummary[]
): ActiveSessionDetails {
  const runtimeId = tab?.runtimeConversationId ?? tab?.conversationId ?? null
  const runtimeSession = runtimeId != null ? getSession(runtimeId) : null
  const summary =
    runtimeSession?.detail?.summary ??
    (tab?.conversationId != null
      ? (conversations.find((c) => c.id === tab.conversationId) ?? null)
      : null)
  const stats = runtimeSession?.detail?.session_stats ?? null
  // Prefer the turns' model, then the (usually empty) summary column.
  const model =
    pickModelFromTurns(runtimeSession?.detail?.turns ?? []) ??
    runtimeSession?.detail?.summary?.model ??
    summary?.model ??
    null
  return { summary, stats, model }
}
