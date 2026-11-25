import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]

export function codexHome() {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex")
}

export function configPath() {
  return (
    process.env.EFFORT_DISCOVERY_CONFIG ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "effort-discovery.json")
  )
}

export function cachePath() {
  const dir =
    process.env.EFFORT_DISCOVERY_HOME ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "effort-discovery")
  return join(dir, "codex.json")
}

export function catalogPath() {
  return join(codexHome(), "model-catalogs", "efforts.json")
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n")
}

export function loadConfig() {
  const config = readJson(configPath())
  return config && typeof config === "object" ? config : {}
}

export function resolveSecret(value) {
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

export function parseLevels(text) {
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

export async function probeOpenAI({ baseURL, apiKey, model, headers = {}, timeoutMs = 20_000 }) {
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
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      last = { levels: null, source: "error", at: Date.now() }
      continue
    }
    const text = await response.text()
    if (response.ok) { sawOk = true; continue }
    const levels = parseLevels(text)
    if (levels) return { levels, source: "validated", at: Date.now() }
    last = { levels: null, source: `http-${response.status}`, at: Date.now() }
    if ([401, 403, 429].includes(response.status)) return last
  }
  return sawOk ? { levels: null, source: "no-validation", at: Date.now() } : last
}

/** 网关如果直接提供 Codex 原生 catalog（含 supported_reasoning_levels），优先用它 */
export async function nativeCatalog({ baseURL, apiKey, headers = {}, timeoutMs = 15_000 }) {
  try {
    const response = await fetch(`${String(baseURL).replace(/\/+$/, "")}/models`, {
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    const json = await response.json()
    const models = Array.isArray(json?.models) ? json.models : Array.isArray(json?.data) ? json.data : []
    const mapped = {}
    for (const model of models) {
      const slug = model.slug ?? model.id
      const levels = model.supported_reasoning_levels
      if (typeof slug !== "string" || !Array.isArray(levels)) continue
      const values = levels.map((item) => (typeof item === "string" ? item : item?.effort)).filter(Boolean)
      if (values.length > 0) mapped[slug] = values
    }
    return Object.keys(mapped).length > 0 ? mapped : undefined
  } catch {
    return undefined
  }
}

/**
 * 把探测缓存里的正确档位修补进 catalog（就地修改传入对象）。
 * cacheModels 的键可能是带 provider 前缀的 slug（ccs-newapi/xxx），也可能是裸模型 id；
 * catalog slug 先精确匹配，再按 "/" 后缀退化匹配。
 * 返回变更列表。
 */
export function patchCatalog(catalog, cacheModels) {
  const changes = []
  if (!catalog?.models || !cacheModels) return changes

  const lookup = (slug) => {
    const exact = cacheModels[slug]
    if (exact) return exact
    const bare = String(slug).split("/").pop()
    // 裸 id 匹配：缓存键自身是裸 id，或者缓存键的后缀等于裸 id
    const candidates = Object.entries(cacheModels).filter(([key]) => {
      const tail = key.split("/").pop()
      return key === bare || tail === bare
    })
    return candidates.length === 1 ? candidates[0][1] : undefined
  }

  for (const model of catalog.models) {
    const info = lookup(model.slug)
    if (!info?.levels?.length) continue
    const desired = info.levels.filter((level) => level !== "off")
    const before = (model.supported_reasoning_levels ?? []).map((item) =>
      typeof item === "string" ? item : item.effort,
    )
    if (before.join(",") === desired.join(",")) continue
    model.supported_reasoning_levels = desired.map((effort) => ({ effort, description: effort }))
    if (!desired.includes(model.default_reasoning_level)) {
      model.default_reasoning_level = desired.includes("medium") ? "medium" : desired[0]
    }
    changes.push({
      model: model.slug,
      before: before.join(",") || "(none)",
      after: desired.join(","),
    })
  }
  return changes
}

/** config.toml 当前指向的 catalog 文件路径（没有则为 undefined） */
export function configCatalogTarget() {
  try {
    const config = readFileSync(join(codexHome(), "config.toml"), "utf8")
    const match = /^\s*model_catalog_json\s*=\s*['"](.+?)['"]/m.exec(config)
    return match ? match[1].replace(/\\\\/g, "\\") : undefined
  } catch {
    return undefined
  }
}

/** 读取当前生效的 catalog（codex debug models 优先，其次 config.toml 的 model_catalog_json） */
export function currentCatalog() {
  const config = readFileSync(join(codexHome(), "config.toml"), "utf8")
  const match = /^\s*model_catalog_json\s*=\s*['"](.+?)['"]/m.exec(config)
  const fromConfig = match ? readJson(match[1].replace(/\\\\/g, "\\")) : undefined
  if (fromConfig?.models) return { catalog: fromConfig, source: match[1] }

  try {
    const output = execSync("codex debug models", { encoding: "utf8", timeout: 60_000, windowsHide: true })
    const parsed = JSON.parse(output)
    if (parsed?.models) return { catalog: parsed, source: "codex debug models" }
  } catch {}

  return undefined
}