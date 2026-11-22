import { execSync } from "node:child_process"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const PROBE_SENTINEL = "effort-discovery-probe"
/** 有些网关只对特定非法值透传上游校验错误，按顺序尝试 */
export const PROBE_SENTINELS = ["effort-discovery-probe", "ultra", "maximum", "bogus"]
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
export const MODELSDEV_URL = "https://models.dev/api.json"
export const PROBE_TIMEOUT_MS = 20_000

/** 常见档位（仅用于提示，不用于猜测） */
export const KNOWN_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

export function normalizeBaseURL(input) {
  if (typeof input !== "string" || input.length === 0) return undefined
  return input.replace(/\/+$/, "").replace(/\/chat\/completions$/, "")
}

/** 解析密钥：支持 `!command`、`{env:NAME}`、明文 */
export function resolveSecret(value, { exec = execSync, env = process.env } = {}) {
  if (typeof value !== "string") return undefined
  const raw = value.trim()
  if (raw.length === 0) return undefined

  const envMatch = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw)
  if (envMatch) {
    const found = env[envMatch[1]]
    return typeof found === "string" && found.trim().length > 0 ? found.trim() : undefined
  }

  if (raw.startsWith("!")) {
    const command = raw.slice(1).trim()
    if (command.length === 0) return undefined
    try {
      const output = exec(command, { encoding: "utf8", timeout: 10_000, windowsHide: true })
      const text = String(output).trim()
      return text.length > 0 ? text : undefined
    } catch {
      return undefined
    }
  }

  return raw
}

/** 从上游错误文本里解析合法档位（兼容多种报错格式） */
export function parseLevels(text) {
  if (typeof text !== "string") return null

  const clean = (input) =>
    input
      .split(",")
      .map((item) => item.trim().replace(/^[`'"\s]+|[`'"\s.]+$/g, "").toLowerCase())
      .filter((item) => /^[a-z0-9_-]+$/.test(item))

  const list = "[a-z0-9_-]+(?:\\s*,\\s*[a-z0-9_-]+)*"

  const valid = new RegExp(`valid levels?:\\s*(${list})`, "i").exec(text)
  if (valid) {
    const levels = clean(valid[1])
    if (levels.length > 0) return levels
  }

  const expected = /expected one of\s+([^\n]*)/i.exec(text)
  if (expected) {
    const tokens = [...expected[1].matchAll(/`([a-z0-9_-]+)`/gi)].map((match) => match[1].toLowerCase())
    if (tokens.length > 0) return tokens
  }

  const supported = new RegExp(
    `(?:supported|allowed|valid)\\s+(?:levels|values|efforts)[^:\\n]*[:-]\\s*(${list})`,
    "i",
  ).exec(text)
  if (supported) {
    const levels = clean(supported[1])
    if (levels.length > 0) return levels
  }

  return null
}

/**
 * 用非法值探一次，读回上游自己声明的合法档位。
 * 个别网关只对特定非法值透传上游报错，因此按 sentinels 依次尝试。
 * @returns {Promise<{levels: string[] | null, source: string, at: number}>}
 */
export async function probeEffort(input) {
  const { baseURL, apiKey, modelID, headers: extraHeaders, timeoutMs = PROBE_TIMEOUT_MS } = input
  const sentinels = Array.isArray(input.sentinels) ? input.sentinels : PROBE_SENTINELS
  const headers = { "Content-Type": "application/json", ...(extraHeaders ?? {}) }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const url = `${normalizeBaseURL(baseURL)}/chat/completions`

  let last = { levels: null, source: "error", at: Date.now() }
  let sawOk = false

  for (const sentinel of sentinels) {
    let response
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelID,
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
    // 上游不校验：任意值都接受，说明无法得知真实档位
    if (response.ok) { sawOk = true; continue }

    const levels = parseLevels(text)
    if (levels) return { levels, source: "validated", at: Date.now() }

    last = { levels: null, source: `http-${response.status}`, at: Date.now() }
    // 限流/鉴权错误换 sentinel 也没用，直接返回
    if (response.status === 401 || response.status === 403 || response.status === 429) return last
  }

  return sawOk ? { levels: null, source: "no-validation", at: Date.now() } : last
}

/** 从 models.dev 的原始 JSON 抽出 effort 索引 */
export function buildCatalog(json) {
  const owner = {}
  const byProvider = {}
  if (!isObject(json)) return { owner, byProvider }

  for (const [providerID, provider] of Object.entries(json)) {
    if (!isObject(provider) || !isObject(provider.models)) continue
    for (const [modelID, model] of Object.entries(provider.models)) {
      if (!isObject(model)) continue
      const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : []
      const effort = options.find(
        (option) => isObject(option) && option.type === "effort" && Array.isArray(option.values),
      )
      const values = Array.isArray(effort?.values)
        ? effort.values.filter((value) => typeof value === "string")
        : []
      if (values.length === 0) continue

      const key = modelID.toLowerCase()
      byProvider[`${providerID.toLowerCase()}/${key}`] = values
      const canonical =
        typeof model.canonical_model_id === "string" ? model.canonical_model_id.toLowerCase() : ""
      if (canonical === `${providerID.toLowerCase()}/${key}`) owner[key] = values
    }
  }
  return { owner, byProvider }
}

export function catalogLevels(catalog, providerID, modelID) {
  if (!catalog) return undefined
  const key = String(modelID).toLowerCase()
  return (
    catalog.byProvider?.[`${String(providerID).toLowerCase()}/${key}`] ?? catalog.owner?.[key]
  )
}

export function cacheDir() {
  return (
    process.env.EFFORT_DISCOVERY_HOME ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "effort-discovery")
  )
}

export function configPath() {
  return (
    process.env.EFFORT_DISCOVERY_CONFIG ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "effort-discovery.json")
  )
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

export async function loadConfig() {
  const config = await readJson(configPath())
  return isObject(config) ? config : {}
}

/** 文件缓存：{ "<providerID>/<modelID>": { levels, source, at } } */
export class FileCache {
  constructor(dir = cacheDir()) {
    this.dir = dir
    this.path = join(dir, "cache.json")
    this.data = undefined
  }

  async load() {
    if (this.data) return this.data
    const raw = await readJson(this.path)
    this.data = isObject(raw) ? raw : {}
    return this.data
  }

  async get(providerID, modelID) {
    const data = await this.load()
    return data[`${providerID}/${modelID}`]
  }

  async set(providerID, modelID, result) {
    const data = await this.load()
    data[`${providerID}/${modelID}`] = result
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify(data, null, 2))
    return result
  }

  async all() {
    return { ...(await this.load()) }
  }
}

/** 目录索引缓存 */
export const CATALOG_KEY = "catalog.json"

export async function loadCatalog({ dir = cacheDir(), ttlMs = CATALOG_TTL_MS, fetchImpl = fetch } = {}) {
  const path = join(dir, CATALOG_KEY)
  const cached = await readJson(path)
  if (isObject(cached) && isObject(cached.owner) && isObject(cached.byProvider) && Date.now() - cached.at < ttlMs) {
    return cached
  }
  const response = await fetchImpl(MODELSDEV_URL, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) return isObject(cached) ? cached : undefined
  const built = buildCatalog(await response.json())
  const catalog = { at: Date.now(), ...built }
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(catalog))
  return catalog
}

/** 合并判断：探针结果优先，其次目录 */
export function resolveLevels({ probe, catalog, providerID, modelID }) {
  if (probe?.levels) return probe.levels
  return catalogLevels(catalog, providerID, modelID)
}

export const ANTHROPIC_EFFORT_BETA = "effort-2025-11-24"
export const ANTHROPIC_EFFORT_LADDER = ["max", "xhigh", "high", "medium", "low"]

/**
 * Anthropic Messages 协议（Claude Code / agy 走的协议）的档位探测：
 * 用 output_config.effort 逐级试探，遇到 400 说明该级别不被接受。
 * @returns {Promise<{levels: string[] | null, source: string, at: number}>}
 */
export async function probeAnthropicEffort(input) {
  const {
    baseURL,
    apiKey,
    modelID,
    headers: extraHeaders,
    timeoutMs = PROBE_TIMEOUT_MS,
    ladder = ANTHROPIC_EFFORT_LADDER,
  } = input

  const base = normalizeBaseURL(baseURL).replace(/\/v1$/, "")
  const url = `${base}/v1/messages`
  let withBeta = true
  let unknown = false

  for (let index = 0; index < ladder.length; index++) {
    const level = ladder[index]
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(withBeta ? { "anthropic-beta": ANTHROPIC_EFFORT_BETA } : {}),
      ...(extraHeaders ?? {}),
    }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
      headers["x-api-key"] = apiKey
    }

    let response
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelID,
          max_tokens: 16,
          messages: [{ role: "user", content: "ping" }],
          output_config: { effort: level },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      unknown = true
      continue
    }

    if (response.ok) return { levels: ladder.slice(index), source: "validated", at: Date.now() }

    const text = await response.text()
    const mentionsBeta = /effort-2025-11-24|anthropic-beta/i.test(text)
    const mentionsEffort = /output_config|effort|does not support/i.test(text)

    if (response.status === 400 && mentionsBeta && !mentionsEffort && withBeta) {
      withBeta = false
      index-- // 用同一档位重试，去掉 beta 头
      continue
    }

    if (response.status === 400 || response.status === 422) {
      if (!mentionsEffort && !mentionsBeta) unknown = true
      continue
    }

    if (response.status === 401 || response.status === 403 || response.status === 429) {
      return { levels: null, source: `http-${response.status}`, at: Date.now() }
    }

    unknown = true
  }

  return { levels: null, source: unknown ? "error" : "no-validation", at: Date.now() }
}

export const __internal = { isObject }