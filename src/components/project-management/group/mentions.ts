/**
 * 群输入框的 @：照 OpenMausBot（`src/lib/mentions.ts`、`shared/room-mentions.ts`）。
 * `@` 在开头、空白或左括号 / 引号后才算；名字后面紧跟字母数字（含中文）不算，所以选中后会补一个空格。
 * 名字不分大小写，长的优先；`@everyone` 是全体成员。
 */

/** @ 列表与解析用的一位成员：`id` 是成员名，`name` 是显示名（专家名 / 改过的名字）。 */
export interface MentionPeer {
  id: string
  name: string
}

const OPENING = /[(*_~[{<'"‘“〈《「『【（]/u
export const EVERYONE = "everyone"

function isBoundary(text: string, at: number) {
  if (at === 0) return true
  const before = text[at - 1]
  return /\s/u.test(before) || OPENING.test(before)
}

const continues = (rest: string) => /^[\p{L}\p{N}\p{M}_]/u.test(rest)

/** 光标前正在输入的 @：起点与已输入的筛选词；不在输入 @ 时为 null。 */
export function mentionQueryAt(text: string, caret: number) {
  const upto = text.slice(0, caret)
  const at = upto.lastIndexOf("@")
  if (at === -1 || !isBoundary(upto, at)) return null
  const query = upto.slice(at + 1)
  if (query.length > 24 || query.includes("@") || query.includes("\n"))
    return null
  return { start: at, query }
}

/** 按筛选词过滤候选；筛选词已是完整名字并打了空格时收起列表。 */
export function mentionChoices<T extends { name: string }>(
  pool: readonly T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase()
  if (
    query.endsWith(" ") &&
    pool.some((choice) => choice.name.toLowerCase() === needle)
  )
    return []
  return pool.filter(
    (choice) => !needle || choice.name.toLowerCase().includes(needle)
  )
}

const named = (text: string, at: number, name: string) =>
  text.slice(at + 1, at + 1 + name.length).toLowerCase() ===
    name.toLowerCase() && !continues(text.slice(at + 1 + name.length))

/** 正文里能对上的 @（含 `@everyone`）：高亮用的 [起, 止) 区间。 */
export function mentionRanges(text: string, peers: readonly MentionPeer[]) {
  const names = [EVERYONE, ...peers.map((peer) => peer.name)]
    .filter((name) => name.trim())
    .sort((a, b) => b.length - a.length)
  const ranges: { start: number; end: number }[] = []
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (!isBoundary(text, at)) continue
    const hit = names.find((name) => named(text, at, name))
    if (hit) ranges.push({ start: at, end: at + 1 + hit.length })
  }
  return ranges
}

/**
 * 正文 @ 到谁：`everyone` 为真时是全体；`ids` 按出现顺序；同名的几位里有从列表选中的（`picked`）就只算选中的，
 * 都没选中就记进 `ambiguous`（发送方拒发，不猜）。
 */
export function resolveMentions(
  text: string,
  peers: readonly MentionPeer[],
  picked: readonly string[] = []
) {
  const candidates = peers
    .filter((peer) => peer.name.trim())
    .sort((a, b) => b.name.length - a.name.length)
  const ids: string[] = []
  const ambiguous: string[] = []
  let everyone = false
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (!isBoundary(text, at)) continue
    if (named(text, at, EVERYONE)) everyone = true
    const hit = candidates.find((peer) => named(text, at, peer.name))
    if (!hit) continue
    const sharing = candidates.filter(
      (peer) => peer.name.toLowerCase() === hit.name.toLowerCase()
    )
    const chosen = sharing.filter((peer) => picked.includes(peer.id))
    if (sharing.length > 1 && !chosen.length) {
      if (!ambiguous.includes(hit.name)) ambiguous.push(hit.name)
      continue
    }
    for (const peer of chosen.length ? chosen : sharing)
      if (!ids.includes(peer.id)) ids.push(peer.id)
  }
  return { everyone, ids, ambiguous }
}
