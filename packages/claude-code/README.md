# @tscgoods/claude-code-effort-discovery

Claude Code 插件：探测你的网关对每个模型**真正接受**的 reasoning effort 档位，并把 `/effort` 收窄到这些档位。

Claude Code 2.1.x 里 effort 是 `low / medium / high / xhigh / max`（客户端固定枚举），但网关不一定会全部接受。插件做三件事：

1. **探测**：对 `{ANTHROPIC_BASE_URL}/v1/messages` 用 `output_config.effort` 从 `max` 往 `low` 逐级试，2xx 即视为可用；
2. **报告**：会话启动 / 切换模型时，把“当前模型支持哪些档位”作为 systemMessage + additionalContext 交给 Claude；
3. **收窄**：按需把 `maxEffortLevel` 写进 `~/.claude/settings.json`，让 `/effort` 选择器不再展示高于实测上限的档位。

## 依赖

- Claude Code ≥ 2.1.267（`maxEffortLevel` 需要该版本）
- Node ≥ 20
- 共享配置 `~/.config/effort-discovery.json`（也供 OpenCode / Codex / dsh / agy 插件使用）

```jsonc
{
  "providers": {
    "claude-proxy": {
      "api": "anthropic",
      "baseURL": "http://127.0.0.1:7891",
      "apiKey": "{env:ANTHROPIC_AUTH_TOKEN}",
      "models": ["ccs-claude-newapi--deepseek-v4.1-flash-1017[1m]"]
    }
  }
}
```

没配置也能用：插件会退回读 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 和 `modelPicker.options` 里的模型别名。

## 网关别名映射（重要）

Claude 的网关别名（如 `ccs-claude-newapi--deepseek-v4.1-flash-1017[1m]`）通常**不校验** `output_config.effort`——传 `bogus` 也返回 200。这时插件只能诚实报 `no-validation`，不会凭空写档位。

如果你在**另一个 OpenAI 兼容网关**上已经探测到同一模型的真实档位，可以在共享配置里建立别名映射，让会话启动时注入真相：

```jsonc
// ~/.config/effort-discovery.json
{
  "aliases": {
    "ccs-claude-newapi--deepseek-v4.1-flash-1017[1m]": "deepseek-v4.1-flash-1017"
  }
}
```

插件会读 `~/.cache/effort-discovery/` 下所有缓存（`cache.json` / `dsh.json` / `claude-code.json`），按别名找到实测档位，在 SessionStart 注入：

```
⚠ 不要选 medium / xhigh：Claude 的选择器仍会显示它们，但网关实测不支持/会忽略。
```

**注意**：Claude Code 只有 `maxEffortLevel`（上限封顶）一个杠杆，没法隐藏中间档位；这个方案是"注入提醒"，不改选择器。

## 档位菜单的硬限制与取舍（v2.1.330）

Claude Code 的档位枚举固定为 `low / medium / high / xhigh / max`，选择器只返回它的**前缀**，再 optionally 用布尔开关删掉 `xhigh` / `max`。**没有配置项能删掉中间的 `medium`**；`*_SUPPORTED_CAPABILITIES` 环境变量在 `ANTHROPIC_BASE_URL` 网关场景下被客户端硬 gate 掉（实测无效）。因此 `{low, high, max}` 这种非连续集合在 Claude Code 里无法表达。

三种可实现的折中：

| 方案 | 效果 | 代价 |
|---|---|---|
| **本插件的注入提示**（默认推荐） | 菜单不变，但每次会话明确告知实测档位与禁用项 | 需要你/模型遵守提示 |
| `modelPicker[].behavesAs: "claude-opus-4-6"` | 去掉 `xhigh`，剩 `low/medium/high/max` | `medium` 仍在；会连带继承该已知模型的其它能力/默认值 |
| `CLAUDE_CODE_EFFORT_LEVEL=auto` | 所有请求都不带 `output_config.effort`，绝不会发错值 | 完全失去档位控制 |
| `CLAUDE_CODE_EXTRA_BODY='{"output_config":{"effort":"low"}}'` | 把 wire 上的 effort 固定成一个值 | 绕过选择器和 `maxEffortLevel`；不能定义集合，只适合网关想完全忽略客户端 effort |

另有完整文件扫描排除的载体：`effort_step_keybinding` 只是在现有前缀里步进、`supportedEffortLevels` 只是上报字段、`CLAUDE_CODE_MODEL_CATALOG` 在第三方/网关场景被强制关闭、`defaultEffortLevel` 只是起点不是锁。

`behavesAs` 示例（只需改你自己的 `~/.claude/settings.json`）：

```json
{
  "modelPicker": {
    "replaceBuiltInOptions": true,
    "options": [
      {
        "model": "ccs-claude-newapi--deepseek-v4.1-flash-1017[1m]",
        "label": "deepseek-v4.1-flash-1017",
        "behavesAs": "claude-opus-4-6"
      }
    ]
  }
}
```

等价写法：`"modelOverrides": { "claude-opus-4-6": "ccs-claude-newapi--deepseek-v4.1-flash-1017[1m]" }`，然后用 `--model claude-opus-4-6` 启动。`modelOverrides` / `behavesAs` 确实验证过会导入已知模型的能力表（`xhigh` 会被降级成 `high`），但没有任何已知模型提供 `{low, high, max}`。

> 插件不会自动改 `settings.json` 或加 `behavesAs`——这属于你会话配置的取舍，需要你显式决定。

## 安装

开发期（就地加载，改完 `/reload-plugins` 生效）：

```powershell
claude --plugin-dir C:\Users\蒋老师\projects\opencode-effort-discovery\packages\claude-code
```

从 npm 安装后本地加载：

```powershell
npm i -g @tscgoods/claude-code-effort-discovery
claude --plugin-dir "$env:APPDATA\npm\node_modules\@tscgoods\claude-code-effort-discovery"
```

或放进 marketplace 后 `claude plugin install`。

## 用法

| 命令 | 作用 |
| --- | --- |
| `/effort-discovery:probe-effort` | 现场探测（每个模型每档一次极小请求），结果缓存到 `~/.cache/effort-discovery/claude-code.json` |
| `/effort-discovery:apply-effort` | 打印 dry-run 计划；确认后加 `--write` 写入 `maxEffortLevel`（自动备份） |

直接跑脚本也行：

```powershell
node packages\claude-code\scripts\probe.mjs --provider claude-proxy --json
node packages\claude-code\scripts\apply.mjs              # dry-run
node packages\claude-code\scripts\apply.mjs --write    # 写入 + 备份
```

## 生效判定

- `maxEffortLevel` 是客户端封顶：超过它的档位不出现在 `/effort` 选择器里，`--effort` 指定更高值时按封顶运行。
- 自定义网关别名可能匹配不上 `modelSettings`，此时用 `--global` 设顶层 `maxEffortLevel` 兜底。
- 如果 Claude Code 压根不给这个模型发 effort 参数（`statusLine` 里没有 `effort.level`），在 `settings.json` 的 `env` 里加 `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`（插件不会自动改这一项）。

## 注意

- 探测是**真实请求**（`max_tokens: 16`），每个模型最多 5 次；请只在自有网关上用。
- 网关若“接受任何值但不生效”，探测会得到 `validated` 但可能是假象——README 里不掩饰这点，脚本支持逐级证据（`source` 字段）供你判断。
- 插件不会自动改 `settings.json`：写入只发生在你显式执行 `--write` 或调用 apply 技能时。