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
