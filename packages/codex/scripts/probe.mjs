#!/usr/bin/env node
import {
  CODEX_EFFORTS,
  cachePath,
  loadConfig,
  nativeCatalog,
  probeOpenAI,
  resolveSecret,
  writeJson,
} from "./lib.mjs"

function parse(argv) {
  const args = { models: [] }
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (item === "--json") args.json = true
    else if (item === "--provider") args.provider = argv[++i]
    else if (item === "--model") args.models.push(argv[++i])
    else if (item === "--no-native") args.noNative = true
    else if (item === "--help" || item === "-h") args.help = true
    else if (!item.startsWith("-")) args.models.push(item)
  }
  return args
}

const HELP = `用法: node probe.mjs [--provider <id>] [--model <slug> ...] [--no-native] [--json]

1) 先尝试网关的原生 catalog（GET {baseURL}/models 里的 supported_reasoning_levels，零成本）；
2) 没有就用非法 reasoning_effort 探测（每个模型最多 4 次极小请求）。
provider 来自 ${"~/.config/effort-discovery.json"}，默认取第一个 openai provider。
结果写入 ${cachePath()}。
`

const args = parse(process.argv.slice(2))
if (args.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

const config = loadConfig()
const providers = Object.entries(config.providers ?? {})
const providerID =
  args.provider ??
  process.env.CODEX_EFFORT_PROVIDER ??
  providers.find(([, entry]) => (entry.api ?? "openai") === "openai")?.[0]
const entry = providerID ? config.providers?.[providerID] : undefined
if (!entry) {
  process.stderr.write(`no provider: add one to ~/.config/effort-discovery.json\n`)
  process.exit(2)
}

const baseURL = entry.baseURL ?? entry.url
const apiKey = resolveSecret(entry.apiKey)
const headers = entry.headers ?? {}

const result = { at: Date.now(), provider: providerID, baseURL, models: {} }

const native = args.noNative ? undefined : await nativeCatalog({ baseURL, apiKey, headers })
const configured = args.models.length > 0 ? args.models : Array.isArray(entry.models) ? entry.models : []
const models = [...new Set([...Object.keys(native ?? {}), ...configured])]

for (const model of models) {
  const nativeLevels = native?.[model] ?? null
  const probed = await probeOpenAI({ baseURL, apiKey, model, headers })
  const validated = probed.source === "validated" && Array.isArray(probed.levels) && probed.levels.length > 0

  // 上游错误回显优先（它反映实际接受的 effort），原生 catalog 兜底
  const levels = validated
    ? probed.levels.filter((level) => CODEX_EFFORTS.includes(level))
    : nativeLevels ?? null

  result.models[model] = {
    levels,
    source: validated
      ? "validated"
      : nativeLevels
        ? "native-catalog"
        : probed.source,
    rawLevels: probed.levels,
    nativeLevels,
    at: Date.now(),
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
}

writeJson(cachePath(), result)

if (args.json) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
} else {
  const rows = [["model", "levels", "source"]]
  for (const [model, info] of Object.entries(result.models)) {
    rows.push([model, (info.levels ?? []).join(" ") || "(unknown)", info.source])
  }
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => String(row[column] ?? "").length)),
  )
  for (const row of rows) {
    process.stdout.write(
      row.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ") + "\n",
    )
  }
}