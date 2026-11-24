import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { useGroupWorkspaceStore } from "@/stores/group-workspace-store"
import { SidebarHeader } from "@/components/layout/sidebar/sidebar-header"
import { GroupList, useChatGroups } from "./group-switcher"
import { useExpertCatalog } from "./expert-editor"

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  configure: vi.fn(),
  create: vi.fn(),
}))
vi.mock("@/lib/agent/berth-group", async (original) => ({
  ...(await original<object>()),
  listChatGroups: (...args: unknown[]) => mocks.list(...args),
  configureChatGroup: (...args: unknown[]) => mocks.configure(...args),
  createChatGroup: (...args: unknown[]) => mocks.create(...args),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    allFolders: [
      { id: 7, path: "/repo", name: "repo" },
      { id: 8, path: "/repo-wt", name: "wt", project: { main_folder_id: 7 } },
    ],
  }
  return {
    useAppWorkspaceStore: Object.assign(
      (select: (value: typeof state) => unknown) => select(state),
      { getState: () => state, subscribe: () => () => {} }
    ),
  }
})

const group = (name: string, extra = {}) => ({
  name,
  title: null,
  cwd: "/repo",
  members: [],
  ...extra,
})

const view = () =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SidebarHeader title="Group" />
      <GroupList folderId={7} />
    </NextIntlClientProvider>
  )

describe("GroupList", () => {
  beforeEach(() => {
    useChatGroups.setState({ byFolder: {} })
    useExpertCatalog.setState({
      catalog: {
        experts: [{ id: "a", expert: { name: "Writer" } }],
      } as never,
    })
    useGroupWorkspaceStore.setState({ folderId: 7, group: "main" })
    mocks.list.mockResolvedValue({
      ok: true,
      result: {
        groups: [
          group("main", { members: ["a", "b"] }),
          group("design", { title: "Design", cwd: "/repo-wt" }),
        ],
      },
    })
    mocks.configure.mockResolvedValue({ ok: true, result: {} })
    mocks.create.mockResolvedValue({ ok: true, result: {} })
  })

  it("lists the groups with their directory and members and switches to one", async () => {
    view()
    const design = await screen.findByText("Design")
    const row = document.querySelector('[data-group-option="design"]')!
    expect(row.textContent).toContain("wt")
    expect(
      document.querySelector('[data-group-option="main"] [data-group-members]')!
        .textContent
    ).toBe("Writer, b")
    act(() => useGroupWorkspaceStore.getState().setFocusedMember("a"))
    fireEvent.click(design)
    expect(useGroupWorkspaceStore.getState().group).toBe("design")
    expect(useGroupWorkspaceStore.getState().focusedMember).toBeNull()
  })

  it("saves only the changed settings", async () => {
    view()
    await screen.findByText("Design")
    fireEvent.click(
      document.querySelector('[data-group-settings="main"]') as Element
    )
    // 没有回答方式一项（负责人已去掉）。
    expect(document.querySelector("[data-group-responders]")).toBeNull()
    fireEvent.change(document.querySelector("[data-group-cwd]") as Element, {
      target: { value: "/repo-wt" },
    })
    await act(async () => {
      fireEvent.click(screen.getByText("Save"))
    })
    expect(mocks.configure).toHaveBeenCalledWith(7, "main", {
      cwd: "/repo-wt",
    })
  })

  it("creates a group in the picked directory and switches to it", async () => {
    view()
    await screen.findByText("Design")
    fireEvent.click(document.querySelector("[data-group-create]") as Element)
    fireEvent.change(document.querySelector("[data-group-name]") as Element, {
      target: { value: "review" },
    })
    fireEvent.change(document.querySelector("[data-group-cwd]") as Element, {
      target: { value: "/repo-wt" },
    })
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-group-create-submit]") as Element
      )
    })
    expect(mocks.create).toHaveBeenCalledWith(
      7,
      "review",
      undefined,
      "/repo-wt"
    )
    expect(useGroupWorkspaceStore.getState().group).toBe("review")
  })
})
