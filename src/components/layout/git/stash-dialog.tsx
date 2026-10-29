"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { gitStashPush } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"

interface StashDialogProps {
  open: boolean
  folderPath: string
  onClose: () => void
  onStashed: () => void
}

interface StashFormContentProps {
  folderPath: string
  onCancel: () => void
  onStashed: () => void
  showDescription?: boolean
}

function StashFormContent({
  folderPath,
  onCancel,
  onStashed,
  showDescription = false,
}: StashFormContentProps) {
  const t = useTranslations("Folder.branchDropdown.stashDialog")
  const [message, setMessage] = useState("")
  const [keepIndex, setKeepIndex] = useState(false)
  const [loading, setLoading] = useState(false)

  function handleClose() {
    if (loading) return
    setMessage("")
    setKeepIndex(false)
    onCancel()
  }

  async function handleStash() {
    setLoading(true)
    try {
      await gitStashPush(folderPath, message.trim() || undefined, keepIndex)
      toast.success(t("success"))
      setMessage("")
      setKeepIndex(false)
      onStashed()
      onCancel()
    } catch (error) {
      toast.error(t("error"), { description: toErrorMessage(error) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      {showDescription && (
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      )}
      <div className="space-y-2">
        <Label htmlFor="stash-message">{t("messageLabel")}</Label>
        <Input
          id="stash-message"
          placeholder={t("messagePlaceholder")}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !loading) void handleStash()
          }}
          disabled={loading}
          autoFocus
        />
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="keep-index"
          checked={keepIndex}
          onCheckedChange={setKeepIndex}
          disabled={loading}
        />
        <Label htmlFor="keep-index">{t("keepIndex")}</Label>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleClose}
          disabled={loading}
        >
          {t("cancel")}
        </Button>
        <Button size="sm" onClick={() => void handleStash()} disabled={loading}>
          {loading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {t("stash")}
        </Button>
      </div>
    </div>
  )
}

export function StashDialog({
  open,
  folderPath,
  onClose,
  onStashed,
}: StashDialogProps) {
  const t = useTranslations("Folder.branchDropdown.stashDialog")

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {open && (
          <StashFormContent
            folderPath={folderPath}
            onCancel={onClose}
            onStashed={onStashed}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
