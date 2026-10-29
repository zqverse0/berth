import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { ClassifierSettings } from "./classifier-settings"

const getClassifierSettings = vi.fn()
const saveClassifierConfig = vi.fn()
const revealItemInDir = vi.fn()
vi.mock("@/knowledge/api/knowledge-client", () => ({
  getClassifierSettings: () => getClassifierSettings(),
  saveClassifierConfig: (config: unknown) => saveClassifierConfig(config),
}))
vi.mock("@/lib/platform", () => ({
  revealItemInDir: (path: string) => revealItemInDir(path),
}))

const config = {
  enabled: false,
  approval: { question: "aq", true: "at", false: "af", threshold: 0.85 },
  categories: [
    {
      id: "pitfall",
      name: "坑",
      description: "带原因或修法的具体报错",
      enabled: true,
      question: "q",
      true: "t",
      false: "f",
      threshold: 0.9,
      source: "assistant",
    },
  ],
}
const path = "/home/u/.berth/classifier.json"

const renderSettings = () =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ClassifierSettings />
    </NextIntlClientProvider>
  )

describe("ClassifierSettings", () => {
  it("saves the main switch and a category switch, and reveals the file", async () => {
    getClassifierSettings.mockResolvedValue({ config, error: null, path })
    saveClassifierConfig.mockImplementation(async (next) => next)
    revealItemInDir.mockResolvedValue(undefined)
    renderSettings()
    expect(
      await screen.findByText("带原因或修法的具体报错")
    ).toBeInTheDocument()
    // 问法、阈值不在页面上。
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("switch", { name: "坑" }))
    await waitFor(() =>
      expect(
        saveClassifierConfig.mock.lastCall?.[0].categories[0].enabled
      ).toBe(false)
    )
    fireEvent.click(screen.getByRole("button", { name: "Show file" }))
    expect(revealItemInDir).toHaveBeenCalledWith(path)
  })

  it("explains an invalid file instead of showing the form", async () => {
    getClassifierSettings.mockResolvedValue({
      config: null,
      error: "expected value at line 1",
      path,
    })
    renderSettings()
    expect(
      await screen.findByText(/expected value at line 1/)
    ).toBeInTheDocument()
    expect(screen.queryByRole("switch")).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Show file" })
    ).toBeInTheDocument()
  })
})
