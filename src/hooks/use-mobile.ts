"use client"

import { useAppUiStore } from "@/stores/app-ui-store"

export const MOBILE_BREAKPOINT = "(max-width: 767px)"

/** 是否手机布局：读 app-ui-store 的唯一来源（AppUiRuntime 订阅媒体查询写入）。 */
export function useIsMobile(): boolean {
  return useAppUiStore((state) => state.mobileLayout)
}
