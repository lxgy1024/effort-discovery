---
description: 探测当前网关对每个模型真正接受的 reasoning effort 档位（会发一次极小的真实请求）
argument-hint: "[--provider <id>] [--model <alias> ...]"
allowed-tools: Bash(node:*), Read
disable-model-invocation: false
---

## 探测结果

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/probe.mjs" $ARGUMENTS`

## 你的任务

上面是刚探测到的结果（`levels` 是网关真正接受的档位，`source` 是证据来源）。

1. 用一张表回复：模型 / 可用档位 / 证据。
2. 如果某个模型是 `(unknown)`，明确说明“网关不校验 reasoning_effort，无法确定”，不要猜。
3. 提醒用户：
   - 探测结果已缓存到 `~/.cache/effort-discovery/claude-code.json`，会话启动钩子会读这份缓存；
   - 想把 `/effort` 选择器收窄到实测档位，用 `/effort-discovery:apply-effort`（默认 dry-run，加 `--write` 才改 `~/.claude/settings.json`）。