import { createFileTreeEntry } from "@/lib/api"
import { extractAppCommandError } from "@/lib/app-error"
import { joinRootRel } from "@/lib/files/file-open-target"

/** 在项目根建空文件 `<stem><ext>`（重名依次 `<stem>-2` …），返回绝对路径。 */
export async function createUniqueRootFile(
  rootPath: string,
  stem: string,
  ext: string
): Promise<string> {
  for (let index = 1; index <= 99; index += 1) {
    const name = index === 1 ? `${stem}${ext}` : `${stem}-${index}${ext}`
    try {
      return joinRootRel(
        rootPath,
        await createFileTreeEntry(rootPath, "", name, "file")
      )
    } catch (error) {
      if (extractAppCommandError(error)?.code !== "already_exists") throw error
    }
  }
  throw new Error(`Could not create a unique ${ext} file`)
}

/** 空画板 `drawing.excalidraw`；空文件即空画板。 */
export function createProjectDrawingFile(rootPath: string): Promise<string> {
  return createUniqueRootFile(rootPath, "drawing", ".excalidraw")
}
