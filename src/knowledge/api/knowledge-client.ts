import { runtimeBridgeOperation } from "@/lib/runtime-bridge"
import type {
  Idea,
  IdeaStatus,
  KnowledgeSnapshot,
  NoteStatus,
} from "@/knowledge/model/types"

async function call<T>(
  folderId: number | undefined,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const response = await runtimeBridgeOperation<T>({ method, folderId, params })
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

export function getKnowledgeSnapshot(folderId: number) {
  return call<KnowledgeSnapshot>(folderId, "knowledge.snapshot")
}

export function searchKnowledge(folderId: number, query: string, limit = 50) {
  return call<{ query: string; documents: KnowledgeSnapshot["documents"] }>(
    folderId,
    "knowledge.search",
    { query, limit }
  )
}

/** 可能过期的笔记路径（项目相对）；会跑 git，按需调用。 */
export async function getStaleKnowledgePaths(folderId: number) {
  return (await call<{ paths: string[] }>(folderId, "knowledge.stale")).paths
}

export function setKnowledgeNoteStatus(
  folderId: number,
  path: string,
  status: NoteStatus
) {
  return call<{ path: string; status: NoteStatus }>(
    folderId,
    "knowledge.setStatus",
    { path, status }
  )
}

export function listIdeas(folderId: number) {
  return call<Idea[]>(folderId, "knowledge.ideas")
}

export function addIdea(folderId: number, text: string) {
  return call<Idea>(folderId, "knowledge.addIdea", { text })
}

export function setIdeaStatus(
  folderId: number,
  id: string,
  status: IdeaStatus
) {
  return call<Idea>(folderId, "knowledge.setIdeaStatus", { id, status })
}

/** 会话分类（Jev）直接写进文件的一条（`.berth/local/jev/log.jsonl` 一行）。 */
export interface JevEntry {
  id: string
  at: string
  category: string
  /** 写入时的类名 */
  name: string
  score: number
  text: string
  expert: string
  agent: string
  sessionId: string
  turn: number
  task?: string
  /** 写到的文件，主项目相对路径 */
  file: string
  /** 已撤销：已从文件里删掉 */
  undone: boolean
}

export interface ClassifyResult {
  expert: string
  provider: string
  rounds: number
  classified: number
  written: JevEntry[]
  error: string | null
}

/** 对一个会话从上次分类到的位置往后跑 Jev 分类；不看自动分类开关。 */
export function classifySession(
  folderId: number,
  agentType: string,
  sessionId: string,
  expert: string | null
) {
  return call<ClassifyResult>(folderId, "knowledge.classify", {
    agentType,
    sessionId,
    expert,
  })
}

export function listExperts(folderId: number) {
  return call<{ value: string; label: string }[]>(folderId, "knowledge.experts")
}

/** 「Jev 动态」：最近的写入，新的在前。 */
export function listJevEntries(folderId: number) {
  return call<JevEntry[]>(folderId, "knowledge.jevLog")
}

/** 撤销一条：从文件里删掉，日志标记已撤销。 */
export function undoJevEntry(folderId: number, id: string) {
  return call<JevEntry>(folderId, "knowledge.jevUndo", { id })
}

/** 改类：移到新类别对应的文件。 */
export function moveJevEntry(folderId: number, id: string, category: string) {
  return call<JevEntry>(folderId, "knowledge.jevMove", { id, category })
}

/** 一道 Jev 判别题：问题、判为是 / 否的标准、阈值（字段名与 `classifier.json` 一致）。 */
export interface ClassifierCriteria {
  question: string
  true: string
  false: string
  threshold: number
}

/** `~/.berth/classifier.json` 里的一个类别。 */
export interface ClassifierCategory extends ClassifierCriteria {
  id: string
  name: string
  /** 一句话说明这一类记什么 */
  description: string
  /** 关掉的类不出题 */
  enabled: boolean
  source: string
  lastTurns?: number
}

export interface ClassifierConfig {
  enabled: boolean
  categories: ClassifierCategory[]
  /** 用户这条消息是否批准了上一轮的提议：命中记一条决定 */
  approval: ClassifierCriteria
}

export interface ClassifierSettings {
  /** 文件写错时为 null，原因在 `error` */
  config: ClassifierConfig | null
  error: string | null
  /** `classifier.json` 的完整路径：问法、阈值在文件里改 */
  path: string
}

/** 会话分类设置（全局，不属于某个项目）。 */
export function getClassifierSettings() {
  return call<ClassifierSettings>(undefined, "knowledge.classifier")
}

export function saveClassifierConfig(config: ClassifierConfig) {
  return call<ClassifierConfig>(undefined, "knowledge.setClassifier", {
    config,
  })
}
