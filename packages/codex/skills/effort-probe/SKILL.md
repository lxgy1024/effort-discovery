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

2. 就地修补 catalog（默认 dry-run）。guard 会修「config 当前指向的文件」+ efforts.json，
   不论指针指向哪，文件内容都是对的——能抵抗 cc-switch 重新生成 catalog 造成的覆盖：

```bash
node "${PLUGIN_ROOT}/scripts/guard.mjs"
```

3. 用户确认后再写：

```bash
node "${PLUGIN_ROOT}/scripts/guard.mjs" --write
```

4. 如果用户希望长期自动防覆盖，可建议前台常驻：

```bash
node "${PLUGIN_ROOT}/scripts/guard.mjs" --watch
```

（纯前台进程，不注册计划任务/服务。）

5. 如果 config.toml 的 model_catalog_json 尚未设置过，提醒用户设置：

```toml
model_catalog_json = 'C:\Users\<you>\.codex\model-catalogs\efforts.json'
```

（或者给 `model_providers.<id>.model_catalog_url` 指向与 `base_url` 同源同端口的 `/models`，让网关自己算档位。）

## 规则

- `(unknown)` 的模型不要写 catalog，保留原值。
- 不要删 `off`/`minimal` 之类没探测到的档位之外的内容；只替换 `supported_reasoning_levels` 和必要的 `default_reasoning_level`。
- catalog 是整体替换文件：务必从当前生效的 catalog 复制后再改（脚本已经这么做）。
- 改动 `config.toml` 属于用户配置，必须先征得同意。