#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { cachePath, readJson } from "./lib.mjs"

let input = {}
try {
  const raw = readFileSync(0, "utf8")
  if (raw.trim()) input = JSON.parse(raw)
} catch {}

const cache = readJson(cachePath())
if (!cache?.models) process.exit(0)

const modelName = input?.modelName ?? ""
const entries = Object.entries(cache.models)
const current =
  entries.find(([model]) => modelName.includes(model) || model.includes(modelName)) ?? undefined

const describe = ([model, info]) =>
  `${model}: ${(info.effective ?? info.levels ?? []).join(", ") || "未知"}`

const lines = current
  ? [`当前模型 ${modelName} → ${describe(current)}`, `其他: ${entries.filter(([m]) => m !== current[0]).map(describe).join("; ") || "无"}`]
  : entries.map(describe)

const age = Math.round((Date.now() - (cache.at ?? Date.now())) / 60000)
const message =
  `effort-discovery：网关实测档位（${age} 分钟前）\n${lines.join("\n")}\n` +
  `只使用列出的档位；未列出的档位会被网关拒绝或忽略。需要刷新请运行 node scripts/probe.mjs --agy。`

process.stdout.write(
  JSON.stringify({
    injectSteps: [{ systemMessage: { systemMessage: message.slice(0, 9000) } }],
  }) + "\n",
)