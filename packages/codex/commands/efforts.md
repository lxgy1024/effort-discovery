---
description: 探测网关真正支持的 reasoning effort 档位，并生成/更新 Codex model catalog
argument-hint: "[--write]"
allowed-tools: Bash(node:*)
---

# /efforts

1. 运行 `node "${PLUGIN_ROOT}/scripts/probe.mjs"` 并展示 **模型 / 可用档位 / 证据** 表格。
2. 再运行 `node "${PLUGIN_ROOT}/scripts/guard.mjs"` 展示将要修补的 catalog 条目（dry-run，就地修，能抵抗 cc-switch 覆盖）。
3. 只有用户明确同意后，才执行 `--write`；若用户需要长期防覆盖，可建议 `guard.mjs --watch` 前台常驻。
4. 任何 `(unknown)` 的模型都明确说明“网关不校验，无法确定”，不要写进 catalog。