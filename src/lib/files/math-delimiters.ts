/**
 * remark-math only supports `$` delimiters. Convert LaTeX-style
 * `\[...\]` / `\(...\)` to `$$...$$` / `$...$` so they are recognized.
 * Code blocks and inline code are preserved to avoid false positives.
 */
export function normalizeMathDelimiters(text: string): string {
  const saved: string[] = []
  const placeholder = (m: string) => {
    saved.push(m)
    return `\0CBLK${saved.length - 1}\0`
  }
  const masked = text.replace(
    /`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]+`/g,
    placeholder
  )
  const normalized = masked
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner: string) => `$$${inner}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner: string) => `$${inner}$`)
  return normalized.replace(
    /\0CBLK(\d+)\0/g,
    (_m, i: string) => saved[Number(i)]
  )
}
