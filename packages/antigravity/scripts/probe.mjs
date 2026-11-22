#!/usr/bin/env node
import {
  AGY_LEVELS,
  agyAvailable,
  agySettingsPath,
  cachePath,
  loadConfig,
  parseLevels,
  probeOpenAI,
  readJson,
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
    else if (item === "--agy") args.agy = true
    else if (item === "--help" || item === "-h") args.help = true
    else if (!item.startsWith("-")) args.models.push(item)
  }
  return args
}

const HELP = `用法: node probe.mjs [--provider <id>] [--model <id> ...] [--agy] [--json]

--provider 默认取 ${"~/.config/effort-discovery.json"} 里第一个 openai provider，
也可以用 --provider 指定；网关地址/密钥/模型列表都来自该 provider。
--agy 额外调用 agy 自己的 "\${/effort}" 命令，交叉验证 agy 认为可用的档位。
输出写入 ${cachePath()}。
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
  process.env.AGY_EFFORT_PROVIDER ??
  providers.find(([, entry]) => (entry.api ?? "openai") === "openai")?.[0]

const entry = providerID ? config.providers?.[providerID] : undefined
if (!entry) {
  process.stderr.write(
    `no provider: add one to ${"~/.config/effort-discovery.json"} or pass --provider\n`,
  )
  process.exit(2)
}

let models = args.models
if (models.length === 0) {
  const settings = readJson(agySettingsPath())
  const custom = settings?.customModelsConfig?.customModels ?? {}
  for (const value of Object.values(custom)) {
    if (typeof value?.modelName === "string") {
      const match = /\/models\/(.+)$/.exec(value.modelName)
      if (match) models.push(match[1])
    }
  }
}
if (models.length === 0) models = Array.isArray(entry.models) ? entry.models : []
if (models.length === 0) {
  process.stderr.write("no models: pass --model or configure models in effort-discovery.json\n")
  process.exit(2)
}

const result = {
  at: Date.now(),
  provider: providerID,
  baseURL: entry.baseURL ?? entry.url,
  models: {},
}

for (const model of models) {
  const probed = await probeOpenAI({
    baseURL: entry.baseURL ?? entry.url,
    apiKey: resolveSecret(entry.apiKey),
    model,
    headers: entry.headers ?? {},
  })
  const agy = args.agy ? agyAvailable(model) : undefined

  // 网关不校验时，agy 自己的模型元数据是唯一可信来源
  const gatewayLevels = Array.isArray(probed.levels) && probed.levels.length > 0 ? probed.levels : null
  const authority = gatewayLevels ? "gateway" : Array.isArray(agy) && agy.length > 0 ? "agy" : null
  const base = gatewayLevels ?? (Array.isArray(agy) && agy.length > 0 ? agy : null)

  result.models[model] = {
    ...probed,
    agyAvailable: agy ?? null,
    authority,
    /// 实际可用档位：网关证据优先，否则用 agy 自身元数据兜底
    effective: base ? base.filter((level) => AGY_LEVELS.includes(level)) : null,
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
}

writeJson(cachePath(), result)

if (args.json) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
} else {
  const rows = [["model", "gateway levels", "agy levels", "source"]]
  for (const [model, info] of Object.entries(result.models)) {
    rows.push([
      model,
      (info.effective ?? []).join(" ") || "(unknown)",
      (info.agyAvailable ?? []).join(" ") || "-",
      info.source,
    ])
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