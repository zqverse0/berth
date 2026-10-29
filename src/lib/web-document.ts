export function isHttpDocumentUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

export function normalizeWebReaderUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!isHttpDocumentUrl(trimmed)) return null

  try {
    return new URL(trimmed).toString()
  } catch {
    return null
  }
}
