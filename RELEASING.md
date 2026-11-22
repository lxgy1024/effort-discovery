# 发布流程

仓库把 **npm 版本**、**GitHub Release** 和 **tag** 绑在一起：推 `vX.Y.Z` 后 CI 会

1. 校验每个 `packages/*/package.json` 的版本（等于 tag 的才发布）；
2. 对尚未发布的包执行 `npm publish --provenance --access public`；
3. 等待 registry 可见（重试，超时只告警）；
4. 用同一个 tag 创建 GitHub Release。

## 一次性配置：npm Trusted Publishing（每个包一次）

npm 的 trusted publisher 是**按包**配置的，以下每个包都要在 npmjs.com 上做一次：

1. 打开 `https://www.npmjs.com/package/<包名>/access`
2. **Trusted publishing** → **Add publisher** → **GitHub Actions**
3. 填：

| 字段 | 值 |
| --- | --- |
| Organization or user | `lxgy1024` |
| Repository | `effort-discovery` |
| Workflow filename | `release.yml` |
| Environment | 留空 |

需要配置的包：

- `@tscgoods/effort-discovery-core`
- `@tscgoods/opencode-effort-discovery`
- `@tscgoods/claude-code-effort-discovery`
- `@tscgoods/codex-effort-discovery`
- `@tscgoods/dsh-effort-discovery`
- `@tscgoods/antigravity-effort-discovery`

> 首次发布前这些包在 npm 上还不存在，需要先手动发布一次（`npm publish`）才能进入包设置页配置 trusted publisher；之后全部由 CI 接管。也可以改用仓库 secret `NPM_TOKEN`（granular token，勾选 Bypass 2FA）。

## 发版

```powershell
# 1. 同步所有包的版本（lockstep）
npm version patch --no-git-tag-version -w packages/core -w packages/opencode -w packages/claude-code -w packages/codex -w packages/dsh -w packages/antigravity

# 2. 提交并推 tag
git commit -am "chore: release 0.3.1"
git push origin main
git tag v0.3.1
git push origin v0.3.1
```

CI 跑完后 npm 和 GitHub Releases 里会出现同一个版本。

## 手动重跑

Actions → release → Run workflow，填 tag 即可重跑（已存在的包会跳过，Release 已存在也跳过）。

## 旧包

`opencode-effort-discovery`（无 scope）是早期版本，已 `npm deprecate`，请改用 `@tscgoods/opencode-effort-discovery`。