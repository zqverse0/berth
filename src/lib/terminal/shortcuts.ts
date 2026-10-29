import { listFolderCommands, quickMessagesList } from "@/lib/api"

/** 终端页和群聊指令选择器共用的已配置指令，不包含内置模板。 */
export interface Shortcut {
  scope: "project" | "global"
  id: number
  name: string
  content: string
}

export async function loadTerminalShortcuts(
  folderId: number | null
): Promise<Shortcut[]> {
  const [messages, commands] = await Promise.all([
    quickMessagesList(),
    folderId != null ? listFolderCommands(folderId) : Promise.resolve([]),
  ])
  return [
    ...commands.map((command) => ({
      scope: "project" as const,
      id: command.id,
      name: command.name,
      content: command.command,
    })),
    ...messages.map((message) => ({
      scope: "global" as const,
      id: message.id,
      name: message.title,
      content: message.content,
    })),
  ]
}
