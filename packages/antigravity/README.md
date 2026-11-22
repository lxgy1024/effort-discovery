# @tscgoods/antigravity-effort-discovery

Antigravity CLI（`agy`）插件：探测网关真正接受的 reasoning effort 档位，把结果注入会话，并提供与 agy 自身枚举的交叉验证。

## 为什么需要

agy 有两种“档位真相”：

1. **agy 自己的模型元数据**：`--effort` 只允许 `low|medium|high|xhigh|max`，且每个模型可用的子集不同（`agy -p "/effort" --output-format json --model <m>` 会返回 `available`）。
2. **你的网关**：自建/中转网关不一定都接受，甚至接受但不生效。

插件把两者对比，告诉你“哪些档位既在 agy 菜单里、网关也真的接受”。

> agy 的档位菜单无法由插件增删——`customModels` 是唯一能改变菜单的机制，且只在 `modelProvider: "gemini"` + `GEMINI_API_KEY` 时生效。本插件不自动改你自己的配置。

## 安装

```powershell
# 本地开发：直接放进 agy 的插件目录（无需 install/register）
Copy-Item -Recurse packages\antigravity "$env:USERPROFILE\.gemini\config\plugins\effort-discovery"

# 或者构建后安装
agy plugin validate ./packages/antigravity --strict
agy plugin install ./packages/antigravity
agy plugin list --json
```

开发期也可以把目录软链到 `~/.gemini/config/plugins/`，agy 会自动发现（新插件下一轮对话即生效）。

## 组成

| 文件 | 作用 |
| --- | --- |
| `hooks.json` | `SessionStart` 注入缓存结果；`PreInvocation` 提醒不支持的档位 |
| `skills/effort-probe/SKILL.md` | `/effort-probe` 技能：跑探测并汇报 |
| `scripts/probe.mjs` | 探测网关（OpenAI 兼容），可选 `--agy` 交叉验证 |
| `scripts/emit-custom-models.mjs` | 把探测结果生成 agy 的 `customModels` 配置片段（`--write` 才写 settings.json） |
| `scripts/session-note.mjs` | 只读缓存，`injectSteps.systemMessage` |
| `scripts/effort-guard.mjs` | 提示用户提到的档位不被网关支持（只提醒，不终止） |
| `rules/AGENTS.md` | 给 agent 的固定规则 |

## 探测

```powershell
node packages\antigravity\scripts\probe.mjs --agy --json
```

provider 来自共享配置 `~/.config/effort-discovery.json`（默认第一个 `api: "openai"` 的 provider，可用 `--provider` 指定），结果缓存到 `~/.cache/effort-discovery/antigravity.json`。

## 在非 Gemini 网关上使用模型：`emit-custom-models`（实验结果：未生效，⚠️）

> **实测结论（agy 1.5.14）**：以下写法在账号登录和 Gemini API key 两种模式下都试过，还额外试了 `--settings` 内联、4 种 URL scheme（`gemini-api://` / `blade:` / `evergreen:` / `beyond-api://`）和多种键名（`customModelsConfig` / `custom_models_config` / `customModels`）——`customModelsConfig` 里的条目**始终没有出现在 `agy models` / `/model` 里**。二进制里确实有 `customModelsConfig` proto 字段，但这个版本没有从我们尝试的任何配置入口读取它。因此**不要依赖下面的生成器**，它目前只能作为"生成的片段长什么样"的参考。

实测中写入的 10 条 `customModels` 已经从 `~/.gemini/antigravity-cli/settings.json` 清理干净（保留了写前的 `.bak`），用户当前模型选择未变。

**插件真正能做且已验证的部分**：

| 能力 | 状态 |
|---|---|
| `SessionStart` 注入内置模型的权威档位（如 Gemini 3.8 Flash → low/medium/high） | ✅ |
| `/effort-probe` 技能：并排展示网关实测与 agy 自报档位 | ✅ |
| `PreInvocation` 提醒不要使用不支持的档位 | ✅ |
| 把网关模型加进 agy 的 `/model` 菜单 | ❌ agy 1.5.14 限制 |

换句话说：agy 自带的模型（Gemini / Claude / GPT-OSS）的档位信息插件能正确报告；但 agy 的 `--effort` 枚举和模型列表都是内置目录驱动的，插件改不了，网关模型也塞不进去。

agy 内置目录主要是 Gemini 系列。理论上要用你的 OpenAI 兼容网关模型，需要 `customModelsConfig`（仅当 `modelProvider: "gemini"` + API key 时生效）：

```powershell
node "$p\scripts\emit-custom-models.mjs"            # 只输出 JSON 片段（dry-run）
node "$p\scripts\emit-custom-models.mjs" --write    # 备份并合并进 ~/.gemini/antigravity-cli/settings.json
```

生成器按 `probe.mjs --agy` 的结果，为每个模型 × 每个可用档位生成一条条目：

```json
"ds-flash-high": {
  "modelName": "gemini-api://https://gw.example/v1/models/deepseek-v4.1-flash",
  "label": "deepseek-v4.1-flash (High)",
  "thinkingLevel": "high"
}
```

**硬限制**：`thinkingLevel` 只接受 `low|medium|high`；`max`/`xhigh` 会被跳过并警告。一个条目固定一个档位，多档位会生成多条不同 label 的条目（agy 是否接受相同 `modelName` 的多条目未在官方文档中确认，建议先 `--write` 后观察 `/model`）。

写入前会备份 `settings.json.bak-<时间戳>`；生成器不会自动改 `modelProvider`。

## 注意

- 插件改成 `hooks.json` + `skills/`；agy **不加载** `commands/`、没有 statusline 组件。
- hook 命令在插件根目录执行，可用 `PLUGIN_ROOT` / `PLUGIN_DATA` 环境变量；Windows 下用 `cmd /c` 语义，`node ./scripts/...` 是安全写法。
- hook 失败是 fail-open（非 0 退出只记日志），不会阻塞会话。