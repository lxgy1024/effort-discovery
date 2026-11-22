import { readFileSync, existsSync, appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import z from "@deepseek-ai/schemastery"

export const name = "effort-discovery"

export const Config = z.object({
  /** transform: 用探测缓存收窄 llm-pi-ai 的 reasoningEfforts；off: 只提供工具 */
  mode: z.union([z.const("transform"), z.const("off")]).default("transform"),
  /** 探测缓存有效期（毫秒） */
  ttlMs: z.number().default(6 * 60 * 60 * 1000).volatile(),
  /** 把每次配置变换的输入/输出写到 ~/.cache/effort-discovery/dsh-transform.log（排障用） */
  diag: z.boolean().default(false).volatile(),
})

const TARGET_ADAPTER = "dsh-llm-pi-ai"
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"]

function cacheDir() {
  return (
    process.env.EFFORT_DISCOVERY_HOME ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "effort-discovery")
  )
}

function cachePath() {
  return join(cacheDir(), "dsh.json")
}

function diag(line) {
  try {
    appendFileSync(join(cacheDir(), "dsh-transform.log"), new Date().toISOString() + " " + line + "\n")
  } catch {}
}

function readCache() {
  try {
    const raw = readFileSync(cachePath(), "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 把探测结果映射成 dsh 的 reasoningEfforts：
 * - 保留原有的 `off`（值是 null 表示“不发送 reasoning_effort”）
 * - 只保留网关实测接受的档位；一条都没有时返回 false（菜单里不再出现 effort）
 * - 原有键名视为“线上拼写”，沿用它的值
 */
export function narrowEfforts(model, levels) {
  if (!Array.isArray(levels) || levels.length === 0) return undefined
  const current = model?.reasoningEfforts
  // current === false 往往只是 YAML 里没配/手写了“不推理”，不是上游证据。
  // 既然探测到了档位，就以探测结果为准重新生成 map。
  const declared = current && typeof current === "object" ? current : {}
  const next = {}
  const accepted = new Set(levels)

  // 保留作者声明的 off（null = 不发送 reasoning_effort）
  if ("off" in declared) next.off = declared.off
  if (accepted.has("none") && !("off" in next)) next.off = null

  for (const level of LEVELS) {
    if (!accepted.has(level)) continue
    // 已有声明沿用作者写的线上拼写，否则用档位名本身
    next[level] = Object.hasOwn(declared, level) ? declared[level] : level
  }

  return Object.keys(next).filter((level) => level !== "off").length > 0 ? next : false
}

function transformProviders(raw, cache) {
  if (!raw || typeof raw !== "object" || !raw.providers || typeof raw.providers !== "object") {
    return raw
  }
  const providers = { ...raw.providers }
  let changed = false

  for (const [route, profile] of Object.entries(providers)) {
    if (!profile || typeof profile !== "object" || !Array.isArray(profile.models)) continue
    const models = profile.models.map((model) => {
      if (!model || typeof model.id !== "string") return model
      const info = cache?.models?.[model.id]
      if (!info || !Array.isArray(info.levels)) return model
      const reasoningEfforts = narrowEfforts(model, info.levels)
      if (reasoningEfforts === undefined) return model
      changed = true
      return { ...model, reasoningEfforts }
    })
    providers[route] = { ...profile, models }
  }

  return changed ? { ...raw, providers } : raw
}

export default {
  name,
  Config,
  apply(ctx, config) {
    const mode = config?.mode ?? "transform"

    // 1) 可选工具：让模型自己查看/刷新探测结果
    ctx.inject?.(['tools'], (scope) => {
      const tools = scope.tools
      if (!tools?.register) return
      scope.effect(() =>
        tools.register({
          name: "reasoning_effort_probe",
          description:
            "Show the cached gateway probe of reasoning effort levels. Action 'status' lists models and their accepted efforts.",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["status"], default: "status" },
            },
            additionalProperties: false,
          },
          execute: async () => {
            const cache = readCache()
            if (!cache?.models) {
              return { content: `no probe cache at ${cachePath()} — run: node scripts/probe.mjs` }
            }
            const lines = Object.entries(cache.models).map(
              ([model, info]) => `${model}: ${(info.levels ?? []).join(", ") || "unknown"} (${info.source})`,
            )
            return { content: `probe cache (${new Date(cache.at).toISOString()}):\n${lines.join("\n")}` }
          },
        }),
      )
    })

    // 2) 配置变换：只改 llm-pi-ai 这一行的 providers
    if (mode !== "transform") return
    ctx.on?.(
      "internal/config",
      (fiber, next) => {
        const raw = next()
        const entryName = String(fiber?.entry?.options?.name ?? "")
        if (!entryName.includes(TARGET_ADAPTER)) return raw
        const cache = readCache()
        if (!cache) {
          if (config?.diag) diag(`no cache at ${cachePath()}`)
          return raw
        }
        try {
          const next = transformProviders(raw, cache)
          if (config?.diag) {
            const before = []
            for (const profile of Object.values(raw?.providers ?? {})) {
              for (const model of profile?.models ?? []) before.push(`${model.id}=${JSON.stringify(model.reasoningEfforts)}`)
            }
            const after = []
            for (const profile of Object.values(next?.providers ?? {})) {
              for (const model of profile?.models ?? []) after.push(`${model.id}=${JSON.stringify(model.reasoningEfforts)}`)
            }
            diag(`entry=${entryName}\n  before: ${before.join(" | ")}\n  after:  ${after.join(" | ")}`)
          }
          return next
        } catch (error) {
          if (config?.diag) diag(`transform failed: ${String(error)}`)
          return raw
        }
      },
      { global: true },
    )
  },
}

export function __diag() {
  return { cachePath: cachePath(), exists: existsSync(cachePath()) }
}