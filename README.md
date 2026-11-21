# opencode-effort-discovery

OpenCode 插件：让 reasoning effort 档位和「模型真正支持的档位」一致，并**只**展示有依据的档位。

## 为什么需要它

OpenCode 的档位（low / medium / high / max …）来自模型目录元数据（models.dev）。私有网关、自建 OpenAI 兼容服务、中转站不在目录里，OpenCode 就退回到内置默认值 `low / medium / high`——通常既缺 `max`，又错在多了 `medium`。

插件对每个模型发一次 `max_tokens: 1` 的探针请求，故意带一个非法的 `reasoning_effort`。多数网关会校验并回显合法值，例如：

```
level "x" not supported, valid levels: none, low, high, max
unknown variant `x`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
```

插件解析这段回显，把结果写成 variant。

## 档位来源优先级

1. `options.overrides` —— 手动指定
2. 上游错误回声 —— 最精确，针对你的网关
3. models.dev —— 模型发布方在目录里的 `reasoning_options`
4. 都没有 —— 保持 OpenCode 原有展示（不猜、不删）

## 默认范围

默认处理**所有** `@ai-sdk/openai-compatible` provider（自建网关、中转站都在这一类）。官方 provider（anthropic / openai / opencode …）本来就有目录元数据，不打扰。

## 安装

```jsonc title="opencode.jsonc"
{
  "plugins": [
    {
      "package": "opencode-effort-discovery",
      "options": {
        "debug": true
      }
    }
  ]
}
```

## 选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `providers` | `[]` | 只处理这些 provider id；留空 = 所有 openai-compatible provider |
| `ttlMs` | `21600000` | 探测缓存有效期（6 小时） |
| `catalogTtlMs` | `86400000` | models.dev 目录缓存有效期（24 小时） |
| `overrides` | `{}` | 手动指定：`{ "<providerID>": { "<modelID>": ["low","high","max"] } }` |
| `debug` | `false` | 输出调试日志 |

## 细节

- 密钥支持三种写法：明文、`{env:NAME}`、OpenCode 的 `!command`（插件会执行并读取输出），所以存在文件里的 key 也能用来探测。
- 每个模型一次极小请求（1 个补全 token），`ttlMs` 内不重复。
- 遇到 429 / 5xx 时保留上次结论，并停止该 provider 本轮剩余探测，避免把免费额度打光。
- 探测失败（网络/鉴权）不覆盖旧结果。

## 注意

- 如果某个会话已经固定某个档位，而该档位被判定不可用并移除，会报 `VariantUnavailableError`，重新选一次模型即可。
- 探测不出结论的模型（网关不校验、目录也没有）保持 OpenCode 默认档位——插件不会凭空造档位。