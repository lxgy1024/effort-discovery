#!/usr/bin/env node
import { existsSync, statSync } from "node:fs"
import {
  cachePath,
  catalogPath,
  codexHome,
  configCatalogTarget,
  patchCatalog,
  readJson,
  writeJson,
} from "./lib.mjs"

const HELP = `用法: node guard.mjs [--write] [--watch] [--json]

防止 cc-switch 等工具重新生成 catalog 后档位被覆盖回错误值。

原理：不论 config.toml 的 model_catalog_json 指向哪份文件，直接把
${cachePath()} 里的实测档位【就地修补】进那份文件本身（cc-switch 的文件也修），
这样指针被改来改去都无所谓，文件内容永远是对的。同时修补 ${catalogPath()} 副本。

  （无参数）  dry-run，只显示会修什么
  --write     实际修补一次
  --watch     修补一次后常驻，轮询 ~/.codex 下的 catalog 文件，被重写就自动再修
              （纯前台进程，不注册计划任务/服务；想停 Ctrl+C）
`

function parse(argv) {
  const args = {}
  for (const item of argv) {
    if (item === "--write") args.write = true
    else if (item === "--watch") args.watch = true
    else if (item === "--json") args.json = true
    else if (item === "--help" || item === "-h") args.help = true
  }
  return args
}

const args = parse(process.argv.slice(2))
if (args.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

/** 收集需要修补的 catalog 文件：config 当前指向的 + 我们的 efforts.json */
function targetFiles() {
  const files = new Set()
  const pointed = configCatalogTarget()
  if (pointed) files.add(pointed)
  files.add(catalogPath())
  return [...files]
}

function repair({ write }) {
  const cache = readJson(cachePath())
  if (!cache?.models) {
    return { error: `no cache at ${cachePath()} — run probe.mjs first` }
  }
  const report = []
  for (const file of targetFiles()) {
    if (!existsSync(file)) {
      report.push({ file, skipped: "missing" })
      continue
    }
    const catalog = readJson(file)
    if (!catalog?.models) {
      report.push({ file, skipped: "not a catalog" })
      continue
    }
    const changes = patchCatalog(catalog, cache.models)
    if (changes.length === 0) {
      report.push({ file, ok: true, changes: [] })
      continue
    }
    if (write) writeJson(file, catalog)
    report.push({ file, ok: true, changes })
  }
  return { report }
}

function print(result, write) {
  for (const entry of result.report ?? []) {
    if (entry.skipped) {
      process.stdout.write(`skip ${entry.file} (${entry.skipped})\n`)
      continue
    }
    if (entry.changes.length === 0) {
      process.stdout.write(`ok   ${entry.file} (already correct)\n`)
      continue
    }
    for (const change of entry.changes) {
      process.stdout.write(
        `${write ? "fix" : "would-fix"} ${change.model}: ${change.before} -> ${change.after}  [${entry.file}]\n`,
      )
    }
  }
  if (result.error) process.stderr.write(result.error + "\n")
}

const result = repair({ write: args.write || args.watch })
if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n")
else print(result, args.write || args.watch)

if (!args.watch) {
  if (!args.write && !args.json) process.stdout.write("\n(dry-run) 加 --write 实际修补，加 --watch 常驻自动修\n")
  process.exit(result.error ? 2 : 0)
}

// --watch：轮询 mtime+size，变化就重修。不用 fs.watch：Windows 目录监听对"写入后重命名"不稳定。
process.stdout.write(`\nwatching ${codexHome()} (Ctrl+C 停止)\n`)
const snapshot = new Map()
const snap = () => {
  for (const file of targetFiles()) {
    try {
      const stat = statSync(file)
      snapshot.set(file, `${stat.mtimeMs}:${stat.size}`)
    } catch {
      snapshot.set(file, "missing")
    }
  }
}
snap()
const timer = setInterval(() => {
  let dirty = false
  for (const file of targetFiles()) {
    let sig = "missing"
    try {
      const stat = statSync(file)
      sig = `${stat.mtimeMs}:${stat.size}`
    } catch {}
    if (snapshot.get(file) !== sig) {
      snapshot.set(file, sig)
      dirty = true
    }
  }
  if (!dirty) return
  const again = repair({ write: true })
  const fixes = (again.report ?? []).flatMap((entry) => entry.changes ?? [])
  const stamp = new Date().toISOString().slice(11, 19)
  if (fixes.length > 0) {
    process.stdout.write(`[${stamp}] catalog rewritten externally, re-applied:\n`)
    print(again, true)
  } else {
    process.stdout.write(`[${stamp}] change detected, levels still correct\n`)
  }
}, 3000)
process.on("SIGINT", () => {
  clearInterval(timer)
  process.exit(0)
})
