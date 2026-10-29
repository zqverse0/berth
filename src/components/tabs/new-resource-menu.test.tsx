import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { NewResourceMenu } from "./new-resource-menu"

const createFolderResource = vi.fn()

vi.mock("@/lib/workspace/folder-resource", () => ({
  createFolderResource: (...args: unknown[]) => createFolderResource(...args),
}))

function renderMenu(
  props: Partial<React.ComponentProps<typeof NewResourceMenu>> = {}
) {
  const onNewAgent = vi.fn()
  createFolderResource.mockImplementation(
    (request: { kind: string; onCreateConversation?: () => void }) => {
      if (request.kind === "conversation") request.onCreateConversation?.()
      return Promise.resolve(null)
    }
  )
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <NewResourceMenu onNewAgent={onNewAgent} folderId={7} {...props} />
    </NextIntlClientProvider>
  )
  return { onNewAgent }
}

describe("NewResourceMenu", () => {
  afterEach(() => {
    cleanup()
    createFolderResource.mockReset()
  })

  it("opens Agent conversation on a single click", async () => {
    const user = userEvent.setup()
    const { onNewAgent } = renderMenu()
    await user.click(screen.getByRole("button", { name: "Agent conversation" }))
    expect(onNewAgent).toHaveBeenCalled()
    expect(screen.queryByRole("menuitem")).toBeNull()
    expect(createFolderResource).toHaveBeenCalledWith({
      folderId: 7,
      kind: "conversation",
      onCreateConversation: expect.any(Function),
    })
  })

  it("does not expose a terminal chooser", () => {
    renderMenu()
    expect(screen.queryByText("Terminal")).toBeNull()
    expect(screen.queryByRole("menu")).toBeNull()
  })
})
