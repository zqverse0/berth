import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8")

const deepLink = read("src/components/workspace/deep-link-bootstrap.tsx")
const reader = read("src/sessions/components/transcript-reader.tsx")
const viewStore = read("src/sessions/transcript-view-store.ts")
const tocStore = read("src/sessions/transcript-toc.ts")

describe("transcript reader tab boundary", () => {
  it("routes every interactive history opener through the reader tab action", () => {
    for (const source of [deepLink]) {
      expect(source).toContain("openTranscriptTab")
      expect(source).not.toMatch(/\bopenTab\(/)
      expect(source).not.toContain("openConversationInReaderPane")
    }
  })

  it("keeps the transcript renderer outside primary conversation runtime", () => {
    // 阅读器只取目录，按段取内容，不拿整份 detail
    expect(reader).toContain("useConversationToc")
    expect(reader).not.toContain("useTranscriptDetail")
    expect(tocStore).toContain("getConversationToc")
    expect(tocStore).not.toContain("getFolderConversation")
    // 阅读器的 store 与会话 tab 共用同一份 detail 缓存（一个会话只存一份），只用缓存与登记，不碰拉取动作
    expect(viewStore).not.toMatch(
      /\b(fetchDetail|refetchDetail|syncViewerDetail)\b/
    )
    expect(reader).toContain("TranscriptView")
    expect(reader).not.toContain("ContentPartsRenderer")
    expect(reader).not.toContain("transcriptContent")
    expect(reader).not.toContain("conversation-runtime")
    expect(reader).not.toContain("MessageListView")
    expect(reader).not.toContain("requestAgentLaunch")
  })
})
