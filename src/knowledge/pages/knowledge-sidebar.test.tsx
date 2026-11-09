import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { KnowledgeSnapshot } from "@/knowledge/model/types"

const openFilePreview = vi.fn()
let snapshot: KnowledgeSnapshot

vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ openFilePreview }),
}))
vi.mock("@/knowledge/hooks/use-knowledge-snapshot", () => ({
  useKnowledgeSnapshot: () => ({
    snapshot,
    loading: false,
    error: null,
    refresh: async () => {},
  }),
}))
vi.mock("@/knowledge/hooks/use-knowledge-path-refresh", () => ({
  knowledgeWatchDirs: () => [],
  useKnowledgePathRefresh: () => {},
}))
vi.mock("@/knowledge/api/knowledge-client", () => ({
  getStaleKnowledgePaths: async () => [],
  searchKnowledge: async () => ({ documents: [] }),
}))
vi.mock("@/lib/api", () => ({
  readFileForEdit: async () => ({ content: "" }),
}))
vi.mock("@/lib/agent/berth-project", () => ({
  getBerthStatus: async () => ({ ok: true, result: { enabled: true } }),
}))
vi.mock("@/components/project-management/enable-berth-notice", () => ({
  EnableBerthNotice: () => null,
}))
vi.mock("@/components/layout/sidebar/sidebar-header", () => ({
  SidebarHeaderActions: () => null,
  SidebarHeaderButton: () => null,
}))
vi.mock("@/knowledge/components/note-detail", () => ({
  NoteDetail: () => null,
}))
vi.mock("@/knowledge/components/note-tree", () => ({ NoteRows: () => null }))
vi.mock("@/knowledge/components/vault-browse", () => ({
  HOME_NOTE_PATH: ".berth/knowledge/地图/首页.md",
  VaultEmpty: () => <p>empty vault</p>,
  VaultTree: () => <p>vault tree</p>,
}))
vi.mock("@/knowledge/preview/vault-note", () => ({ openCodePath: vi.fn() }))
vi.mock("@/knowledge/lib/send-to-agent", () => ({
  sendToProjectAgent: vi.fn(),
}))

import { KnowledgeSidebar } from "./knowledge-sidebar"

function renderSidebar() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <KnowledgeSidebar folderId={7} folderPath="/repo" active />
    </NextIntlClientProvider>
  )
}

const base: KnowledgeSnapshot = {
  root: "/main",
  revision: "r",
  generatedAt: "",
  documents: [],
  edges: [],
  diagnostics: [],
  inbox: [],
  inboxDir: null,
}

describe("KnowledgeSidebar inbox", () => {
  beforeEach(() => {
    openFilePreview.mockReset()
  })

  it("takes no space when nothing is waiting", async () => {
    snapshot = base
    renderSidebar()
    await screen.findByText("empty vault")
    expect(screen.queryByText("To file")).not.toBeInTheDocument()
  })

  it("shows the count and opens an item's file from the vault project", async () => {
    snapshot = {
      ...base,
      inbox: [
        {
          path: ".berth/knowledge/待入库/11-07-a.md",
          kind: "任务",
          source: "11-07-a",
          title: "做完的任务",
          result: "已完成",
          archivedAt: "2026-11-07",
        },
        {
          path: ".berth/knowledge/待入库/2026-11-07-1.md",
          kind: "想法",
          source: "2026-11-07-1",
          title: "放下的想法",
          result: "已放下",
          archivedAt: "2026-11-07",
        },
      ],
    }
    renderSidebar()
    const summary = await screen.findByText("To file")
    expect(summary).toHaveTextContent("2")
    await userEvent.click(summary)
    expect(screen.getByText("Dropped")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /做完的任务/ }))
    expect(openFilePreview).toHaveBeenCalledWith(
      "/main/.berth/knowledge/待入库/11-07-a.md",
      { folderId: 7 }
    )
  })
})
