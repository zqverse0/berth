import { normalizeSlashPath } from "@/lib/files/file-path-display"

export interface ParsedFileReference {
  /** 原始选中文本 */
  raw: string
  /** 纯净文件路径（保留完整相对路径或绝对路径，剥离行号列号及外围符号） */
  path: string
  /** 解析出的行号（若有） */
  line?: number
  /** 解析出的列号（若有） */
  column?: number
  /** 是否为绝对路径或 ~ 路径 */
  isAbsolute: boolean
}

/**
 * 解析选中文本中的文件引用：
 * 1. 自动剥离外围引号 (`"`, `'`, `` ` ``)、括号 (`( )`, `[ ]`, `< >`)；
 * 2. 剥离 `file://` 协议头；
 * 3. 剥离并解析末尾行号/列号（支持 `:12:34`、`:12`、`#L12`、`(12,34)` 等形式）；
 * 4. 完整保留所有相对路径与绝对路径层级。
 */
export function parseFileReference(
  rawText: string
): ParsedFileReference | null {
  const trimmed = rawText.trim()
  if (!trimmed || trimmed.length > 500) return null
  // 必须是单行
  if (/[\n\r]/.test(trimmed)) return null

  // 1. 去除包裹字符
  let cleaned = trimmed
    .replace(/^["'`([{<]+/, "")
    .replace(/["'`)\]}>,;]+$/, "")
    .trim()

  // 2. 剥离调用栈前缀如 "at Object.run (src/app.ts:42)" 或 "at src/app.ts:42"
  cleaned = cleaned
    .replace(/^at\s+(?:[a-zA-Z0-9_$.<>]+\s+\()?/, "")
    .replace(/\)$/, "")
    .trim()

  // 3. 剥离 file:// 协议头
  if (cleaned.startsWith("file://")) {
    cleaned = cleaned.slice(7)
  }

  // 4. 忽略网络 URL（http, https, ws, mailto 等）
  if (/^(?:https?|wss?|mailto|ftp):\/\//i.test(cleaned)) {
    return null
  }

  // 5. 提取行号与列号
  let line: number | undefined
  let column: number | undefined

  // 格式 A: path:123:456 或 path:123
  const colonMatch = cleaned.match(/:(\d+)(?::(\d+))?$/)
  if (colonMatch) {
    line = parseInt(colonMatch[1], 10)
    if (colonMatch[2]) {
      column = parseInt(colonMatch[2], 10)
    }
    cleaned = cleaned.slice(0, colonMatch.index)
  } else {
    // 格式 B: path#L123 或 path#L123-L150
    const hashMatch = cleaned.match(/#L(\d+)(?:-L\d+)?$/i)
    if (hashMatch) {
      line = parseInt(hashMatch[1], 10)
      cleaned = cleaned.slice(0, hashMatch.index)
    } else {
      // 格式 C: path(123, 456) 或 path(123)
      const parenMatch = cleaned.match(/\((\d+)(?:,\s*(\d+))?\)$/)
      if (parenMatch) {
        line = parseInt(parenMatch[1], 10)
        if (parenMatch[2]) {
          column = parseInt(parenMatch[2], 10)
        }
        cleaned = cleaned.slice(0, parenMatch.index)
      }
    }
  }

  cleaned = cleaned.trim()
  if (!cleaned) return null

  // 路径内部不允许包含连续空白
  if (/\s{2,}/.test(cleaned)) return null

  const normalized = normalizeSlashPath(cleaned)
  const isAbs =
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    /^[a-zA-Z]:\//.test(normalized)

  return {
    raw: rawText,
    path: isAbs ? normalized : normalized.replace(/^\.\/+/, ""),
    line,
    column,
    isAbsolute: isAbs,
  }
}

/**
 * 判断选中文本是否“像”一个文件/目录引用，值得发起一次后端解析。
 * 这是零成本的同步预过滤：含路径分隔符、带常见扩展名、或绝对/~ 路径才
 * 放行；普通单词、属性访问（`user.name`）、小数不会触发 IPC。最终裁决
 * 仍在后端——这里放行的文本若磁盘上无匹配，照样不显示按钮。
 */
export function looksLikeFileReference(text: string): boolean {
  const parsed = parseFileReference(text)
  if (!parsed) return false
  if (parsed.isAbsolute) return true
  if (parsed.path.includes("/")) return true
  // 扩展名启发：点后是 1-8 位纯字母（排除 `user.name`、`3.14159`）。
  return /\.[a-zA-Z]{1,8}$/.test(parsed.path)
}
