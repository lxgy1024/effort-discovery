# @tscgoods/effort-discovery-core

各宿主插件共用的核心：**探测模型真正接受的 reasoning effort 档位**，并附带一个零依赖 CLI。

## 原理

OpenAI 兼容接口不会在 `/v1/models` 里公布 effort 档位，但多数网关会校验 `reasoning_effort`，并把合法值写进错误信息：

```
level "x" not supported, valid levels: none, low, high, max
unknown variant `x`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
```

核心库发一个带非法值的极小请求（`max_tokens: 1`），解析这段回显。多个非法值会依次尝试（有些网关只对特定值透传上游校验）。

Anthropic Messages 协议（Claude Code / Antigravity 走的协议）则是用 `output_config.effort` 从 `max` 往 `low` 逐级试，`2xx` 视为该档位可用。

## 档位来源优先级

1. `overrides`（手动指定）
2. 上游错误回声（最精确）
3. models.dev 目录声明（同 provider 优先，其次 canonical owner）
4. 都没有 → 不猜、不改

## CLI

```bash
npx @tscgoods/effort-discovery-core providers
npx @tscgoods/effort-discovery-core probe --provider ts-dpsk --json
npx @tscgoods/effort-discovery-core get --provider ts-dpsk --model deepseek-v4.1-flash
npx @tscgoods/effort-discovery-core check --provider ts-dpsk --model deepseek-v4.1-flash --level max
npx @tscgoods/effort-discovery-core catalog
```

共享配置 `~/.config/effort-discovery.json`：

```jsonc
{
  "providers": {
    "ts-dpsk": {
      "api": "openai",
      "baseURL": "https://ai-api.transcircle.org/v1",
      "apiKey": "!type %USERPROFILE%\\.secrets\\dpsk.key",
      "models": ["deepseek-v4.1-flash", "gpt-6.1-terra"]
    },
    "claude-proxy": {
      "api": "anthropic",
      "baseURL": "http://127.0.0.1:7891",
      "apiKey": "{env:ANTHROPIC_AUTH_TOKEN}",
      "models": ["ccs-claude-newapi--deepseek-v4.1-flash-1017[1m]"]
    }
  }
}
```

`apiKey` 支持三种写法：明文、`{env:NAME}`、`!command`（执行并读取输出）。

缓存目录默认 `~/.cache/effort-discovery/`（`EFFORT_DISCOVERY_HOME` 可覆盖）：

- `cache.json`：每个 `provider/model` 的探测结果，6 小时有效；
- `catalog.json`：models.dev 索引，24 小时有效。

## API

```js
import { probeEffort, probeAnthropicEffort, parseLevels, loadCatalog, FileCache } from "@tscgoods/effort-discovery-core"

const probe = await probeEffort({ baseURL, apiKey, modelID })      // OpenAI 兼容
const anth  = await probeAnthropicEffort({ baseURL, apiKey, modelID }) // Anthropic Messages
// → { levels: ["low","high","max"] | null, source: "validated" | "no-validation" | "http-400" | "error", at }
```

`source` 的语义：

| source | 含义 |
| --- | --- |
| `validated` | 上游明确列出了合法档位 |
| `no-validation` | 上游接受任意值，无法确定 |
| `http-<code>` | 上游返回错误但没给档位列表 |
| `error` | 网络/超时，调用方应保留旧结论 |

## 测试

```bash
node --test packages/core/test/*.test.js
```