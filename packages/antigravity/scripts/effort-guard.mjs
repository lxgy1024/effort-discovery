#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { AGY_LEVELS, cachePath, readJson } from "./lib.mjs"

// PreInvocation 守卫：用户/模型提到不支持的档位时提醒（只提醒，不终止会话）
let input = {}
try {
  const raw = readFileSync(0, "utf8")
  if (raw.trim()) input = JSON.parse(raw)
} catch {}

const cache = readJson(cachePath())
if (!cache?.models) process.exit(0)

const modelName = input?.modelName ?? ""
const entries = Object.entries(cache.models)
const current = entries.find(([model]) => modelName.includes(model) || model.includes(modelName))
if (!current) process.exit(0)

const supported = (current[1].effective ?? current[1].levels ?? []).filter((level) =>
  AGY_LEVELS.includes(level),
)
if (supported.length === 0) process.exit(0)

const text = String(input?.lastUserInput ?? "")
const mentioned = [...text.matchAll(/(?:--effort\s+|\/effort\s+)([a-z]+)/gi)].map((m) =>
  m[1].toLowerCase(),
)
const offending = mentioned.filter((level) => AGY_LEVELS.includes(level) && !supported.includes(level))
if (offending.length === 0) process.exit(0)

const message =
  `⚠️ ${current[0]} 实测只支持 ${supported.join(", ")}；` +
  `${offending.join(", ")} 会被网关拒绝或静默降级。`

process.stdout.write(
  JSON.stringify({
    injectSteps: [{ errorMessage: { userMessage: message } }],
  }) + "\n",
)