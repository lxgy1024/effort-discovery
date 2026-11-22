# @tscgoods/codex-effort-discovery

Codex CLI 插件：探测网关真正接受的 reasoning effort 档位，然后生成/更新一份 **model catalog**，让 Codex 的档位菜单只出现这些档位。

## 为什么需要

Codex 的档位列表来自 `model_catalog_json`（**配置**，不是插件接口）：每个模型的 `supported_reasoning_levels` 决定 UI 里出现哪些档位。插件不能改枚举，但可以：

1. 探测网关（默认：上游错误回显优先，原生 catalog 兜底）；
2. 把结果写进现有 catalog 的副本，并告诉你把 `model_catalog_json` 指过去。

## 安装

```powershell
codex plugin marketplace add <本仓库或本包目录的上级目录>
codex plugin add effort-discovery@<marketplace>
```

也可以把包目录放进任意本地 marketplace（`.agents/plugins/marketplace.json`）再安装。

## 用法

```powershell
# 1. 探测（provider 来自 ~/.config/effort-discovery.json，默认第一个 openai provider）
node scripts/probe.mjs

# 2. 预览 catalog 改动（默认 dry-run）
node scripts/sync-catalog.mjs

# 3. 确认后写入 ~/.codex/model-catalogs/efforts.json
node scripts/sync-catalog.mjs --write

# 4. 在 ~/.codex/config.toml 里指向它
#    model_catalog_json = 'C:\Users\<you>\.codex\model-catalogs\efforts.json'
```

插件还提供 `/efforts` 命令和 `effort-probe` 技能，让 agent 代跑这两步。

## 哪个证据可信

DeepSeek 官方文档（https://api-docs.deepseek.com/zh-cn/guides/thinking_mode）明确写着 `reasoning_effort` 只接受 `low / high / max`，`medium` 和 `xhigh` 都会被映射成 `high`；Anthropic 格式是 `none/low/high/max`。

但网关的原生 catalog（cc-switch 生成的 `/v1/models`）给 deepseek 标的是 `low/medium/high/xhigh`——**这个 catalog 是错的，而且漏了 max**，导致 Codex 菜单里选不到 max。

因此 `probe.mjs` 的默认优先级是：

1. **上游错误回显**（`/v1/chat/completions` 的非法值 400，反映实际接受的档位）→ `source: validated`；
2. **原生 catalog** 兜底（错误回显拿不到时）→ `source: native-catalog`。

`none` 会被过滤掉（Codex 的 `supported_reasoning_levels` 不接受它），最终 deepseek 得到 `low/high/max`。`--no-native` 保留作"只看错误回显"的诊断开关。若网关原生 catalog 与错误回显一致，两者结果相同，无副作用。

## 更省事的替代

如果网关的 catalog 本身准确，可以不装插件：

```toml
[model_providers.custom]
base_url = "http://127.0.0.1:7891/v1"
model_catalog_url = "http://127.0.0.1:7891/v1/models"   # 必须与 base_url 同源同端口
```

但本例中 cc-switch 的 catalog 是错的，所以要用插件生成并写入正确的 catalog。

## 注意

- Codex 只在启动时读 catalog，改完需要重开会话。
- 只有 `ultra` 会被 Codex 重映射；其余值（包括非法值）会原样发给上游，上游 400 会直接变成 `turn.failed`。所以 catalog 写得准很关键。
- `(unknown)` 的模型不会被写进 catalog，保留原值。