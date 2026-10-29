"use client"

import { memo } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { SessionAnalysisView } from "@/sessions/components/session-analysis-view"
import {
  useTranscriptDetail,
  useTranscriptLiveSync,
} from "@/sessions/transcript-view-store"
import type { TranscriptWorkspaceTab } from "@/lib/files/file-workspace-tab"

/** 持久化会话文件标签：读取详情后交给正文视图。 */
export const TranscriptReader = memo(function TranscriptReader({
  tab,
}: {
  tab: TranscriptWorkspaceTab
}) {
  const t = useTranslations("Folder.chat.messageList")
  const { detail, error, reload } = useTranscriptDetail(tab.conversationId)
  useTranscriptLiveSync(tab.conversationId)

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={reload}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t("errorActionReload")}
        </Button>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 bg-background ws-transparent-bg">
      <SessionAnalysisView
        conversationId={tab.conversationId}
        detail={detail}
      />
    </div>
  )
})
