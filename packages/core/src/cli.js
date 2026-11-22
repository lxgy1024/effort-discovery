#!/usr/bin/env node
import {
  DEFAULT_TTL_MS,
  FileCache,
  configPath,
  loadCatalog,
  loadConfig,
  normalizeBaseURL,
  probeAnthropicEffort,
  probeEffort,
  resolveLevels,
  resolveSecret,
} from "./index.js"

const HELP = `effort-discovery — 探测模型真正支持的 reasoning effort 档位

用法:
  effort-discovery probe --provider <id> [--model <id> ...] [--json]
  effort-discovery get   --provider <id> --model <id> [--json]
  effort-discovery check --provider <id> --model <id> --level <lvl>
  effort-discovery providers [--json]
  effort-discovery catalog [--json]

provider 信息读取自 ${configPath()}:
{
  "providers": {
    "ts-dpsk": {
      "baseURL": "https://ai-api.transcircle.org/v1",
      "apiKey": "!type %USERPROFILE%\\\\.secrets\\\\key.txt",
      "headers": {},
      "models": ["deepseek-v4.1-flash"]
    }
  }
}

环境变量:
  EFFORT_DISCOVERY_CONFIG  覆盖配置文件路径
  EFFORT_DISCOVERY_HOME    覆盖缓存目录

退出码: 0 成功 / 1 不支持或有未知项 / 2 用法错误 / 3 未知模型
`

function parseArgs(argv) {
  const args = { _: [], model: [] }
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (item === "--json") args.json = true
    else if (item === "--help" || item === "-h") args.help = true
    else if (item === "--model") {
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        args.model.push(argv[++i])
      }
    } else if (item.startsWith("--")) {
      const key = item.slice(2)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) args[key] = true
      else {
        args[key] = value
        i++
      }
    } else {
      args._.push(item)
    }
  }
  return args
}

async function resolveProvider(args) {
  const config = await loadConfig()
  const id = typeof args.provider === "string" ? args.provider : undefined
  if (!id) return { error: "missing --provider" }
  const entry = config.providers?.[id]
  if (!entry) return { error: `provider "${id}" not in ${configPath()}` }
  const baseURL = normalizeBaseURL(args["base-url"] ?? entry.baseURL ?? entry.url)
  if (!baseURL) return { error: `provider "${id}" has no baseURL` }
  return {
    id,
    baseURL,
    apiKey: resolveSecret(args["api-key"] ?? entry.apiKey),
    headers: entry.headers ?? {},
    models: Array.isArray(entry.models) ? entry.models : [],
    api: args.api === "anthropic" ? "anthropic" : entry.api === "anthropic" ? "anthropic" : "openai",
  }
}

function runProbe(provider, modelID) {
  const probe = provider.api === "anthropic" ? probeAnthropicEffort : probeEffort
  return probe({
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    modelID,
    headers: provider.headers,
  })
}

function printTable(rows) {
  const headers = ["provider", "model", "levels", "source"]
  const table = [headers, ...rows]
  const widths = headers.map((_, column) =>
    Math.max(...table.map((row) => String(row[column] ?? "").length)),
  )
  for (const row of table) {
    process.stdout.write(
      row.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ") + "\n",
    )
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]

  if (!command || command === "help" || args.help) {
    process.stdout.write(HELP)
    return 0
  }

  const cache = new FileCache()

  if (command === "providers") {
    const config = await loadConfig()
    const providers = Object.entries(config.providers ?? {}).map(([id, entry]) => ({
      id,
      baseURL: normalizeBaseURL(entry.baseURL ?? entry.url),
      models: Array.isArray(entry.models) ? entry.models : [],
      hasKey: Boolean(entry.apiKey),
    }))
    if (args.json) {
      process.stdout.write(JSON.stringify(providers, null, 2) + "\n")
    } else if (providers.length === 0) {
      process.stdout.write(`no providers in ${configPath()}\n`)
    } else {
      for (const provider of providers) {
        process.stdout.write(
          `${provider.id}  ${provider.baseURL ?? "(no baseURL)"}  models=${provider.models.length}  key=${provider.hasKey ? "yes" : "no"}\n`,
        )
      }
    }
    return providers.length > 0 ? 0 : 1
  }

  if (command === "catalog") {
    const catalog = await loadCatalog()
    if (!catalog) {
      process.stderr.write("catalog unavailable\n")
      return 1
    }
    if (args.json) {
      process.stdout.write(
        JSON.stringify({ at: catalog.at, entries: Object.keys(catalog.byProvider).length }) + "\n",
      )
    } else {
      process.stdout.write(
        `catalog: ${Object.keys(catalog.byProvider).length} entries, updated ${new Date(catalog.at).toISOString()}\n`,
      )
    }
    return 0
  }

  if (command === "probe" || command === "get") {
    const provider = await resolveProvider(args)
    if (provider.error) {
      process.stderr.write(provider.error + "\n")
      return 2
    }
    const models = args.model.length > 0 ? args.model : provider.models
    if (models.length === 0) {
      process.stderr.write("missing --model (or provider.models in config)\n")
      return 2
    }

    const catalog = command === "get" ? await loadCatalog().catch(() => undefined) : undefined
    const output = {}
    const rows = []

    for (const modelID of models) {
      const cached = await cache.get(provider.id, modelID)
      const fresh = cached && Date.now() - cached.at < DEFAULT_TTL_MS && command === "get"
      let result = fresh ? cached : undefined

      if (!result) {
        const probed = await runProbe(provider, modelID)
        result = probed.source === "error" && cached ? cached : probed
        if (result.source !== "error") await cache.set(provider.id, modelID, result)
      }

      const levels = resolveLevels({
        probe: result,
        catalog,
        providerID: provider.id,
        modelID,
      })
      output[modelID] = { levels: levels ?? null, source: result.source }
      rows.push([provider.id, modelID, (levels ?? []).join(" ") || "(unknown)", result.source])
    }

    if (args.json) process.stdout.write(JSON.stringify(output, null, 2) + "\n")
    else printTable(rows)
    return 0
  }

  if (command === "check") {
    const provider = await resolveProvider(args)
    if (provider.error) {
      process.stderr.write(provider.error + "\n")
      return 2
    }
    if (!args.model[0] || !args.level) {
      process.stderr.write("usage: check --provider <id> --model <id> --level <lvl>\n")
      return 2
    }
    const modelID = args.model[0]
    const level = String(args.level).toLowerCase()

    const cached = await cache.get(provider.id, modelID)
    let result = cached && Date.now() - cached.at < DEFAULT_TTL_MS ? cached : undefined
    if (!result) {
      const probed = await runProbe(provider, modelID)
      result = probed.source === "error" && cached ? cached : probed
      if (result.source !== "error") await cache.set(provider.id, modelID, result)
    }

    const levels =
      resolveLevels({ probe: result, providerID: provider.id, modelID }) ??
      resolveLevels({
        probe: result,
        catalog: await loadCatalog().catch(() => undefined),
        providerID: provider.id,
        modelID,
      })

    if (!levels) {
      process.stderr.write(`unknown: ${provider.id}/${modelID} (${result.source})\n`)
      return 3
    }
    const ok = levels.includes(level)
    process.stdout.write(
      `${ok ? "ok" : "unsupported"}: ${provider.id}/${modelID} ${level} (valid: ${levels.join(", ")})\n`,
    )
    return ok ? 0 : 1
  }

  process.stderr.write(`unknown command: ${command}\n`)
  return 2
}

main().then(
  (code) => process.exit(code ?? 0),
  (error) => {
    process.stderr.write(String(error?.stack ?? error) + "\n")
    process.exit(1)
  },
)