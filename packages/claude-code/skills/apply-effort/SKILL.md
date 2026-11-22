---
description: 把 Claude Code 的 /effort 上限收窄到网关实测支持的档位（默认 dry-run）
argument-hint: "[--write] [--global] [--model <alias> ...]"
allowed-tools: Bash(node:*), Read, Edit
disable-model-invocation: false
---

## 计划中的改动（dry-run）

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/apply.mjs" $ARGUMENTS`

## 你的任务

1. 先解释上面这份 dry-run 计划：哪个模型会被设成哪个 `maxEffortLevel`。
2. 说明 `maxEffortLevel` 是 Claude Code 客户端侧的封顶：超过它的档位在 `/effort` 选择器里不再出现，
   `--effort`/`/effort` 指定更高档位时按封顶值运行。
3. **必须先获得用户明确同意**，才执行写入：

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply.mjs" --write
```

   （写前会自动生成 `settings.json.bak-<时间戳>` 备份。）

4. 写完后提醒用户：
   - 跑 `/effort status`、打开 `/effort` 选择器确认档位范围；
   - 自定义网关别名可能匹配不上 `modelSettings`，此时用 `--global` 设顶层 `maxEffortLevel` 兜底；
   - 如果 Claude Code 根本不给这个模型发 effort 参数，需要在 `settings.json` 的 `env` 里加
     `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`（这属于改动配置，同样要先征得同意）。