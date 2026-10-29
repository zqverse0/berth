"use client"

import { useEffect, useState, type ComponentType, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"

/**
 * 按需加载的 workbench 面板页面宿主。
 *
 * 手写 load+retry 而非 React.lazy：lazy 的 rejected promise 被永久缓存，
 * remount 也不会重试；这里每次重试重新发起 import，配合"重试"按钮
 * 满足加载失败可实际恢复的要求。动态 import 而非 next/dynamic 的原因
 * 与 file-workspace-panel 相同：静态导出下后者的 chunk 会被注入
 * workspace.html 的 script 清单，失去懒加载意义。
 */
export function LazyPage<P>({
  load,
  children,
}: {
  load: () => Promise<{ default: ComponentType<P> }>
  children: (Page: ComponentType<P>) => ReactNode
}) {
  const t = useTranslations("Workbench.lazyPage")
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    Page?: ComponentType<P>
    error?: unknown
  }>({})

  // 异步 resolve 后回写状态属于 effect 内合法的异步 setState；同步的
  // `setState({})` 重置仅在 load/attempt 变化时需要。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    let cancelled = false
    setState({})
    load().then(
      (m) => {
        if (!cancelled) setState({ Page: m.default })
      },
      (error) => {
        if (!cancelled) setState({ error })
      }
    )
    return () => {
      cancelled = true
    }
  }, [load, attempt])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (state.error !== undefined) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
        <p>{t("error")}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => setAttempt((n) => n + 1)}
        >
          {t("retry")}
        </Button>
      </div>
    )
  }

  if (state.Page === undefined) {
    return (
      <div
        className="h-full w-full animate-pulse bg-card/40"
        aria-hidden="true"
      />
    )
  }

  return <>{children(state.Page)}</>
}
