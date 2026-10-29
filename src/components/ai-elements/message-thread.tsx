"use client"

import type { ComponentProps } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ArrowDownIcon } from "lucide-react"
import { useCallback } from "react"
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom"

export type MessageThreadProps = ComponentProps<typeof StickToBottom>

export const MessageThread = ({ className, ...props }: MessageThreadProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="instant"
    resize="smooth"
    role="log"
    {...props}
  />
)

export type MessageThreadContentProps = ComponentProps<
  typeof StickToBottom.Content
>

export const MessageThreadContent = ({
  className,
  ...props
}: MessageThreadContentProps) => (
  <StickToBottom.Content
    className={cn("flex flex-col gap-8 p-4", className)}
    {...props}
  />
)

export type MessageThreadScrollButtonProps = ComponentProps<typeof Button>

export const MessageThreadScrollButton = ({
  className,
  ...props
}: MessageThreadScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom()
  }, [scrollToBottom])

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full bg-background/90 hover:bg-muted/90",
          className
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  )
}

export interface ThreadMessage {
  role: "user" | "assistant" | "system" | "data" | "tool"
  content: string
}
