import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8")

const deepLink = read("src/components/workspace/deep-link-bootstrap.tsx")
const reader = read("src/sessions/components/transcript-reader.tsx")
const viewStore = read("src/sessions/transcript-view-store.ts")

describe("transcript reader tab boundary", () => {
  it("routes every interactive history opener through the reader tab action", () => {
    for (const source of [deepLink]) {
      expect(source).toContain("openTranscriptTab")
      expect(source).not.toMatch(/\bopenTab\(/)
      expect(source).not.toContain("openConversationInReaderPane")
    }
  })

  it("keeps the transcript renderer outside primary conversation runtime", () => {
    expect(reader).toContain("useTranscriptDetail")
    expect(viewStore).toContain("getFolderConversation")
    expect(viewStore).not.toContain("conversation-runtime")
    expect(reader).toContain("SessionAnalysisView")
    expect(reader).not.toContain("ContentPartsRenderer")
    expect(reader).not.toContain("transcriptContent")
    expect(reader).not.toContain("conversation-runtime")
    expect(reader).not.toContain("MessageListView")
    expect(reader).not.toContain("requestAgentLaunch")
  })
})
