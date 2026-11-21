import { workspaceTabKey } from "@/lib/workspace/workspace-tab-placement"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"

/** 中间左栏切到「空间」首页（群对话所在）：盖在当前 tab 上，点别的 tab 就让位。 */
export function showProjectHome() {
  const files = useWorkspaceLayoutStore.getState().activeTabByPane.files
  useAppUiStore.setState({
    projectHomeOver: files ? workspaceTabKey(files) : null,
  })
}
