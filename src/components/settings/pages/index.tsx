import type { ComponentType } from "react"
import type { SettingsPageId } from "@/lib/workspace/settings-tab"

/**
 * Settings 页面的按需加载注册表：每个 entry 只持有一个动态 import
 * 工厂，页面实现（连同其依赖树）不进入任何静态 chunk。
 * workbench 面板（WorkbenchPanelBody → SETTINGS_PAGE_LOADERS）从这里加载。
 */
export const SETTINGS_PAGE_LOADERS: Record<
  SettingsPageId,
  () => Promise<{ default: ComponentType }>
> = {
  "model-providers": () =>
    import("@/components/model-provider/model-provider-settings").then((m) => ({
      default: m.ModelProviderSettings,
    })),
  tools: () => import("./tools"),
  experts: () => import("./experts"),
  appearance: () =>
    import("../appearance-settings").then((m) => ({
      default: m.AppearanceSettings,
    })),
  advanced: () =>
    import("../advanced-settings").then((m) => ({
      default: m.AdvancedSettings,
    })),
}
