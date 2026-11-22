---
description: 探测网关真正支持的 reasoning effort 档位，并生成/更新 Codex model catalog
argument-hint: "[--write]"
allowed-tools: Bash(node:*)
---

# /efforts

1. 运行 `node "${PLUGIN_ROOT}/scripts/probe.mjs"` 并展示 **模型 / 可用档位 / 证据** 表格。
2. 再运行 `node "${PLUGIN_ROOT}/scripts/sync-catalog.mjs"` 展示将要修改的 catalog 条目（dry-run）。
3. 只有用户明确同意后，才执行 `--write`，并提醒设置 `model_catalog_json`。
4. 任何 `(unknown)` 的模型都明确说明“网关不校验，无法确定”，不要写进 catalog。