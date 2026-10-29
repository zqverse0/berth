import type { NextConfig } from "next"
import createNextIntlPlugin from "next-intl/plugin"

// Tauri/IDE 可能从仓库父目录启动 Next；构建根必须固定在本应用目录，
// 否则 Turbopack 会从父目录解析依赖并把 Tailwind 扫描到整个工作区。
const projectRoot = __dirname
const isProd = process.env.NODE_ENV === "production"
const internalHost = process.env.TAURI_DEV_HOST || "localhost"
const withNextIntl = createNextIntlPlugin({
  requestConfig: "./src/i18n/request.ts",
  experimental: {
    messages: {
      path: "./src/i18n/messages",
      format: "json",
      locales: ["en", "zh-CN"],
      precompile: true,
    },
  },
})

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: projectRoot,
  },
  experimental: {
    // S4: Tree-shake barrel re-exports from icon/UI libraries so only the
    // actually-imported icons/components end up in each chunk.
    optimizePackageImports: [
      "lucide-react",
      "radix-ui",
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/search",
    ],
  },
  // Only force an absolute asset host for Tauri webview dev (cross-origin load
  // from the desktop shell). In plain browser / reverse-proxy dev (e.g. :3090 →
  // Next :3000), leave assets relative so fonts/CSS stay same-origin and avoid CORS.
  assetPrefix:
    isProd || !process.env.TAURI_DEV_HOST
      ? undefined
      : `http://${internalHost}:3000`,
}

export default withNextIntl(nextConfig)
