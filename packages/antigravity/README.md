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
| `scripts/session-note.mjs` | 只读缓存，`injectSteps.systemMessage` |
| `scripts/effort-guard.mjs` | 提示用户提到的档位不被网关支持（只提醒，不终止） |
| `rules/AGENTS.md` | 给 agent 的固定规则 |

## 探测

```powershell
node packages\antigravity\scripts\probe.mjs --agy --json
```

provider 来自共享配置 `~/.config/effort-discovery.json`（默认第一个 `api: "openai"` 的 provider，可用 `--provider` 指定），结果缓存到 `~/.cache/effort-discovery/antigravity.json`。

## 注意

- 插件改成 `hooks.json` + `skills/`；agy **不加载** `commands/`、没有 statusline 组件。
- hook 命令在插件根目录执行，可用 `PLUGIN_ROOT` / `PLUGIN_DATA` 环境变量；Windows 下用 `cmd /c` 语义，`node ./scripts/...` 是安全写法。
- hook 失败是 fail-open（非 0 退出只记日志），不会阻塞会话。