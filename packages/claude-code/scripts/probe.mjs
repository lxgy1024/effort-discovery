#!/usr/bin/env node
import {
  CLAUDE_LEVELS,
  cachePath,
  claudeGateway,
  findProbe,
  loadAliases,
  loadConfig,
  normalizeBaseURL,
  probeAnthropic,
  resolveSecret,
  writeJson,
} from "./lib.mjs"

function parse(argv) {
  const args = { models: [] }
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (item === "--json") args.json = true
    else if (item === "--model") args.models.push(argv[++i])
    else if (item === "--provider") args.provider = argv[++i]
    else if (item === "--help" || item === "-h") args.help = true
    else if (!item.startsWith("-")) args.models.push(item)
  }
  return args
}

const HELP = `用法: node probe.mjs [--provider <id>] [--model <alias> ...] [--json]

默认读取 ${"~/.config/effort-discovery.json"} 里的 provider（可用 --provider 指定，
默认 "claude-proxy"），找不到就退回 Claude 自己 settings.json/env 里的网关与模型别名。
探测结果写入 ${cachePath()}。
`

const args = parse(process.argv.slice(2))
if (args.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

const config = loadConfig()
const providerID = args.provider ?? process.env.CLAUDE_EFFORT_PROVIDER ?? "claude-proxy"
const entry = config.providers?.[providerID]

let baseURL
let apiKey
let models = args.models

if (entry) {
  baseURL = normalizeBaseURL(entry.baseURL ?? entry.url)
  apiKey = resolveSecret(entry.apiKey)
  if (models.length === 0) models = Array.isArray(entry.models) ? entry.models : []
} else {
  const gateway = claudeGateway()
  baseURL = normalizeBaseURL(gateway.baseURL)
  apiKey = gateway.apiKey
  if (models.length === 0) models = gateway.models
}

if (!baseURL) {
  process.stderr.write(`no baseURL (provider "${providerID}" not found and no ANTHROPIC_BASE_URL)\n`)
  process.exit(2)
}
if (models.length === 0) {
  process.stderr.write("no models: pass --model or configure models in effort-discovery.json\n")
  process.exit(2)
}

const result = { at: Date.now(), provider: providerID, baseURL, models: {} }
const aliases = loadAliases()
for (const model of models) {
  const probed = await probeAnthropic({
    baseURL,
    apiKey,
    model,
    headers: typeof entry?.headers === "object" && entry.headers ? entry.headers : {},
  })
  const authoritative = findProbe(model, aliases)
  result.models[model] = {
    ...probed,
    alias: aliases[model] ?? null,
    authoritativeLevels: authoritative?.levels ?? null,
    authoritativeFrom: authoritative?.from ?? null,
    unsupportedInClaude:
      probed.levels?.length > 0
        ? CLAUDE_LEVELS.filter((level) => !probed.levels.includes(level))
        : null,
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