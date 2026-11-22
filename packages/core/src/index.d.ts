export type ProbeResult = {
  /** 上游声明的合法档位；null 表示上游不校验、无法确定 */
  levels: string[] | null
  /** validated | no-validation | http-<status> | error */
  source: string
  at: number
}

export type CatalogMap = {
  at: number
  owner: Record<string, string[]>
  byProvider: Record<string, string[]>
}

export const PROBE_SENTINEL: string
export const DEFAULT_TTL_MS: number
export const CATALOG_TTL_MS: number
export const MODELSDEV_URL: string
export const PROBE_TIMEOUT_MS: number
export const KNOWN_EFFORTS: string[]
export const CATALOG_KEY: string

export function normalizeBaseURL(input: unknown): string | undefined
export function resolveSecret(value: unknown): string | undefined
export function parseLevels(text: string): string[] | null
export function probeEffort(input: {
  baseURL: string
  apiKey?: string
  modelID: string
  headers?: Record<string, string>
  timeoutMs?: number
  sentinels?: string[]
}): Promise<ProbeResult>

export const ANTHROPIC_EFFORT_BETA: string
export const ANTHROPIC_EFFORT_LADDER: string[]

export function probeAnthropicEffort(input: {
  baseURL: string
  apiKey?: string
  modelID: string
  headers?: Record<string, string>
  timeoutMs?: number
  ladder?: string[]
}): Promise<ProbeResult>
export function buildCatalog(json: unknown): Omit<CatalogMap, "at">
export function catalogLevels(
  catalog: CatalogMap | undefined,
  providerID: string,
  modelID: string,
): string[] | undefined
export function cacheDir(): string
export function configPath(): string
export function loadConfig(): Promise<Record<string, unknown>>
export function loadCatalog(options?: {
  dir?: string
  ttlMs?: number
}): Promise<CatalogMap | undefined>
export function resolveLevels(input: {
  probe?: ProbeResult
  catalog?: CatalogMap
  providerID: string
  modelID: string
}): string[] | undefined

export class FileCache {
  constructor(dir?: string)
  get(providerID: string, modelID: string): Promise<ProbeResult | undefined>
  set(providerID: string, modelID: string, result: ProbeResult): Promise<ProbeResult>
  all(): Promise<Record<string, ProbeResult>>
}