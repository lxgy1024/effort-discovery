#!/usr/bin/env node
import { catalogPath, cachePath, currentCatalog, patchCatalog, readJson, writeJson } from "./lib.mjs"

function parse(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (item === "--write") args.write = true
    else if (item === "--json") args.json = true
    else if (item === "--help" || item === "-h") args.help = true
  }
  return args
}

const HELP = `用法: node sync-catalog.mjs [--write] [--json]

读取 ${cachePath()} 的探测结果，把每个模型的 supported_reasoning_levels
更新进现有 Codex catalog 的副本，写到 ${catalogPath()}。
默认 dry-run；--write 才写文件。之后需要把 config.toml 指向该文件：

  model_catalog_json = '${catalogPath()}'

（或给 model_providers.<id> 配 model_catalog_url，要求与 base_url 同源同端口。）
`

const args = parse(process.argv.slice(2))
if (args.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

const cache = readJson(cachePath())
if (!cache?.models) {
  process.stderr.write(`no cache at ${cachePath()} — run probe.mjs first\n`)
  process.exit(2)
}

const current = currentCatalog()
if (!current) {
  process.stderr.write("cannot read the current catalog (codex debug models / model_catalog_json)\n")
  process.exit(2)
}

const catalog = structuredClone(current.catalog)
const changes = patchCatalog(catalog, cache.models)

if (args.json) process.stdout.write(JSON.stringify(changes, null, 2) + "\n")
else if (changes.length === 0) process.stdout.write("no changes\n")
else
  for (const change of changes) {
    process.stdout.write(`${change.model}: ${change.before} -> ${change.after}\n`)
  }

if (!args.write) {
  process.stdout.write(`\n(dry-run) source=${current.source}\n加 --write 写入 ${catalogPath()}\n`)
  process.exit(0)
}

writeJson(catalogPath(), catalog)
process.stdout.write(`written: ${catalogPath()}\n`)
process.stdout.write(`现在在 config.toml 里设置:\n  model_catalog_json = '${catalogPath()}'\n`)