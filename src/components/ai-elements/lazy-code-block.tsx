"use client"

import dynamic from "next/dynamic"

import type { CodeBlockProps } from "./code-block"

/**
 * Route-level lazy boundary for syntax highlighting.
 *
 * Keeping this wrapper separate prevents Shiki and its language/theme payloads
 * from being emitted as eager workspace scripts merely because message/tool
 * renderers support code blocks.
 */
export const CodeBlock = dynamic<CodeBlockProps>(
  () => import("./code-block").then((module) => module.CodeBlock),
  { ssr: false }
)
