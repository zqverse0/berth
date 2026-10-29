import { useTranslations } from "next-intl"

/** 懒加载 chunk 未就绪时的占位。 */
export const viewerFallback = (
  <div className="h-full w-full animate-pulse bg-card/40" aria-hidden="true" />
)

/** 冷加载：内容还没有，整块显示加载中。 */
export function ViewerLoading({ label }: { label?: string }) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  return (
    <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
      {label ?? t("loading")}
    </div>
  )
}

/** 刷新：旧内容仍可见，右上角浮一个加载中。 */
export function ViewerLoadingBadge() {
  const t = useTranslations("Folder.fileWorkspacePanel")
  return (
    <div className="absolute top-2 right-3 z-10 rounded-md bg-background/70 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
      {t("loading")}
    </div>
  )
}
