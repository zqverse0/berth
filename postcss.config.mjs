import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = dirname(fileURLToPath(import.meta.url))

const config = {
  plugins: {
    "@tailwindcss/postcss": {
      // 不要把启动命令的 cwd 当成 Tailwind 的扫描根目录。
      base: projectRoot,
    },
  },
}

export default config
