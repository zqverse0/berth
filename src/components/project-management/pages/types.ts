import type { AgentType } from "@/lib/types"

export interface ProjectPageProps {
  folderId: number
  folderPath: string
  visible: boolean
  active: boolean
  selectedAgent: AgentType
  /** File-defined contract currently selected in the launch bar. */
  selectedContractId?: string | null
  onSelectAgent: (agentType: AgentType) => void
}
