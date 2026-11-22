# Effort Discovery — Antigravity CLI

- agy 的 `--effort` 是固定枚举 `low|medium|high|xhigh|max`；某个模型能用哪些档位由 agy 的模型元数据决定，插件无法增删。
- 需要确认某个模型在**你的网关**上到底接受哪些档位时，运行 `node ./scripts/probe.mjs --agy --json`。
- 汇报用户时同时给出 `gateway levels`（网关实测）和 `agy levels`（agy 自报），只把交集当作安全选项。
- 不要修改 `~/.gemini/antigravity-cli/settings.json`，除非用户明确要求生成 `customModels`。