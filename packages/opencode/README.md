# @tscgoods/opencode-effort-discovery

OpenCode 插件：让 `/models` 里的 reasoning effort 档位**只**出现你的网关真正接受的那些。

## 安装

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@tscgoods/opencode-effort-discovery@0.3.0",
      "options": {
        "providers": ["ts-dpsk"],
        "debug": false
      }
    }
  ]
}
```

不写 `providers` 时，默认处理所有 `@ai-sdk/openai-compatible` provider（自建网关、中转站）。

## 原理

档位来源优先级：

1. `options.overrides` 手动指定；
2. 上游错误回显（发一个非法 `reasoning_effort`，读回 `valid levels: …` 或 `expected one of …`）；
3. models.dev 目录声明（同 provider 优先，其次 canonical owner）；
4. 都没有 → 保持 OpenCode 原有展示，不猜也不删。

探测结果按 TTL（默认 6 小时）缓存在插件 storage，重启后立即可用。

## 选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `providers` | `[]` | 只处理这些 provider id；留空 = 所有 openai-compatible provider |
| `ttlMs` | `21600000` | 探测缓存有效期 |
| `catalogTtlMs` | `86400000` | models.dev 目录缓存有效期 |
| `overrides` | `{}` | `{ "<providerID>": { "<modelID>": ["low","high","max"] } }` |
| `debug` | `false` | 输出调试日志 |

## 注意

- 密钥支持明文、`{env:NAME}`、`!command` 三种写法（与 OpenCode provider 配置一致）。
- 遇到 429/5xx 会保留旧结论并退避重试，不会把免费额度打光。
- 如果某个会话固定了一个被判定不可用的档位，会报 `VariantUnavailableError`，重新选一次模型即可。