import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { LaunchManifest } from "@/lib/agent/berth-group"
import { LaunchManifestView, manifestRows } from "./launch-manifest"

vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({ openFilePreview: vi.fn() }),
}))

const manifest: LaunchManifest = {
  id: "1-1",
  agent: "demo",
  target: "v1.x",
  startedAt: 1,
  cwd: "/p",
  inputs: {},
  expert: { id: "dev", name: "Dev" },
  provider: null,
  prompt: { file: "/h/prompts/dev.md", hash: "sha256:abc", text: "be terse" },
  brief: 0,
  declared: [],
  report: [
    { kind: "prompt", id: "dev", status: "applied" },
    { kind: "skills", id: "s1", status: "skipped", reason: "no skills" },
    { kind: "future", id: "x", status: "brand-new" },
  ],
  unhandled: [{ kind: "demo", id: "a" }],
  plan: { note: "legacy", empty: [] },
}

describe("manifestRows", () => {
  it("puts differences between declared and actual first", () => {
    expect(manifestRows(manifest).map((row) => row.status)).toEqual([
      "unhandled",
      "skipped",
      "applied",
      "brand-new",
    ])
  })
})

describe("LaunchManifestView", () => {
  it("renders any asset kind generically, with unknown statuses as-is", () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <LaunchManifestView manifest={manifest} />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("demo/a")).toBeTruthy()
    expect(screen.getByText("Unhandled")).toBeTruthy()
    expect(screen.getByText("no skills")).toBeTruthy()
    expect(screen.getByText("brand-new")).toBeTruthy()
    expect(screen.getByText("legacy")).toBeTruthy()
    expect(container.querySelector("li")?.dataset.status).toBe("unhandled")
  })

  it("shows unverified when the plugin has no inspect hook, and declared-but-missing first when it does", () => {
    const { rerender, container } = render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <LaunchManifestView
          manifest={{ ...manifest, report: [], unhandled: [] }}
          inspection={{
            state: "done",
            result: { implemented: false, items: [] },
          }}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByText(en.LaunchManifest.unverified)).toBeTruthy()
    rerender(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <LaunchManifestView
          manifest={{ ...manifest, report: [], unhandled: [] }}
          inspection={{
            state: "done",
            result: {
              implemented: true,
              items: [
                { kind: "mcp", id: "ok", status: "applied" },
                { kind: "mcp", id: "gone", status: "skipped", reason: "lost" },
              ],
            },
          }}
        />
      </NextIntlClientProvider>
    )
    expect(screen.queryByText(en.LaunchManifest.unverified)).toBeNull()
    expect(container.querySelector("li")?.textContent).toContain("mcp/gone")
  })

  it("shows an empty state for launches with nothing to report", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <LaunchManifestView
          manifest={{
            ...manifest,
            report: [],
            unhandled: [],
            prompt: null,
            plan: null,
          }}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByText(en.LaunchManifest.noAssets)).toBeTruthy()
  })
})
