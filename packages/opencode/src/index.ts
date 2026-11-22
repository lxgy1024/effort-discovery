import { Plugin } from "@opencode/plugin"
import {
  DEFAULT_TTL_MS,
  buildCatalog,
  normalizeBaseURL,
  probeEffort,
  resolveSecret,
  type CatalogMap,
  type ProbeResult,
} from "@tscgoods/effort-discovery-core"

/**
 * effort-discovery for OpenCode
 *
 * 让 reasoning effort 档位和「模型真正支持的档位」一致。
 *
 * 档位来源优先级：
 *  1. options.overrides —— 手动指定
 *  2. 上游错误回声 —— 发一个非法 reasoning_effort，读回
 *       valid levels: none, low, high, max
 *       unknown variant `x`, expected one of `none`, `minimal`, ...
 *  3. models.dev —— 模型发布方在目录里声明的 reasoning_options
 *  4. 都没有 —— 保持 OpenCode 原有展示（不猜、不删）
 */

const PROBE_GAP_MS = 300
const MAP_KEY = "modelsdev/effort/v3"

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export default Plugin.define({
  id: "effort-discovery",
  async setup(ctx) {
    const options = (isObject(ctx.options) ? ctx.options : {}) as Options
    const targets = Array.isArray(options.providers) ? options.providers : []
    const ttlMs = typeof options.ttlMs === "number" ? options.ttlMs : DEFAULT_TTL_MS
    const catalogTtlMs =
      typeof options.catalogTtlMs === "number" ? options.catalogTtlMs : 24 * 60 * 60 * 1000
    const overrides = isObject(options.overrides)
      ? (options.overrides as Record<string, Record<string, string[]>>)
      : {}
    const debug = options.debug === true
    const log = (...args: unknown[]) => {
      if (debug) console.log("[effort-discovery]", ...args)
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
        const modelID = String(model.modelID ?? model.id)
        const levels = resolveLevels(providerID, modelID)
        if (!levels) continue
        const current = (model.variants ?? []).map((variant) => variant.id).join(",")
        if (current === levels.join(",")) continue
        model.variants = toVariants(levels) as typeof model.variants
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
          const response = await fetch("https://models.dev/api.json", {
            signal: AbortSignal.timeout(30_000),
          })
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

          for (const model of models.filter((item) => item.providerID === provider.id)) {
            const id = cacheKey(provider.id, model.modelID)
            const previous = probes.get(id)
            const stale =
              !previous || previous.source.startsWith("http-") || Date.now() - previous.at >= ttlMs
            if (!stale) continue

            const result = await probeEffort({
              baseURL,
              apiKey,
              modelID: model.modelID,
              headers,
            })

            if (result.source === "error") {
              log("probe failed", provider.id, model.modelID)
              continue
            }
            if (result.source === "http-429" || result.source.startsWith("http-5")) {
              log("rate limited", provider.id, result.source)
              limited = true
              break
            }

            const before = previous?.levels?.join(",") ?? "<none>"
            const after = result.levels?.join(",") ?? "<none>"
            if (before !== after) changed = true
            probes.set(id, result)
            await ctx.storage.set(storageKey(provider.id, model.modelID), { ...result })
            log(provider.id, model.modelID, before, "->", after, result.source)
            await sleep(PROBE_GAP_MS)
          }
        }
        return { changed, limited }
      }

      let changed = false
      for (let round = 0; round < 5; round++) {
        const result = await runProbes()
        if (result.changed) changed = true
        if (!result.limited) break
        const waitMs = 60_000 * (round + 1)
        log("backing off", waitMs)
        await sleep(waitMs)
      }

      if (changed || probes.size > 0) await ctx.model.reload()
    }

    void bootstrap().catch((error) => log("bootstrap failed", error))
  },
})