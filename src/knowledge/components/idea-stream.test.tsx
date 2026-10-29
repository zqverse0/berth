import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { IdeaStream } from "./idea-stream"
import type { Idea } from "@/knowledge/model/types"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const idea = (id: string, text: string, status: Idea["status"]): Idea => ({
  id,
  path: `.berth/knowledge/想法/${id}.md`,
  status,
  tags: [],
  text,
  modifiedAt: 0,
})

describe("IdeaStream", () => {
  it("saves with Ctrl+Enter, folds archived ideas and offers discussion on open ones", async () => {
    const onAdd = vi.fn().mockResolvedValue(true)
    const onDiscuss = vi.fn()
    const onRestore = vi.fn()
    const dropped = idea("2026-10-10-080000", "旧想法", "已放下")
    const landed = idea("2026-10-09-080000", "已经做了", "已落地")
    const open = idea("2026-10-11-191324", "切项目太慢", "待讨论")
    render(
      <IdeaStream
        ideas={[open, dropped, landed]}
        busy={false}
        onAdd={onAdd}
        onOpen={vi.fn()}
        onDiscuss={onDiscuss}
        onDrop={vi.fn()}
        onRestore={onRestore}
      />
    )
    expect(screen.getByText("10-11 19:13")).toBeTruthy()
    expect(screen.queryByText("旧想法")).toBeNull()
    expect(screen.queryByText("已经做了")).toBeNull()
    fireEvent.click(screen.getByText("showArchived"))
    expect(screen.getByText("旧想法")).toBeTruthy()
    expect(screen.getByText("已经做了")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("restore"))
    expect(onRestore).toHaveBeenCalledWith(dropped)

    fireEvent.click(screen.getByLabelText("discuss"))
    expect(onDiscuss).toHaveBeenCalledWith(open)

    const input = screen.getByLabelText("placeholder") as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: "新想法 #性能" } })
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true })
    expect(onAdd).toHaveBeenCalledWith("新想法 #性能")
    await waitFor(() => expect(input.value).toBe(""))
  })
})
