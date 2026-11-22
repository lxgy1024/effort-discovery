#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { cachePath, readJson } from "./lib.mjs"

// SessionStart / PostModelSwitch hook: 只读缓存，不联网、不改文件
let input = {}
try {
  const raw = readFileSync(0, "utf8")
  if (raw.trim().length > 0) input = JSON.parse(raw)
} catch {}

const cache = readJson(cachePath())
if (!cache || !cache.models) process.exit(0)

const currentModel =
  input?.model?.id ?? input?.to_model ?? input?.model_id ?? input?.requested_model ?? undefined

const entries = Object.entries(cache.models).filter(([, info]) => Array.isArray(info.levels))
if (entries.length === 0) process.exit(0)

const describe = ([model, info]) => `${model}: ${info.levels.join(" / ")} (${info.source})`
const current = currentModel
  ? entries.find(([model]) => model === currentModel || currentModel.includes(model))
  : undefined

const lines = current
  ? [`当前模型支持: ${describe(current)}`, `其他模型: ${entries.filter(([m]) => m !== current[0]).map(describe).join("; ") || "无"}`]
  : entries.map(describe)

const summary = lines.join("\n").slice(0, 9000)
const age = Math.round((Date.now() - (cache.at ?? Date.now())) / 60000)

const message =
  `effort-discovery: ${current ? `${current[0]} 支持 ${(current[1].levels ?? []).join(", ")}` : "已缓存模型档位"}` +
  `（${age} 分钟前探测；/effort-discovery:probe-effort 可刷新）`

process.stdout.write(
  JSON.stringify({
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: input?.hook_event_name ?? "SessionStart",
      additionalContext:
        `网关的 reasoning effort 探测结果（缓存 ${age} 分钟前）：\n${summary}\n` +
        `选择档位时只使用列出的级别；未列出的级别会被网关拒绝或忽略。`,
    },
  }) + "\n",
)