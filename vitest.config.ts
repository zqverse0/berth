import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "node:path"

const ligaturesTestSeam = {
  name: "terminal-ligatures-test-seam",
  enforce: "pre" as const,
  resolveId(source: string) {
    return source === "@xterm/addon-ligatures"
      ? "\0terminal-ligatures-test-seam"
      : null
  },
  load(id: string) {
    if (id !== "\0terminal-ligatures-test-seam") return null
    return "export class LigaturesAddon { dispose() {} }"
  },
}

export default defineConfig({
  plugins: [ligaturesTestSeam, react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "out", ".next", "src-tauri"],
    // 该包的 ESM 用无扩展名相对导入，Node 原生加载失败；交给 vite 转换
    server: { deps: { inline: ["@atomic-editor/editor"] } },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "node_modules/",
        ".next/**",
        "out/**",
        "src/test-setup.ts",
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/*.config.*",
        "**/*.d.ts",
        "src-tauri/**",
      ],
    },
  },
})
