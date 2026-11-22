---
name: effort-probe
description: 探测网关真正接受的 reasoning effort 档位（会发极小的真实请求），并与 agy 自己的模型枚举交叉验证
---

# Effort Probe

agy 的 `--effort` 只有 `low | medium | high | xhigh | max`，但具体某个模型接受哪些档位由 agy 的模型元数据决定——而网关（尤其自建/中转）不一定都认。

## 步骤

1. 运行探测（默认取 `~/.config/effort-discovery.json` 里第一个 openai provider）：

```bash
node "${PLUGIN_ROOT}/scripts/probe.mjs" --agy --json
```

2. 用表格汇报：
   - `gateway levels`：网关实测接受的档位（来自非法值错误回显）；
   - `agy levels`：agy 自己的 `/effort` 对同一模型给出的可用档位；
   - `source`：`validated` / `no-validation` / `http-*`。
3. 说明交集：agi 菜单里能选、且网关真的接受的，才是安全选项。
4. 如果 agy 的枚举比网关宽，提醒用户：选择多出来的档位会被网关拒绝或静默降级。

## 规则

- `no-validation` 表示网关接受任意值、无法确定真实支持范围——直说，不要猜。
- 探测会真实发请求（每个模型最多 4 次，`max_tokens: 1`），只在自有网关上跑。
- 不要把探测结果写进 agy 的 `settings.json`；`customModels` 生成属于单独的高级操作，需要用户明确同意。
- 用户想把网关模型加进 agy 时，运行 `node "${PLUGIN_ROOT}/scripts/emit-custom-models.mjs"` 先看片段，确认后再 `--write`；明确说明 `thinkingLevel` 只能是 low/medium/high。