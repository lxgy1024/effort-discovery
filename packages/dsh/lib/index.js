import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import z from "@deepseek-ai/schemastery"

export const name = "effort-discovery"

export const Config = z.object({
  /** transform: 用探测缓存收窄 llm-pi-ai 的 reasoningEfforts；off: 只提供工具 */
  mode: z.union([z.const("transform"), z.const("off")]).default("transform"),
  /** 探测缓存有效期（毫秒） */
  ttlMs: z.number().default(6 * 60 * 60 * 1000).volatile(),
})

const TARGET_ADAPTER = "@deepseek-ai/dsh-llm-pi-ai"
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"]

function cachePath() {
  const dir =
    process.env.EFFORT_DISCOVERY_HOME ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "effort-discovery")
  return join(dir, "dsh.json")
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
  if (current === false) return false

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
        if (fiber?.entry?.options?.name !== TARGET_ADAPTER) return raw
        const cache = readCache()
        if (!cache) return raw
        try {
          return transformProviders(raw, cache)
        } catch {
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