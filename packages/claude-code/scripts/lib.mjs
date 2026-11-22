import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
export const ANTHROPIC_LADDER = ["max", "xhigh", "high", "medium", "low"]
export const BETA = "effort-2025-11-24"

export function configPath() {
  return (
    process.env.EFFORT_DISCOVERY_CONFIG ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "effort-discovery.json")
  )
}

export function cacheDir() {
  return (
    process.env.EFFORT_DISCOVERY_HOME ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "effort-discovery")
  )
}

export function cachePath() {
  return join(cacheDir(), "claude-code.json")
}

export function claudeSettingsPath() {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json")
}

export const CLAUDE_LEVELS = ["low", "medium", "high", "xhigh", "max"]

/** 网关别名 → 真实模型 id 的映射（在 ~/.config/effort-discovery.json 的 aliases 里） */
export function loadAliases() {
  const config = loadConfig()
  const aliases = config.aliases
  return aliases && typeof aliases === "object" && !Array.isArray(aliases) ? aliases : {}
}

/** 在所有缓存里查找某个模型的实测档位；优先有 levels 的证据 */
export function findProbe(modelID, aliases = {}) {
  const canonical = aliases[modelID] ?? modelID
  const dir = cacheDir()
  const candidates = []

  for (const file of ["cache.json", "dsh.json", "claude-code.json"]) {
    const json = readJson(join(dir, file))
    if (!json || typeof json === "object" && (json.owner || json.byProvider)) continue
    const entries = json.models ?? json
    if (!entries || typeof entries !== "object") continue
    for (const [key, value] of Object.entries(entries)) {
      if (!value || typeof value !== "object" || !("levels" in value)) continue
      const match =
        key === modelID ||
        key === canonical ||
        key.endsWith(`/${modelID}`) ||
        key.endsWith(`/${canonical}`)
      if (match) {
        candidates.push({
          from: key,
          file,
          source: value.source ?? "unknown",
          levels: value.levels ?? null,
          at: value.at ?? 0,
        })
      }
    }
  }

  candidates.sort(
    (a, b) => (b.levels?.length ?? 0) - (a.levels?.length ?? 0) || b.at - a.at,
  )
  return candidates[0]
}

/** 给出"实测支持"之外的 Claude 档位（即不该选的） */
export function unsupportedClaudeLevels(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return []
  return CLAUDE_LEVELS.filter((level) => !levels.includes(level))
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
  if (raw.length === 0) return undefined
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

/** 从上游错误文本解析合法档位（与 core 保持同一套规则） */
export function parseLevels(text) {
  if (typeof text !== "string") return null
  const list = "[a-z0-9_-]+(?:\\s*,\\s*[a-z0-9_-]+)*"
  const clean = (input) =>
    input
      .split(",")
      .map((item) => item.trim().replace(/^[`'"\s]+|[`'"\s.]+$/g, "").toLowerCase())
      .filter((item) => /^[a-z0-9_-]+$/.test(item))

  const valid = new RegExp(`valid levels?:\\s*(${list})`, "i").exec(text)
  if (valid) {
    const levels = clean(valid[1])
    if (levels.length > 0) return levels
  }

  const expected = /expected one of\s+([^\n]*)/i.exec(text)
  if (expected) {
    const tokens = [...expected[1].matchAll(/`([a-z0-9_-]+)`/gi)].map((m) => m[1].toLowerCase())
    if (tokens.length > 0) return tokens
  }

  return null
}

export function normalizeBaseURL(input) {
  if (typeof input !== "string" || input.length === 0) return undefined
  return input.replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/v1$/, "")
}

/**
 * Anthropic Messages 协议档位探测：
 * 先用非法档位判断网关是否真的校验；不校验就返回 no-validation，
 * 绝不把“2xx”误当成“支持全部档位”。
 */
export async function probeAnthropic({ baseURL, apiKey, model, headers = {}, ladder = ANTHROPIC_LADDER, timeoutMs = 30_000 }) {
  const base = normalizeBaseURL(baseURL)
  if (!base) return { levels: null, source: "error", at: Date.now() }
  const url = `${base}/v1/messages`
  let withBeta = true
  let unknown = false

  const send = async (level) => {
    const head = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(withBeta ? { "anthropic-beta": BETA } : {}),
      ...headers,
    }
    if (apiKey) {
      head.Authorization = `Bearer ${apiKey}`
      head["x-api-key"] = apiKey
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: head,
        body: JSON.stringify({
          model,
          max_tokens: 16,
          messages: [{ role: "user", content: "ping" }],
          output_config: { effort: level },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      return { status: response.status, text: await response.text() }
    } catch {
      return undefined
    }
  }

  const fatal = (r) =>
    r && [401, 403, 429].includes(r.status)
      ? { levels: null, source: `http-${r.status}`, at: Date.now() }
      : undefined

  // 1) sentinel
  const sentinel = await send("effort-discovery-probe")
  const fatalSentinel = fatal(sentinel)
  if (fatalSentinel) return fatalSentinel
  if (sentinel) {
    if (sentinel.status >= 200 && sentinel.status < 300) {
      return { levels: null, source: "no-validation", at: Date.now() }
    }
    const listed = parseLevels(sentinel.text)
    if (listed) return { levels: listed, source: "validated", at: Date.now() }
    if (
      sentinel.status === 400 &&
      /effort-2025-11-24|anthropic-beta/i.test(sentinel.text) &&
      !/output_config|does not support|unsupported|invalid value/i.test(sentinel.text)
    ) {
      withBeta = false
    }
  }

  // 2) ladder
  for (let index = 0; index < ladder.length; index++) {
    const result = await send(ladder[index])
    const fatalResult = fatal(result)
    if (fatalResult) return fatalResult
    if (!result) {
      unknown = true
      continue
    }
    if (result.status >= 200 && result.status < 300) {
      return { levels: ladder.slice(index), source: "validated", at: Date.now() }
    }

    const mentionsBeta = /effort-2025-11-24|anthropic-beta/i.test(result.text)
    const mentionsEffort = /output_config|does not support|unsupported|invalid value/i.test(result.text)

    if (result.status === 400 && mentionsBeta && !mentionsEffort && withBeta) {
      withBeta = false
      index--
      continue
    }
    if (result.status === 400 || result.status === 422) {
      const listed = parseLevels(result.text)
      if (listed) return { levels: listed, source: "validated", at: Date.now() }
      if (!mentionsEffort && !mentionsBeta) unknown = true
      continue
    }
    unknown = true
  }

  return { levels: null, source: unknown ? "error" : "no-validation", at: Date.now() }
}

export function capFromLevels(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return undefined
  return [...levels].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b)).at(-1)
}

/** 从 Claude 的 settings/env 里猜出网关地址、密钥和模型别名 */
export function claudeGateway() {
  const settings = readJson(claudeSettingsPath()) ?? {}
  const env = settings.env ?? {}
  const baseURL =
    process.env.ANTHROPIC_BASE_URL ?? env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"
  const apiKey =
    process.env.ANTHROPIC_AUTH_TOKEN ??
    process.env.ANTHROPIC_API_KEY ??
    env.ANTHROPIC_AUTH_TOKEN ??
    env.ANTHROPIC_API_KEY
  const models = new Set()
  for (const [key, value] of Object.entries(env)) {
    if (/^ANTHROPIC_DEFAULT_.*_MODEL$/.test(key) && typeof value === "string") models.add(value)
  }
  for (const option of settings.modelPicker?.options ?? []) {
    if (typeof option.model === "string") models.add(option.model)
  }
  return { baseURL, apiKey: resolveSecret(apiKey), models: [...models] }
}