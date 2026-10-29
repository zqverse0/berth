import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { tags } from "@lezer/highlight"
import { EditorState, Prec, type Extension } from "@codemirror/state"
import { vim } from "@replit/codemirror-vim"
import { openSearchPanel, search, searchKeymap } from "@codemirror/search"
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view"
import type { EditorAppearance, EditorCapabilities } from "./contracts"

export const openEditorSearch = openSearchPanel

const workspaceHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  {
    tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword],
    color: "var(--primary)",
  },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--chart-2)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--chart-3)" },
  {
    tag: [tags.typeName, tags.className, tags.namespace],
    color: "var(--chart-4)",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--chart-5)",
  },
  { tag: [tags.heading, tags.strong], fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  {
    tag: [tags.link, tags.url],
    color: "var(--primary)",
    textDecoration: "underline",
  },
  { tag: tags.invalid, color: "var(--destructive)" },
])

export function createBaseExtensions(): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    syntaxHighlighting(workspaceHighlightStyle),
  ]
}

export function createAppearanceExtensions(
  appearance: EditorAppearance
): Extension[] {
  const extensions: Extension[] = [
    EditorView.theme({
      "&": {
        height: "100%",
        backgroundColor: "transparent",
        color: "var(--foreground)",
        fontFamily: appearance.fontFamily,
        fontSize: `${appearance.fontSize}px`,
        fontVariantLigatures: appearance.fontLigatures ? "normal" : "none",
      },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: "inherit",
      },
      ".cm-content": {
        caretColor: "var(--foreground)",
        padding: "8px 0",
      },
      // paddingInline 而非简写：不覆盖 markdown live preview 标题行的 padding-top
      ".cm-line": { paddingInline: "10px" },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--foreground)",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent)",
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "var(--muted-foreground)",
        border: "none",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent)",
      },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
        {
          backgroundColor:
            "color-mix(in srgb, var(--primary) 30%, transparent) !important",
        },
      ".cm-panels": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
      },
      ".cm-searchMatch": {
        backgroundColor: "color-mix(in srgb, var(--warning) 45%, transparent)",
      },
      "&.cm-focused": { outline: "none" },
    }),
  ]
  if (appearance.wordWrap) extensions.push(EditorView.lineWrapping)
  return extensions
}

export function createCapabilityExtensions(
  capabilities: EditorCapabilities
): Extension[] {
  const searchEnabled = capabilities.search !== false
  const extensions: Extension[] = [
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...(searchEnabled ? searchKeymap : []),
    ]),
  ]
  if (capabilities.lineNumbers !== false) {
    extensions.push(lineNumbers(), highlightActiveLineGutter())
  }
  if (searchEnabled) extensions.push(search())
  // Vim 键位须先于其他 keymap
  if (capabilities.vim && !capabilities.readOnly) {
    extensions.unshift(Prec.highest(vim({ status: true })))
  }
  if (capabilities.readOnly) {
    extensions.push(
      EditorState.readOnly.of(true),
      EditorView.editable.of(false)
    )
  }
  return extensions
}
