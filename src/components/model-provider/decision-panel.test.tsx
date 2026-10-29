import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { DecisionPanel } from "./decision-panel"

const evaluateDecision = vi.hoisted(() => vi.fn())
const saveDecisionSettings = vi.hoisted(() => vi.fn())

vi.mock("@/lib/model-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/model-provider")>()),
  evaluateDecision: (...args: unknown[]) => evaluateDecision(...args),
  getDecisionSettings: () =>
    Promise.resolve({
      settings: { provider: "", model: "" },
      error: null,
      profiles: [],
    }),
  saveDecisionSettings: (settings: unknown) => saveDecisionSettings(settings),
}))

describe("DecisionPanel", () => {
  it("sends a typed choice question and shows the probabilities", async () => {
    evaluateDecision.mockResolvedValue({
      model: "jev-1.13.0",
      answers: {
        department: {
          type: "choice",
          choice: "billing",
          confidence: 0.82,
          probabilities: { billing: 0.85, technical: 0.15 },
        },
      },
    })
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <DecisionPanel
          providerId={9}
          providerName="TypeSafe Jev"
          model="jev-latest"
          open
          onOpenChange={() => {}}
        />
      </NextIntlClientProvider>
    )

    const run = screen.getByRole("button", { name: "Run" })
    expect(run).toBeDisabled()

    await user.type(
      screen.getByLabelText("Content to judge"),
      "Payouts failing"
    )
    await user.type(
      screen.getByLabelText("Question name (identifier)"),
      "department"
    )
    await user.type(screen.getByLabelText(/^Instructions/), "Which team?")
    const [first, second] = screen.getAllByLabelText("Option")
    const [firstWhen, secondWhen] = screen.getAllByLabelText("Criterion")
    await user.type(first, "billing")
    await user.type(firstWhen, "Payments")
    await user.type(second, "technical")
    await user.type(secondWhen, "Bugs")
    expect(run).toBeEnabled()
    await user.click(run)

    expect(evaluateDecision).toHaveBeenCalledWith({
      providerId: 9,
      model: "jev-latest",
      state: "Payouts failing",
      questions: {
        department: {
          type: "choice",
          instructions: "Which team?",
          criteria: { billing: "Payments", technical: "Bugs" },
        },
      },
    })
    expect(await screen.findByText("85%")).toBeInTheDocument()
    expect(screen.getByText("Confidence 82%")).toBeInTheDocument()
    expect(within(document.body).getByText("15%")).toBeInTheDocument()
  })

  it("sets this profile and model as Berth's decision model", async () => {
    saveDecisionSettings.mockImplementation(async (next) => next)
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <DecisionPanel
          providerId={9}
          providerName="TypeSafe Jev"
          model="jev-latest"
          open
          onOpenChange={() => {}}
        />
      </NextIntlClientProvider>
    )
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Use as Berth's decision model",
      })
    )
    await waitFor(() =>
      expect(saveDecisionSettings).toHaveBeenCalledWith({
        provider: "TypeSafe Jev",
        model: "jev-latest",
      })
    )
    expect(
      await screen.findByText("This is Berth's decision model")
    ).toBeInTheDocument()
  })
})
