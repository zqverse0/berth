export type Frequency = "daily" | "weekdays" | "weekly" | "custom"
const FREQUENCY_DOW: Record<Exclude<Frequency, "custom">, string> = {
  daily: "*",
  weekdays: "1-5",
  weekly: "1",
}

/** 「每天 / 工作日 / 每周一 + 时刻」↔ cron；其余写法按自定义 cron。 */
export function cronOf(frequency: Frequency, time: string, custom: string) {
  if (frequency === "custom") return custom.trim()
  const [hour, minute] = time.split(":").map(Number)
  return `${minute || 0} ${hour || 0} * * ${FREQUENCY_DOW[frequency]}`
}

export function parseCron(cron: string): {
  frequency: Frequency
  time: string
} {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|1)$/.exec(cron.trim())
  if (!match) return { frequency: "custom", time: "08:00" }
  const frequency = (
    Object.keys(FREQUENCY_DOW) as Exclude<Frequency, "custom">[]
  ).find((key) => FREQUENCY_DOW[key] === match[3])!
  const pad = (value: string) => value.padStart(2, "0")
  return { frequency, time: `${pad(match[2])}:${pad(match[1])}` }
}
