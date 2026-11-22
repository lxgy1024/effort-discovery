#!/usr/bin/env node
import { capFromLevels, cachePath, claudeSettingsPath, readJson, writeJson } from "./lib.mjs"

function parse(argv) {
  const args = { models: [] }
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (item === "--write") args.write = true
    else if (item === "--global") args.global = true
    else if (item === "--json") args.json = true
    else if (item === "--model") args.models.push(argv[++i])
    else if (item === "--help" || item === "-h") args.help = true
  }
  return args
}

const HELP = `用法: node apply.mjs [--write] [--global] [--model <id>] [--json]

读取 ${cachePath()} 的探测结果，把每个模型的上限写进 Claude Code 的
${claudeSettingsPath()}（modelSettings[model].maxEffortLevel）。

默认是 dry-run，只打印将要写入的内容；加 --write 才真正改文件（会先备份 .bak）。
--global 额外把顶层 maxEffortLevel 设成所有模型里最低的上限（兜底，别名匹配不上时仍然生效）。
`

const args = parse(process.argv.slice(2))
if (args.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

const cache = readJson(cachePath())
if (!cache || !cache.models) {
  process.stderr.write(`no cache at ${cachePath()} — run probe.mjs first\n`)
  process.exit(2)
}

const settingsPath = claudeSettingsPath()
const settings = readJson(settingsPath)
if (!settings) {
  process.stderr.write(`cannot read ${settingsPath}\n`)
  process.exit(2)
}

const selected = args.models.length > 0 ? args.models : Object.keys(cache.models)
const caps = {}
for (const model of selected) {
  const info = cache.models[model]
  if (!info) continue
  const cap = capFromLevels(info.levels)
  if (cap) caps[model] = cap
}

if (Object.keys(caps).length === 0) {
  process.stderr.write("no known caps (every model is unknown/no-validation)\n")
  process.exit(1)
}

const plan = { modelSettings: {}, maxEffortLevel: undefined }
for (const [model, cap] of Object.entries(caps)) {
  plan.modelSettings[model] = { maxEffortLevel: cap }
}
if (args.global) {
  const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
  plan.maxEffortLevel = Object.values(caps).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0]
}

if (args.json) process.stdout.write(JSON.stringify(plan, null, 2) + "\n")
else {
  process.stdout.write(`settings: ${settingsPath}\n`)
  for (const [model, value] of Object.entries(plan.modelSettings)) {
    process.stdout.write(`  modelSettings["${model}"].maxEffortLevel = "${value.maxEffortLevel}"\n`)
  }
  if (plan.maxEffortLevel) process.stdout.write(`  maxEffortLevel = "${plan.maxEffortLevel}"\n`)
}

if (!args.write) {
  process.stdout.write("\n(dry-run) 加 --write 才会写入\n")
  process.exit(0)
}

const backup = `${settingsPath}.bak-${Date.now()}`
writeJson(backup, settings)
process.stdout.write(`backup: ${backup}\n`)

settings.modelSettings = { ...(settings.modelSettings ?? {}) }
for (const [model, value] of Object.entries(plan.modelSettings)) {
  settings.modelSettings[model] = { ...(settings.modelSettings[model] ?? {}), ...value }
}
if (plan.maxEffortLevel) settings.maxEffortLevel = plan.maxEffortLevel

writeJson(settingsPath, settings)
process.stdout.write("written. 用 /effort status 和 picker 验证是否生效。\n")