#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { agySettingsPath, cachePath, readJson } from "./lib.mjs"

const WRITABLE_LEVELS = ["low", "medium", "high"]
const LEVEL_LABEL = { low: "Low", medium: "Medium", high: "High" }

function parseArgs(argv) {
  const args = { models: [] }
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (item === "--write") args.write = true
    else if (item === "--model") args.models.push(argv[++i])
    else if (item === "--help" || item === "-h") args.help = true
  }
  return args
}

const HELP = `用法: node emit-custom-models.mjs [--model <id>] [--write]

读取 ${cachePath()}，为网关模型生成 agy 的 customModels 配置片段。
只输出 JSON 片段（默认），加 --write 才备份并合并进 ${agySettingsPath()}。

注意：agy 的 thinkingLevel 只支持 low|medium|high；xhigh/max 会被跳过并警告。
`

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

const cache = readJson(cachePath())
if (!cache?.models || !cache.baseURL) {
  process.stderr.write(`no probe cache at ${cachePath()} — run probe.mjs first\n`)
  process.exit(2)
}

const baseURL = String(cache.baseURL).replace(/\/+$/, "")
const selected = args.models.length > 0 ? args.models : Object.keys(cache.models)
const customModels = {}
const warnings = []

for (const model of selected) {
  const info = cache.models[model]
  if (!info) {
    warnings.push(`model ${model} 不在缓存里，跳过`)
    continue
  }
  const levels = info.effective ?? info.levels ?? []
  if (!Array.isArray(levels) || levels.length === 0) {
    warnings.push(`${model}: 没有可信档位（${info.source ?? "unknown"}），跳过`)
    continue
  }

  const writable = levels.filter((level) => WRITABLE_LEVELS.includes(level))
  const skipped = levels.filter((level) => !WRITABLE_LEVELS.includes(level))
  if (skipped.length > 0) {
    warnings.push(`${model}: 跳过 agy 不支持的档位 ${skipped.join(", ")}（thinkingLevel 仅 low|medium|high）`)
  }
  if (writable.length === 0) {
    warnings.push(`${model}: 没有任何可写入的档位，跳过`)
    continue
  }

  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  const modelName = `gemini-api://${baseURL}/models/${model}`
  for (const level of writable) {
    const key = `${slug}-${level}`
    customModels[key] = {
      modelName,
      label: `${model} (${LEVEL_LABEL[level]})`,
      thinkingLevel: level,
    }
  }
}

const fragment = { customModelsConfig: { customModels } }

if (Object.keys(customModels).length === 0) {
  process.stderr.write("没有生成任何条目。\n")
  for (const warning of warnings) process.stderr.write(`  - ${warning}\n`)
  process.exit(1)
}

if (!args.write) {
  process.stdout.write(JSON.stringify(fragment, null, 2) + "\n")
  for (const warning of warnings) process.stderr.write(`warn: ${warning}\n`)
  process.stderr.write("\n(dry-run) 加 --write 才写入 settings.json\n")
  process.exit(0)
}

const path = agySettingsPath()
const settings = readJson(path)
if (!settings) {
  process.stderr.write(`cannot read ${path} (只支持标准 JSON，JSONC 注释会失败)\n`)
  process.exit(2)
}

if (settings.modelProvider && settings.modelProvider !== "gemini") {
  process.stderr.write(
    `warn: 当前 modelProvider = ${settings.modelProvider}；customModels 只在 "gemini" + GEMINI_API_KEY 下生效。\n`,
  )
}

const backup = `${path}.bak-${Date.now()}`
writeFileSync(backup, readFileSync(path, "utf8"))

settings.customModelsConfig = {
  ...(settings.customModelsConfig ?? {}),
  customModels: {
    ...(settings.customModelsConfig?.customModels ?? {}),
    ...customModels,
  },
}
mkdirSync(dirname(path), { recursive: true })
writeFileSync(path, JSON.stringify(settings, null, 2) + "\n")

process.stdout.write(`backup: ${backup}\n`)
process.stdout.write(`written ${Object.keys(customModels).length} entries to ${path}\n`)
process.stdout.write("重启 agy 后用 /model 查看新模型；thinkingLevel 固定为写入时的档位。\n")
for (const warning of warnings) process.stderr.write(`warn: ${warning}\n`)