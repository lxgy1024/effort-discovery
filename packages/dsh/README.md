# @tscgoods/dsh-effort-discovery

DeepSeek Harness（`dsh`）插件 bundle：探测网关真正接受的 reasoning effort 档位，并把 `llm-pi-ai` 里每个模型的 `reasoningEfforts` 收窄到实测结果——模型选择器的 Effort 菜单只显示这些档位。

## 为什么需要

dsh 的档位菜单来自 provider 配置（`llm-pi-ai` 的 `providers.<route>.models[].reasoningEfforts`），而这份配置通常是手写的猜测：

```yaml
# 常见的手写结果：deepseek 只写了 max，terra 写了全集
reasoningEfforts: { 'off': null, max: max }
reasoningEfforts: { 'off': null, minimal: minimal, low: low, medium: medium, high: high, xhigh: xhigh, max: max }
```

插件不猜：先探测，再按实测值改写这份 map（沿用你原来的线上拼写）。

## 安装

```powershell
# 本地开发（pnpm link，改完重启 profile 生效）
dsh plugin --profile web add C:\Users\蒋老师\projects\opencode-effort-discovery\packages\dsh

# 或从 npm
dsh plugin --profile web add @tscgoods/dsh-effort-discovery
```

安装后 `dsh plugin` 会把 bundle 追加到 profile 的 `dsh.profile.bundles`，并应用 `cordis.patch.yml`（插入一行 `effort-discovery`）。

验证组合结果：

```powershell
dsh --profile web --dump-config | Select-String effort-discovery
```

## 先探测

```powershell
node packages\dsh\scripts\probe.mjs --provider ts-dpsk
```

结果写到 `~/.cache/effort-discovery/dsh.json`。插件在启动/配置更新时读这份缓存，按模型 id 匹配。

## 行为

| 情况 | 结果 |
| --- | --- |
| 探测到合法档位 | `reasoningEfforts` 只保留实测档位（`none` → `off: null`），沿用原有 wire 值 |
| 探测到只有 `none` | `reasoningEfforts: false`（当作非推理模型，菜单不再出现 Effort） |
| 没探测结果 / `unknown` | 不动原配置 |
| `mode: "off"` | 完全不改配置，只保留 `reasoning_effort_probe` 工具 |

配置项（`cordis.patch.yml` 里那一行的 `config`）：

```yaml
mode: transform   # transform | off
ttlMs: 21600000
```

## 工具

启用后 agent 可以调用 `reasoning_effort_probe`（`action: status`）查看缓存里的模型档位。

## 风险与验证

- 插件用 Cordis 的 `internal/config` waterfall 改写 `@deepseek-ai/dsh-llm-pi-ai` 这一行的 `providers`。这是 rc 版本里的内部事件，升级 dsh 后如果行为变了，请先 `--dump-config` 对照。
- 插件注册在 `llm-pi-ai` 之后（insert 追加到末尾），所以它的变换结果会参与该行的配置校验；如果未来有 bundle 插到它前面，顺序假设需要重新确认。
- 收窄档位对已保存的会话有影响：如果会话固定了一个被移除的档位，下一步会报 `UNSUPPORTED_REASONING_EFFORT`，重新选一次档位即可。
- 不想让插件改配置时，把 `mode` 设为 `off`，只用探测脚本 + 手工改 `cordis.patch.yml`。