import type { ITheme } from "@xterm/xterm"

/**
 * Shared low-saturation colors for the terminal and CodeMirror diff decorations.
 * Keeping the palette here prevents the two reading/agent surfaces from
 * drifting when the Berth visual language changes again.
 */
export const ZED_TERMINAL_THEMES = {
  dark: {
    background: "#181818",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    cursorAccent: "#181818",
    selectionBackground: "#383838",
    black: "#181818",
    red: "#d17b7b",
    green: "#8fb58f",
    yellow: "#c6ad70",
    blue: "#82a6c6",
    magenta: "#ae92c5",
    cyan: "#82b3b3",
    white: "#d4d4d4",
    brightBlack: "#737373",
    brightRed: "#e09a9a",
    brightGreen: "#afd0af",
    brightYellow: "#dbc78f",
    brightBlue: "#a6c4dc",
    brightMagenta: "#c8b2d7",
    brightCyan: "#acd1d1",
    brightWhite: "#f0f0f0",
  } satisfies ITheme,
  light: {
    background: "#fafafa",
    foreground: "#2e2e2e",
    cursor: "#2e2e2e",
    cursorAccent: "#fafafa",
    selectionBackground: "#d9e2ee",
    black: "#2e2e2e",
    red: "#b85c5c",
    green: "#4f8a5c",
    yellow: "#9a7b28",
    blue: "#4b6f9e",
    magenta: "#805f99",
    cyan: "#397f83",
    white: "#e5e5e5",
    brightBlack: "#8a8a8a",
    brightRed: "#c97878",
    brightGreen: "#72a67b",
    brightYellow: "#b39a4c",
    brightBlue: "#708fb7",
    brightMagenta: "#a080b7",
    brightCyan: "#63a3a6",
    brightWhite: "#ffffff",
  } satisfies ITheme,
}
