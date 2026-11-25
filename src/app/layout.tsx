import type { Metadata, Viewport } from "next"
import "./globals.css"
import "overlayscrollbars/overlayscrollbars.css"
import { NextIntlClientProvider } from "next-intl"
import { AppI18nProvider } from "@/components/i18n-provider"
import { getMessagesForLocale } from "@/i18n/messages"
import { resolveRequestLocale } from "@/i18n/resolve-request-locale"
import { ThemeProvider } from "@/components/theme-provider"
import { toIntlLocale } from "@/lib/i18n"
import { APPEARANCE_INIT_SCRIPT } from "@/lib/appearance-script"
import { AppearanceProvider } from "@/components/appearance-provider"
import { ClipboardFallbackInit } from "@/components/clipboard-fallback-init"
import { WindowResizeGrips } from "@/components/layout/chrome/window-resize-grips"

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
}

export const metadata: Metadata = {
  title: "berth",
  description: "AI Coding Agent Conversation Manager",
  // 远程浏览器「添加到主屏幕」后全屏打开，不带浏览器外壳；桌面窗口不读这些。
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "berth", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/icon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon.png", sizes: "512x512", type: "image/png" },
    ],
    apple: { url: "/icon-128x128.png", sizes: "128x128", type: "image/png" },
  },
}

// ponytail: 上游 tauri-runtime-cef（rev 17a5273）的 `csp_inject_initialization_scripts_hashes`
// 会无视 `dangerousDisableAssetCspModification` 与已有的 `'unsafe-inline'`，强行往
// `Content-Security-Policy` 响应头的 `script-src` 追加初始化脚本的 `'sha256-...'` 哈希，
// 导致 Chromium 作废 `'unsafe-inline'` 并拦掉 Next.js 静态导出的内联水合脚本（正式包卡在启动页）。
// 因此在 tauri.conf.json 置 `security.csp = null`，改由生产 HTML 的 `<meta>` 声明同策略；
// `connect-src` 放开 `ws: wss:` 以兼容远程浏览器（LAN/Tailscale 非 localhost Origin）。
// 待上游修复后迁回 tauri.conf.json。
const APP_CSP = [
  "default-src 'self' ipc: http://ipc.localhost http://localhost:*",
  "script-src 'self' 'unsafe-inline' blob: http://localhost:*",
  "style-src 'self' 'unsafe-inline' http://localhost:*",
  "font-src 'self' data: http://localhost:*",
  "img-src 'self' asset: http://asset.localhost data: blob: https: http://localhost:*",
  "connect-src 'self' ipc: http://ipc.localhost https://github.com https://api.github.com https://*.githubusercontent.com http://localhost:* ws: wss:",
  "frame-src 'self' https: http://localhost:* berth-plugin: http://berth-plugin.localhost",
].join("; ")

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const appLocale = await resolveRequestLocale()
  const initialLocale = toIntlLocale(appLocale)
  const initialMessages = await getMessagesForLocale(appLocale)

  return (
    <html lang={initialLocale} suppressHydrationWarning>
      <head>
        {process.env.NODE_ENV === "production" && (
          <meta httpEquiv="Content-Security-Policy" content={APP_CSP} />
        )}
      </head>
      <body>
        {/* CSS-only dark background: applies before JS executes, preventing white flash in dark mode */}
        <style
          dangerouslySetInnerHTML={{
            __html: `@media(prefers-color-scheme:dark){html:not(.light){background-color:#09090b;color-scheme:dark}}`,
          }}
        />
        {/* Apply appearance preferences (theme color + zoom + dark class) before first paint to prevent FOUC */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_INIT_SCRIPT }} />
        <NextIntlClientProvider
          locale={initialLocale}
          messages={initialMessages}
        >
          <AppI18nProvider
            initialLocale={initialLocale}
            initialMessages={initialMessages}
          >
            <ThemeProvider
              attribute="class"
              defaultTheme="system"
              enableSystem
              disableTransitionOnChange
            >
              <AppearanceProvider>
                <ClipboardFallbackInit />
                <WindowResizeGrips />
                {children}
              </AppearanceProvider>
            </ThemeProvider>
          </AppI18nProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
