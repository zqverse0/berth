"use client"

import { useTranslations } from "next-intl"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/** 专家头像（`experts/<id>.json` 的 `avatar`）：宿主原样存，这里解释。认不得的值当没设。 */
export interface ExpertAvatarValue {
  shape: string
  color: string
}

/** viewBox 0 0 24 24 内的形状。 */
const SHAPES: Record<string, React.ReactNode> = {
  circle: <circle cx="12" cy="12" r="11" />,
  square: <rect x="1" y="1" width="22" height="22" rx="5" />,
  drop: <path d="M12 1C12 1 3 10.5 3 15a9 9 0 0 0 18 0C21 10.5 12 1 12 1Z" />,
  hexagon: <polygon points="12,1 21.5,6.5 21.5,17.5 12,23 2.5,17.5 2.5,6.5" />,
  star: (
    <polygon points="12,1 15,8.6 23,9.2 16.9,14.4 18.8,22.3 12,18 5.2,22.3 7.1,14.4 1,9.2 9,8.6" />
  ),
}

/** 主题图表色，随明暗主题变；类名写全，Tailwind 才扫得到。 */
const COLORS: Record<string, string> = {
  "chart-1": "fill-chart-1",
  "chart-2": "fill-chart-2",
  "chart-3": "fill-chart-3",
  "chart-4": "fill-chart-4",
  "chart-5": "fill-chart-5",
}

export function isExpertAvatar(value: unknown): value is ExpertAvatarValue {
  const avatar = value as Partial<ExpertAvatarValue> | null | undefined
  return (
    !!avatar &&
    typeof avatar.shape === "string" &&
    typeof avatar.color === "string" &&
    avatar.shape in SHAPES &&
    avatar.color in COLORS
  )
}

/** 形状 + 颜色，中间是名字首字。尺寸跟随父元素。 */
export function ExpertAvatar({
  avatar,
  name,
  className,
}: {
  avatar: ExpertAvatarValue
  name: string
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("size-full", COLORS[avatar.color], className)}
    >
      {SHAPES[avatar.shape]}
      {name ? (
        <text
          x="12"
          y="13"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="11"
          fontWeight="600"
          className="fill-background uppercase"
        >
          {name.slice(0, 1)}
        </text>
      ) : null}
    </svg>
  )
}

/** 专家编辑器名字旁的头像按钮：点开选形状、颜色，或清除。 */
export function ExpertAvatarPicker({
  value,
  name,
  onChange,
}: {
  value: unknown
  name: string
  onChange: (avatar: ExpertAvatarValue | undefined) => void
}) {
  const t = useTranslations("ExpertsSettings")
  const current = isExpertAvatar(value) ? value : null
  const shape = current?.shape ?? "circle"
  const color = current?.color ?? "chart-1"
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-expert-avatar
          aria-label={t("avatar")}
          title={t("avatar")}
          className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-secondary/60 p-1 text-xs font-semibold uppercase text-muted-foreground hover:bg-accent"
        >
          {current ? (
            <ExpertAvatar avatar={current} name={name} />
          ) : (
            name.slice(0, 1)
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 space-y-2 p-2">
        <div className="flex gap-1">
          {Object.keys(SHAPES).map((item) => (
            <button
              key={item}
              type="button"
              data-avatar-shape={item}
              aria-label={item}
              aria-pressed={current?.shape === item}
              onClick={() => onChange({ shape: item, color })}
              className={cn(
                "size-8 rounded-md p-1 hover:bg-accent",
                current?.shape === item && "bg-accent"
              )}
            >
              <ExpertAvatar avatar={{ shape: item, color }} name={name} />
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {Object.keys(COLORS).map((item) => (
            <button
              key={item}
              type="button"
              data-avatar-color={item}
              aria-label={item}
              aria-pressed={current?.color === item}
              onClick={() => onChange({ shape, color: item })}
              className={cn(
                "size-8 rounded-md p-1.5 hover:bg-accent",
                current?.color === item && "bg-accent"
              )}
            >
              <ExpertAvatar avatar={{ shape: "circle", color: item }} name="" />
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={!current}
          onClick={() => onChange(undefined)}
          className="w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          {t("avatarClear")}
        </button>
      </PopoverContent>
    </Popover>
  )
}
