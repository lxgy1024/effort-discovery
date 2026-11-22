---
name: effort-probe
description: 探测网关对模型真正接受的 reasoning effort 档位，并把它写进 Codex 的 model catalog（Codex 的档位菜单来自 catalog，不是插件）
---

# Effort discovery for Codex

Codex 的档位列表来自 **model catalog**（`model_catalog_json`），插件不能直接改枚举。这个技能负责探测并生成 catalog。

## 步骤

1. 探测（先试网关原生 catalog，失败再发极小请求）：

```bash
node "${PLUGIN_ROOT}/scripts/probe.mjs" --json
```

2. 把结果同步进 catalog 副本（默认 dry-run）：

```bash
node "${PLUGIN_ROOT}/scripts/sync-catalog.mjs"
```

3. 用户确认后再写：

```bash
node "${PLUGIN_ROOT}/scripts/sync-catalog.mjs" --write
```

4. 提醒用户在 `~/.codex/config.toml` 设置：

```toml
model_catalog_json = 'C:\Users\<you>\.codex\model-catalogs\efforts.json'
```

（或者给 `model_providers.<id>.model_catalog_url` 指向与 `base_url` 同源同端口的 `/models`，让网关自己算档位。）

## 规则

- `(unknown)` 的模型不要写 catalog，保留原值。
- 不要删 `off`/`minimal` 之类没探测到的档位之外的内容；只替换 `supported_reasoning_levels` 和必要的 `default_reasoning_level`。
- catalog 是整体替换文件：务必从当前生效的 catalog 复制后再改（脚本已经这么做）。
- 改动 `config.toml` 属于用户配置，必须先征得同意。