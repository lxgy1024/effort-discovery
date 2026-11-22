#!/usr/bin/env node
import { readFileSync } from "node:fs"
import {
  CLAUDE_LEVELS,
  cachePath,
  findProbe,
  loadAliases,
  readJson,
  unsupportedClaudeLevels,
} from "./lib.mjs"

// SessionStart / PostModelSwitch hook：只读缓存，不联网、不改配置
let input = {}
try {
  const raw = readFileSync(0, "utf8")
  if (raw.trim().length > 0) input = JSON.parse(raw)
} catch {}

const aliases = loadAliases()
const modelName = input?.model?.id ?? input?.to_model ?? input?.model_id ?? input?.requested_model ?? ""
const probe = modelName ? findProbe(modelName, aliases) : undefined

const lines = []

if (probe?.levels?.length) {
  const supported = probe.levels.filter((level) => CLAUDE_LEVELS.includes(level))
  const unsupported = unsupportedClaudeLevels(probe.levels)
  const canonical = aliases[modelName]
  lines.push(
    `${modelName} 的网关实测档位: ${probe.levels.join(" / ")}（证据: ${probe.source}, ${probe.from}）`,
  )
  if (canonical) lines.push(`网关别名映射: ${modelName} → ${canonical}`)
  if (unsupported.length > 0) {
    lines.push(
      `⚠ 不要选 ${unsupported.join(" / ")}：Claude 的选择器仍会显示它们，但网关实测不支持/会忽略。`,
    )
  } else {
    lines.push("实测档位覆盖 Claude 的全部选项，可以放心选择。")
  }
} else {
  // 没有证据：明确说明，而不是编造
  lines.push(
    `${modelName || "当前模型"}: 网关未给出可信的 effort 声明（no-validation），插件不改写档位。`,
  )
  if (probe) lines.push(`最近一次探测: ${probe.source}（${probe.from}）`)
  if (modelName && !aliases[modelName]) {
    lines.push("提示: 可在 ~/.config/effort-discovery.json 的 aliases 里把该别名映射到真实模型 id。")
  }
}

const cache = readJson(cachePath())
if (cache?.models) {
  const others = Object.entries(cache.models)
    .filter(([model]) => model !== modelName)
    .map(([model, info]) => `${model}: ${(info.levels ?? []).join(" ") || "unknown"}`)
  if (others.length > 0) lines.push(`其他模型缓存: ${others.join("; ")}`)
}

const age = probe?.at ? Math.round((Date.now() - probe.at) / 60000) : null
const message =
  `effort-discovery${age !== null ? `（${age} 分钟前探测）` : ""}:\n${lines.join("\n")}\n` +
  `刷新请运行 /effort-discovery:probe-effort。`

process.stdout.write(
  JSON.stringify({
    systemMessage: message.slice(0, 1000),
    hookSpecificOutput: {
      hookEventName: input?.hook_event_name ?? "SessionStart",
      additionalContext: `网关 effort 实测结果：\n${lines.join("\n")}`,
    },
  }) + "\n",
)