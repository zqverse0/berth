"use client"

export function AppBootLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div role="status" className="flex flex-col items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- static export, animated SVG */}
        <img src="/icon-animated.svg" alt="" className="h-16 w-16" />
        <span className="text-sm font-medium tracking-tight">Berth</span>
      </div>
    </div>
  )
}
