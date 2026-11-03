"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

export default function Page() {
  const router = useRouter()
  useEffect(() => {
    // 保留查询参数（设备窗口的 `?folder=`）。
    router.replace(`/workspace${window.location.search}`)
  }, [router])
  return null
}
