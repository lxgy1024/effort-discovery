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
 * 用 output_config.effort 从高到低试探；2xx 视为该档位可用（并假定更低档位可用）。
 * @returns {Promise<{levels: string[] | null, source: string, at: number}>}
 */
export async function probeAnthropic({ baseURL, apiKey, model, headers = {}, ladder = ANTHROPIC_LADDER, timeoutMs = 30_000 }) {
  const base = normalizeBaseURL(baseURL)
  if (!base) return { levels: null, source: "error", at: Date.now() }
  const url = `${base}/v1/messages`
  let withBeta = true
  let unknown = false

  for (let index = 0; index < ladder.length; index++) {
    const level = ladder[index]
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

    let response
    try {
      response = await fetch(url, {
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
      index--
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