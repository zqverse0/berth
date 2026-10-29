"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { enableBerth } from "@/lib/agent/berth-project"

/** 项目未启用 Berth 时的「启用 Berth」入口；`.berth/` 只从这里或 `berth project init` 创建。 */
export function EnableBerthNotice({
  folderId,
  onEnabled,
}: {
  folderId: number
  onEnabled: () => void
}) {
  const t = useTranslations("BerthTasks")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const enable = async () => {
    setBusy(true)
    setError(null)
    try {
      const response = await enableBerth(folderId)
      if (response.ok) onEnabled()
      else setError(response.error.message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 text-sm">
      <Button size="sm" disabled={busy} onClick={() => void enable()}>
        {busy ? t("initializing") : t("initialize")}
      </Button>
      {error ? (
        <p className="break-all font-mono text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  )
}
