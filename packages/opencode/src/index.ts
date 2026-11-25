import { Plugin } from "@opencode/plugin"
import { execSync } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * effort-discovery
 *
 * 让 OpenCode 的 reasoning effort 档位和「模型真正支持的档位」一致。
 *
 * 每个模型的档位来源优先级：
 *  1. options.overrides —— 手动指定
 *  2. 上游错误回声 —— 发一个非法 reasoning_effort，读回
 *       valid levels: none, low, high, max
 *       unknown variant `x`, expected one of `none`, `minimal`, ...
 *  3. models.dev —— 模型发布方在目录里声明的 reasoning_options
 *  4. 都没有 —— 保持 OpenCode 原有展示（不猜、不删）
 *
 * 默认处理所有 OpenAI 兼容 provider（自建网关/中转站都落在这里）；
 * 官方 provider 有目录元数据，不打扰。
 */

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
const MODELSDEV_URL = "https://models.dev/api.json"
const MAP_KEY = "modelsdev/effort/v2"
const PROBE_VALUE = "opencode-probe"
const PROBE_TIMEOUT_MS = 20_000
const PROBE_GAP_MS = 300

export type ProbeResult = {
  /** 上游声明的合法档位；null 表示上游不校验、无法确定 */
  levels: string[] | null
  /** validated | no-validation | http-<status> | error */
  source: string
  at: number
}

export type Options = {
  /** 要处理的 provider id；留空则处理所有 openai-compatible provider */
  providers?: string[]
  /** 探测缓存有效期（毫秒） */
  ttlMs?: number
  /** models.dev 目录缓存有效期（毫秒） */
  catalogTtlMs?: number
  /** 手动指定档位：{ "<providerID>": { "<modelID>": ["low","high","max"] } } */
  overrides?: Record<string, Record<string, string[]>>
  debug?: boolean
}

type CatalogMap = {
  at: number
  /** 发布方自己（canonical owner）声明：按模型 id */
  owner: Record<string, string[]>
  /** 各 provider 自己的声明：按 "<providerID>/<modelID>" */
  byProvider: Record<string, string[]>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalizeBaseURL = (input: unknown): string | undefined => {
  if (typeof input !== "string" || input.length === 0) return undefined
  return input.replace(/\/+$/, "").replace(/\/chat\/completions$/, "")
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 解析 provider 配置里的密钥：支持 `!command`、`{env:NAME}` 与明文 */
export function resolveSecret(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const raw = value.trim()
  if (raw.length === 0) return undefined

  const env = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw)
  if (env) {
    const found = process.env[env[1]]
    return found && found.trim().length > 0 ? found.trim() : undefined
  }

  if (raw.startsWith("!")) {
    const command = raw.slice(1).trim()
    if (command.length === 0) return undefined
    try {
      const output = execSync(command, { encoding: "utf8", timeout: 10_000, windowsHide: true })
      const text = String(output).trim()
      return text.length > 0 ? text : undefined
    } catch {
      return undefined
    }
  }

  return raw
}

/** 从上游错误文本中解析合法档位（兼容多种报错格式） */
export function parseLevels(text: string): string[] | null {
  const clean = (input: string) =>
    input
      .split(",")
      .map((item) => item.trim().replace(/^[`'"\s]+|[`'"\s.]+$/g, "").toLowerCase())
      .filter((item) => /^[a-z0-9_-]+$/.test(item))

  // 只匹配逗号分隔的档位名，避免把 JSON 里的 "type":"invalid_request_error" 吞进来
  const list = "[a-z0-9_-]+(?:\\s*,\\s*[a-z0-9_-]+)*"

  const valid = new RegExp(`valid levels?:\\s*(${list})`, "i").exec(text)
  if (valid) {
    const levels = clean(valid[1])
    if (levels.length > 0) return levels
  }

  // "unknown variant `x`, expected one of `none`, `minimal`, `low`, ..."
  const expected = /expected one of\s+([^\n]*)/i.exec(text)
  if (expected) {
    const tokens = [...expected[1].matchAll(/`([a-z0-9_-]+)`/gi)].map((match) =>
      match[1].toLowerCase(),
    )
    if (tokens.length > 0) return tokens
  }

  // "supported levels are low|medium|high|max"
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

/** 用非法值探一次，读回上游自己声明的合法档位；个别网关只对特定非法值透传上游报错 */
export async function probeEffort(input: {
  baseURL: string
  apiKey?: string
  modelID: string
  headers?: Record<string, string>
}): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(input.headers ?? {}),
  }
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`

  let last: ProbeResult = { levels: null, source: "error", at: Date.now() }
  let sawOk = false

  for (const sentinel of ["opencode-probe", "ultra", "maximum", "bogus"]) {
    let response: Response
    try {
      response = await fetch(`${input.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: input.modelID,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
          reasoning_effort: sentinel,
        }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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

/** 从 models.dev 的原始 JSON 里抽出 effort 档位索引 */
export function buildCatalog(json: unknown): Omit<CatalogMap, "at"> {
  const owner: Record<string, string[]> = {}
  const byProvider: Record<string, string[]> = {}
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
        ? (effort.values as unknown[]).filter((value): value is string => typeof value === "string")
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

export default Plugin.define({
  id: "effort-discovery",
  async setup(ctx) {
    const options = (isObject(ctx.options) ? ctx.options : {}) as Options
    const targets = Array.isArray(options.providers) ? options.providers : []
    const ttlMs = typeof options.ttlMs === "number" ? options.ttlMs : DEFAULT_TTL_MS
    const catalogTtlMs =
      typeof options.catalogTtlMs === "number" ? options.catalogTtlMs : CATALOG_TTL_MS
    const overrides = isObject(options.overrides)
      ? (options.overrides as Record<string, Record<string, string[]>>)
      : {}
    const debug = options.debug === true
    // server 不捕获插件 stdout；debug 时同时写文件，保证可观测
    const debugFile = join(tmpdir(), "effort-discovery-opencode.log")
    const log = (...args: unknown[]) => {
      if (!debug) return
      const line = `[effort-discovery] ${args
        .map((item) => {
          if (typeof item === "string") return item
          try {
            return JSON.stringify(item)
          } catch {
            return String(item)
          }
        })
        .join(" ")}`
      try {
        appendFileSync(debugFile, `${new Date().toISOString()} ${line}\n`)
      } catch {
        mkdirSync(tmpdir(), { recursive: true })
      }
    }

    const probes = new Map<string, ProbeResult>()
    let catalog: CatalogMap | undefined

    const cacheKey = (providerID: string, modelID: string) => `${providerID}/${modelID}`
    const storageKey = (providerID: string, modelID: string) =>
      `effort/${cacheKey(providerID, modelID)}`
    const wanted = (providerID: string, pkg?: string) =>
      targets.length > 0
        ? targets.includes(providerID)
        : typeof pkg === "string" && pkg.includes("openai-compatible")

    const toVariants = (levels: string[]) =>
      levels.map((id) => ({ id, settings: { reasoningEffort: id } }))

    const catalogLevels = (providerID: string, modelID: string): string[] | undefined => {
      if (!catalog) return undefined
      const key = modelID.toLowerCase()
      return catalog.byProvider[`${providerID.toLowerCase()}/${key}`] ?? catalog.owner[key]
    }

    const resolveLevels = (providerID: string, modelID: string): string[] | undefined => {
      const override = overrides[providerID]?.[modelID]
      if (override) return override
      const probed = probes.get(cacheKey(providerID, modelID))
      if (probed?.levels) return probed.levels
      return catalogLevels(providerID, modelID)
    }

    // 1. 同步 transform：宁可不动，也不写没有依据的档位
    await ctx.model.transform((editor) => {
      const providerIDs = new Set(
        editor.provider
          .list()
          .filter((record) => wanted(record.provider.id, record.provider.package))
          .map((record) => record.provider.id),
      )
      for (const model of editor.list()) {
        const providerID = String(model.providerID)
        if (!providerIDs.has(providerID)) continue
        const modelID = String((model as { modelID?: string }).modelID ?? model.id)
        const levels = resolveLevels(providerID, modelID)
        if (!levels) continue
        const current = (model.variants ?? []).map((variant) => variant.id).join(",")
        if (current === levels.join(",")) continue
        log("transform", providerID, modelID, current || "<empty>", "->", levels.join(","))
        editor.update(providerID, model.id, (draft) => {
          draft.variants = toVariants(levels) as typeof draft.variants
        })
      }
    })

    // 2. 后台：探测缓存 -> 目录 -> 探测 -> 应用
    const bootstrap = async () => {
      try {
        let cursor: string | undefined
        for (let page = 0; page < 20; page++) {
          const result = await ctx.storage.scan({ prefix: "effort/", limit: 500, after: cursor })
          for (const entry of result.entries) {
            const rest = entry.key.slice("effort/".length)
            if (!rest.includes("/")) continue
            if (isObject(entry.value) && "levels" in entry.value) {
              probes.set(rest, entry.value as unknown as ProbeResult)
            }
          }
          if (!result.next) break
          cursor = result.next
        }
        log("probe cache", probes.size)
      } catch (error) {
        log("probe cache read failed", error)
      }

      try {
        const stored = await ctx.storage.get(MAP_KEY)
        if (isObject(stored) && isObject(stored.owner) && isObject(stored.byProvider)) {
          catalog = stored as unknown as CatalogMap
        }
        if (!catalog || Date.now() - catalog.at > catalogTtlMs) {
          const response = await fetch(MODELSDEV_URL, { signal: AbortSignal.timeout(30_000) })
          if (response.ok) {
            catalog = { at: Date.now(), ...buildCatalog(await response.json()) }
            await ctx.storage.set(MAP_KEY, {
              at: catalog.at,
              owner: catalog.owner,
              byProvider: catalog.byProvider,
            })
          }
        }
        log("catalog entries", catalog ? Object.keys(catalog.byProvider).length : 0)
      } catch (error) {
        log("catalog refresh failed", error)
      }

      if (probes.size > 0 || catalog) await ctx.model.reload()

      // provider/model 在 setup 阶段还没 materialize
      const deadline = Date.now() + 60_000
      let providers: Awaited<ReturnType<typeof ctx.provider.list>>["data"] = []
      let models: Awaited<ReturnType<typeof ctx.model.list>>["data"] = []
      while (Date.now() < deadline) {
        try {
          providers = ((await ctx.provider.list()).data ?? []).filter((item) =>
            wanted(item.id, item.package),
          )
          if (providers.length > 0) {
            const ids = new Set(providers.map((item) => item.id))
            models = ((await ctx.model.list()).data ?? []).filter((item) => ids.has(item.providerID))
            if (models.length > 0) break
          }
        } catch (error) {
          log("poll failed", error)
        }
        await sleep(1000)
      }
      if (providers.length === 0 || models.length === 0) {
        log("no target providers")
        return
      }
      log(
        "targets",
        providers.map((item) => item.id).join(","),
        "models",
        models
          .map((item) => `${item.providerID}/${String((item as { modelID?: string }).modelID ?? item.id)}`)
          .join(","),
      )

      const runProbes = async () => {
        let changed = false
        let limited = false
        for (const provider of providers) {
          const settings = (provider.settings ?? {}) as Record<string, unknown>
          const baseURL = normalizeBaseURL(settings.baseURL) ?? normalizeBaseURL(settings.api)
          const apiKey = resolveSecret(settings.apiKey)
          const headers = isObject(provider.headers)
            ? Object.fromEntries(
                Object.entries(provider.headers).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              )
            : {}
          if (!baseURL) {
            log("skip", provider.id, "no baseURL")
            continue
          }
          // 官方 zen 端点的模型在 models.dev 里有目录元数据，且端点对探测一律 400/429，不打扰
          try {
            const host = new URL(baseURL).hostname
            if (host === "opencode.ai" || host.endsWith(".opencode.ai")) {
              log("skip", provider.id, "zen endpoint uses catalog metadata")
              continue
            }
          } catch {
            // 非法 URL 照常尝试
          }

          for (const model of models.filter((item) => item.providerID === provider.id)) {
            const modelID = String((model as { modelID?: string }).modelID ?? model.id)
            const id = cacheKey(provider.id, modelID)
            const previous = probes.get(id)
            // error/429/5xx 视为可重试；http-400/404 等确定性答复在 TTL 内缓存，避免探测风暴
            const retryable =
              previous?.source === "error" ||
              previous?.source === "http-429" ||
              (previous?.source.startsWith("http-5") ?? false)
            const stale =
              !previous || retryable || Date.now() - previous.at >= ttlMs
            if (!stale) continue

            const result = await probeEffort({ baseURL, apiKey, modelID, headers })

            if (result.source === "error") {
              log("probe failed", provider.id, modelID)
              continue
            }
            // 限流/服务端错误：保留旧结论，下一轮再试
            if (result.source === "http-429" || result.source.startsWith("http-5")) {
              log("rate limited", provider.id, result.source)
              limited = true
              break
            }

            const before = previous?.levels?.join(",") ?? "<none>"
            const after = result.levels?.join(",") ?? "<none>"
            if (before !== after) changed = true
            probes.set(id, result)
            await ctx.storage.set(storageKey(provider.id, modelID), { ...result })
            log(provider.id, modelID, before, "->", after, result.source)
            await sleep(PROBE_GAP_MS)
          }
        }
        return { changed, limited }
      }

      // 遇到限流就退避重试，直到探测稳定或放弃；每轮结束立刻 reload，不等全部轮次
      for (let round = 0; round < 5; round++) {
        const result = await runProbes()
        if (result.changed || (round === 0 && probes.size > 0)) await ctx.model.reload()
        if (!result.limited) break
        const waitMs = 60_000 * (round + 1)
        log("backing off", waitMs)
        await sleep(waitMs)
      }
    }

    void bootstrap().catch((error) => log("bootstrap failed", error))
  },
})