/**
 * 项目层的唯一读法：项目属性只在 `FolderDetail.project` 上（后端项目表），folder 自己不再有名称、
 * 置顶、排序。没有项目的 folder（chat、对方设备的项目在 S7 之前平铺）自成一个单成员项目。
 */
import type { FolderDetail } from "@/lib/types"

type ProjectFolder = Pick<FolderDetail, "id" | "name" | "project">

/** 项目名。 */
export function projectName(folder: ProjectFolder): string {
  return folder.project?.name ?? folder.name
}

/** 主成员的 folder id，也是项目在前端的身份（tab 范围、布局、恢复都按它）。 */
export function mainFolderId(folder: Pick<FolderDetail, "id" | "project">) {
  return folder.project?.main_folder_id ?? folder.id
}

export function isMainMember(folder: Pick<FolderDetail, "id" | "project">) {
  return mainFolderId(folder) === folder.id
}

/** 成员显示名：主成员用项目名，其余用目录名。 */
export function memberLabel(folder: ProjectFolder): string {
  return isMainMember(folder) ? projectName(folder) : folder.name
}

/**
 * 空间目录当作主成员名下的目录：空间里的文件（任务、知识库笔记）据此找到所属项目，
 * 与 `findOwningFolder` 的成员目录一起用。
 */
export function spaceDirFolders(
  folders: ReadonlyArray<Pick<FolderDetail, "id" | "project">>
): { id: number; path: string }[] {
  return folders.flatMap((folder) =>
    isMainMember(folder) && folder.project?.dir
      ? [{ id: folder.id, path: folder.project.dir }]
      : []
  )
}
