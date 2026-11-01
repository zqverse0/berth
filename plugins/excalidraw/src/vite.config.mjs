// `pnpm build:plugins` 用它把画板页面构建到 ../page/（不进 git），字体随包拷到 page/fonts/。
import { cpSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"

const here = dirname(fileURLToPath(import.meta.url))
const fonts = join(
  dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw")),
  "fonts"
)

const config = {
  root: here,
  base: "./",
  plugins: [
    react(),
    {
      name: "excalidraw-fonts",
      closeBundle() {
        cpSync(fonts, join(here, "../page/fonts"), { recursive: true })
      },
    },
  ],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  build: {
    outDir: "../page",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
  },
}

export default config
