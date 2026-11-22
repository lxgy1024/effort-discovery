#!/usr/bin/env node
import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

function configPath() {
  return (
    process.env.EFFORT_DISCOVERY_CONFIG ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "effort-discovery.json")
  )
}

function cachePath() {
  const dir =
    process.env.EFFORT_DISCOVERY_HOME ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "effort-discovery")
  return join(dir, "dsh.json")
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function resolveSecret(value) {
  if (typeof value !== "string") return undefined
  const raw = value.trim()
  if (!raw) return undefined
  const env = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw)
  if (env) return process.env[env[1]]?.trim() || undefined
  if (raw.startsWith("!")) {
    try {
      return String(execSync(raw.slice(1).trim(), { encoding: "utf8", timeout: 10_000 })).trim()
    } catch {
      return undefined
    }
  }
  return raw
}

function parseLevels(text) {
  if (typeof text !== "string") return null
  const list = "[a-z0-9_-]+(?:\\s*,\\s*[a-z0-9_-]+)*"
  const clean = (input) =>
    input
      .split(",")
      .map((item) => item.trim().replace(/^[`'"\s]+|[`'"\s.]+$/g, "").toLowerCase())
      .filter((item) => /^[a-z0-9_-]+$/.test(item))
  const valid = new RegExp(`valid levels?:\\s*(${list})`, "i").exec(text)
  if (valid) return clean(valid[1])
  const expected = /expected one of\s+([^\n]*)/i.exec(text)
  if (expected) {
    const tokens = [...expected[1].matchAll(/`([a-z0-9_-]+)`/gi)].map((m) => m[1].toLowerCase())
    if (tokens.length > 0) return tokens
  }
  return null
}

async function probe({ baseURL, apiKey, model, headers = {} }) {
  const url = `${String(baseURL).replace(/\/+$/, "")}/chat/completions`
  let last = { levels: null, source: "error", at: Date.now() }
  let sawOk = false
  for (const sentinel of ["effort-discovery-probe", "ultra", "maximum", "bogus"]) {
    let response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...headers,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
          reasoning_effort: sentinel,
        }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      last = { levels: null, source: "error", at: Date.now() }
      continue
    }
    const text = await response.text()
    if (response.ok) {
      sawOk = true
      continue
    }
    const levels = parseLevels(text)
    if (levels) return { levels, source: "validated", at: Date.now() }
    last = { levels: null, source: `http-${response.status}`, at: Date.now() }
    if ([401, 403, 429].includes(response.status)) return last
  }
  return sawOk ? { levels: null, source: "no-validation", at: Date.now() } : last
}

function parseArgs(argv) {
  const args = { models: [] }
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (item === "--json") args.json = true
    else if (item === "--provider") args.provider = argv[++i]
    else if (item === "--model") args.models.push(argv[++i])
    else if (item === "--help" || item === "-h") args.help = true
    else if (!item.startsWith("-")) args.models.push(item)
  }
  return args
}

const HELP = `用法: node probe.mjs [--provider <id>] [--model <id> ...] [--json]

读取 ~/.config/effort-discovery.json 的 provider，把每个模型的实测档位写进
${cachePath()}；dsh 插件在启动/配置更新时读取这份缓存来收窄 llm-pi-ai 的 reasoningEfforts。
`

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

const config = readJson(configPath()) ?? {}
const providers = Object.entries(config.providers ?? {})
const providerID =
  args.provider ??
  process.env.DSH_EFFORT_PROVIDER ??
  providers.find(([, entry]) => (entry.api ?? "openai") === "openai")?.[0]
const entry = providerID ? config.providers?.[providerID] : undefined
if (!entry) {
  process.stderr.write("no provider: add one to ~/.config/effort-discovery.json\n")
  process.exit(2)
}

const models = args.models.length > 0 ? args.models : Array.isArray(entry.models) ? entry.models : []
if (models.length === 0) {
  process.stderr.write("no models: pass --model or configure models in effort-discovery.json\n")
  process.exit(2)
}

const result = { at: Date.now(), provider: providerID, baseURL: entry.baseURL ?? entry.url, models: {} }
for (const model of models) {
  result.models[model] = await probe({
    baseURL: entry.baseURL ?? entry.url,
    apiKey: resolveSecret(entry.apiKey),
    model,
    headers: entry.headers ?? {},
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
}

mkdirSync(dirname(cachePath()), { recursive: true })
writeFileSync(cachePath(), JSON.stringify(result, null, 2) + "\n")

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
  process.stdout.write(`\ncache: ${cachePath()}\n`)
}