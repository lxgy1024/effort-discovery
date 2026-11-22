import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const AGY_LEVELS = ["low", "medium", "high", "xhigh", "max"]

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
  return join(dir, "antigravity.json")
}

export function agySettingsPath() {
  return join(
    process.env.GEMINI_CLI_HOME ?? join(homedir(), ".gemini"),
    "antigravity-cli",
    "settings.json",
  )
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

  const invalid = /Invalid effort[^()]*\(valid:\s*([^)]+)\)/i.exec(text)
  if (invalid) return clean(invalid[1])

  return null
}

export async function probeOpenAI({ baseURL, apiKey, model, headers = {}, timeoutMs = 20_000 }) {
  const url = `${String(baseURL).replace(/\/+$/, "")}/chat/completions`
  const sentinels = ["effort-discovery-probe", "ultra", "maximum", "bogus"]
  let last = { levels: null, source: "error", at: Date.now() }
  let sawOk = false

  for (const sentinel of sentinels) {
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

/** 用 agy 自己回答“这个模型支持哪些档位”（不联网，agi 的模型元数据说了算） */
export function agyAvailable(model) {
  try {
    const output = execSync(
      `agy -p "/effort" --output-format json --model ${JSON.stringify(model)}`,
      { encoding: "utf8", timeout: 60_000, windowsHide: true },
    )
    const json = JSON.parse(output.trim().split("\n").at(-1))
    const data = json?.command?.data
    if (!data) return undefined
    if (data.adjustable === false) return []
    return Array.isArray(data.available) ? data.available : undefined
  } catch {
    return undefined
  }
}