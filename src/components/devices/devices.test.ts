import { beforeEach, describe, expect, it } from "vitest"
import { useDevicesPanelStore } from "@/lib/devices"
import {
  pluginSidebarViewId,
  usePluginViewsStore,
} from "@/lib/plugins/plugin-views"
import { useSidebarViewStore } from "@/components/layout/sidebar/views"
import { openDevicesPanel } from "./devices"

const view = (plugin: string, permissions: string[]) => ({
  plugin,
  id: "main",
  title: "Devices",
  location: "sidebar" as const,
  page: "ui/index.html",
  permissions,
})

describe("openDevicesPanel", () => {
  beforeEach(() => {
    useSidebarViewStore.setState({ view: "projects" })
    useDevicesPanelStore.setState({ selected: null })
  })

  it("finds the panel by the devices permission, not by plugin id", () => {
    const panel = view("my-devices", ["devices"])
    usePluginViewsStore.setState({ views: [view("devices", []), panel] })

    openDevicesPanel(3)

    expect(useSidebarViewStore.getState().view).toBe(pluginSidebarViewId(panel))
    expect(useDevicesPanelStore.getState().selected).toBe(3)
  })

  it("does nothing without such a panel", () => {
    usePluginViewsStore.setState({ views: [view("devices", [])] })

    openDevicesPanel(3)

    expect(useSidebarViewStore.getState().view).toBe("projects")
    expect(useDevicesPanelStore.getState().selected).toBeNull()
  })
})
