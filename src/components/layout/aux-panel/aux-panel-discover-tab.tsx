"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { GithubTrendingWorkspace } from "@/components/layout/github-trending-workspace"
import { GithubStarsWorkspace } from "@/components/layout/github-stars-workspace"
import { SidebarHeaderTabs } from "@/components/layout/sidebar/sidebar-header"

type DiscoverView = "trending" | "stars"

/** GitHub 趋势 / 星标浏览：与当前项目无关，无项目时也可用。 */
export function AuxPanelDiscoverTab() {
  const tTrending = useTranslations("ProjectBoot.githubTrending")
  const tStars = useTranslations("ProjectBoot.githubStars")
  const [view, setView] = useState<DiscoverView>("trending")

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeaderTabs
        tabs={[
          { id: "trending", label: tTrending("title") },
          { id: "stars", label: tStars("title") },
        ]}
        value={view}
        onChange={setView}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        {view === "trending" ? (
          <GithubTrendingWorkspace />
        ) : (
          <GithubStarsWorkspace />
        )}
      </div>
    </div>
  )
}
