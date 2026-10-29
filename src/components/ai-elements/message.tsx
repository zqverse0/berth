"use client"

import type { ComponentProps, HTMLAttributes, ReactElement } from "react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { createContext, memo, useCallback, useMemo, useState } from "react"
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
} from "streamdown"
import { markdownLinkComponents } from "./markdown-link"
import { rehypePluginsAllowingAppLinks } from "./rehype-allow-app-links"
import { remarkRewriteFileUriLinks } from "./remark-file-uri-links"
import { remarkInlineCodePaths } from "./remark-inline-code-paths"
import { MARKDOWN_CONTROLS, useStreamdownPlugins } from "./streamdown-plugins"

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "system" | "user" | "assistant"
}

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-2",
      from === "user"
        ? "is-user ml-auto justify-end max-w-[88%]"
        : "is-assistant",
      className
    )}
    {...props}
  />
)

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex min-w-0 flex-col gap-2 overflow-hidden text-sm",
      // `ws-msg-secondary` pairs with the user bubble's `bg-secondary`: with
      // a workspace background image on it turns the bubble translucent + frosted
      // with a hairline ring (fixed `--ws-msg-alpha` + backdrop blur — see
      // globals.css, scoped to `.is-user`) so it stays legible over a busy
      // background. Off / assistant messages: inert (no base rule, no `.is-user`
      // ancestor).
      "group-[.is-user]:ml-auto group-[.is-user]:w-fit group-[.is-user]:max-w-full group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground ws-msg-secondary",
      "group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
)

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string
  label?: string
}

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  )

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return button
}

interface MessageBranchContextType {
  currentBranch: number
  totalBranches: number
  goToPrevious: () => void
  goToNext: () => void
  branches: ReactElement[]
  setBranches: (branches: ReactElement[]) => void
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
)

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number
  onBranchChange?: (branchIndex: number) => void
}

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch)
  const [branches, setBranches] = useState<ReactElement[]>([])

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch)
      onBranchChange?.(newBranch)
    },
    [onBranchChange]
  )

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1
    handleBranchChange(newBranch)
  }, [currentBranch, branches.length, handleBranchChange])

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0
    handleBranchChange(newBranch)
  }, [currentBranch, branches.length, handleBranchChange])

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious]
  )

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  )
}

// MessageResponse renders ASSISTANT / agent Markdown. User messages no longer
// use it — they render as plain text + reference badges via PlainTextWithBadges
// (see message/plain-text-with-badges.tsx) — so the former user-only `softBreaks`
// / `/slash`-badging hooks were removed.
export type MessageResponseProps = ComponentProps<typeof Streamdown>

import { normalizeMathDelimiters } from "@/lib/files/math-delimiters"
export { normalizeMathDelimiters }

const remarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  remarkRewriteFileUriLinks,
  remarkInlineCodePaths,
]

// Streamdown's default rehype pipeline strips `berth://` reference hrefs in
// sanitization (rendering them as "[blocked]"); re-derive it so they survive to
// MarkdownLink → ReferenceBadge. See rehype-allow-app-links for the full rationale.
const rehypePlugins = rehypePluginsAllowingAppLinks(defaultRehypePlugins)

function MessageResponseImpl({
  className,
  children,
  ...props
}: MessageResponseProps) {
  const normalized = useMemo(
    () =>
      typeof children === "string"
        ? normalizeMathDelimiters(children)
        : children,
    [children]
  )
  const plugins = useStreamdownPlugins(
    typeof normalized === "string" ? normalized : undefined
  )

  return (
    <Streamdown
      className={cn(
        // 排版在 globals.css 的 `.md-prose`，与文件编辑器 live preview 同一套变量。
        "md-prose size-full",
        className
      )}
      plugins={plugins}
      controls={MARKDOWN_CONTROLS}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      {...props}
      // Merge after spreading props so a caller can still override other
      // elements, but the link icon + safety routing on `a` always wins.
      components={{ ...props.components, ...markdownLinkComponents }}
    >
      {normalized}
    </Streamdown>
  )
}

export const MessageResponse = memo(
  MessageResponseImpl,
  (prevProps, nextProps) => prevProps.children === nextProps.children
)

MessageResponse.displayName = "MessageResponse"
