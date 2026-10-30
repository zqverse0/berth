import { describe, expect, it } from "vitest"
import { localizedTitle, normalizeView } from "./plugin-views"

describe("normalizeView", () => {
  it("keeps valid items and actions, drops malformed ones", () => {
    const view = normalizeView({
      type: "list",
      filters: [{ id: "a", title: "A" }, { id: "" }],
      searchable: true,
      items: [
        {
          id: "x",
          title: "X",
          accessories: [{ text: "★ 1" }, { text: "" }],
          actions: [
            { type: "open-url", title: "Open", url: "https://x.dev" },
            { type: "open-url", title: "Bad", url: "javascript:alert(1)" },
            { type: "launch-rocket", title: "?" },
            { type: "script", title: "Star", script: "s.js", refresh: true },
          ],
        },
        { id: "", title: "no id" },
        null,
      ],
    })
    expect(view).toEqual({
      type: "list",
      filters: [{ id: "a", title: "A" }],
      searchable: true,
      empty: undefined,
      items: [
        {
          id: "x",
          title: "X",
          subtitle: undefined,
          icon: undefined,
          accessories: [{ text: "★ 1", tooltip: undefined }],
          actions: [
            { type: "open-url", title: "Open", url: "https://x.dev" },
            { type: "script", title: "Star", script: "s.js", refresh: true },
          ],
        },
      ],
    })
  })

  it("keeps known icons, inline modes, dropdown and note; drops the rest", () => {
    const view = normalizeView({
      type: "list",
      dropdown: { items: [{ id: "daily", title: "Today" }, { id: "x" }] },
      note: "Updated just now",
      items: [
        {
          id: "r",
          title: "R",
          accessories: [
            { text: "12", icon: "star" },
            { text: "3", icon: "rocket" },
          ],
          actions: [
            { type: "copy", title: "C", text: "t", icon: "copy" },
            {
              type: "script",
              title: "Star",
              script: "s.js",
              icon: "star-filled",
              inline: "always",
            },
            { type: "copy", title: "D", text: "t", inline: "sometimes" },
          ],
        },
      ],
    })
    if (view.type !== "list") throw new Error("expected list")
    expect(view.dropdown).toEqual({ items: [{ id: "daily", title: "Today" }] })
    expect(view.note).toBe("Updated just now")
    const [item] = view.items
    expect(item.accessories?.map((a) => a.icon)).toEqual(["star", undefined])
    expect(item.actions?.map((a) => [a.icon, a.inline])).toEqual([
      ["copy", undefined],
      ["star-filled", "always"],
      [undefined, undefined],
    ])
  })

  it("accepts detail and rejects unknown view types", () => {
    expect(normalizeView({ type: "detail", markdown: "# Hi" })).toMatchObject({
      type: "detail",
      markdown: "# Hi",
    })
    expect(() => normalizeView({ type: "canvas" })).toThrow("unsupported")
  })
})

describe("localizedTitle", () => {
  it("picks the locale, then en, then the first", () => {
    expect(localizedTitle({ en: "Discover", "zh-CN": "发现" }, "zh-CN")).toBe(
      "发现"
    )
    expect(localizedTitle({ en: "Discover" }, "ja")).toBe("Discover")
    expect(localizedTitle({ fr: "Découvrir" }, "ja")).toBe("Découvrir")
    expect(localizedTitle("README", "zh-CN")).toBe("README")
  })
})
