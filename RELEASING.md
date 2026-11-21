# 发布流程

本仓库把 **npm 版本** 和 **GitHub Release** 绑在同一个 tag 上：推 `vX.Y.Z` 之后，CI 会

1. 校验 `package.json` 版本与 tag 一致；
2. `npm publish --provenance`；
3. 用同一个 tag 创建 GitHub Release（自动生成 release notes）。

## 首次配置（二选一）

### A. npm Trusted Publishing（推荐，无需保存 token）

1. 打开 <https://www.npmjs.com/package/opencode-effort-discovery/access>；
2. 找到 **Trusted publishing** → **Add publisher** → GitHub Actions；
3. 填写：
   - Organization or user: `lxgy1024`
   - Repository: `opencode-effort-discovery`
   - Workflow filename: `release.yml`
   - Environment: 留空
4. 保存。之后 CI 用 OIDC 直接发布，不需要任何 secret。

### B. NPM_TOKEN

1. 在 <https://www.npmjs.com/settings/lxgy1024/tokens> 生成 granular token（权限：Read and write，勾选 *Bypass 2FA*）；
2. `gh secret set NPM_TOKEN --repo lxgy1024/opencode-effort-discovery`。

## 发版

```bash
# 1. 改版本号（0.2.0 -> 0.2.1）
npm version patch --no-git-tag-version
git commit -am "chore: release 0.2.1"

# 2. 打 tag 并推送，触发 CI
git tag v0.2.1
git push origin main --tags
```

CI 跑完后，npm 和 GitHub Releases 里会出现同一个 `0.2.1`。

## 手动触发

Actions → release → Run workflow，填入 tag 即可重跑某个版本的发布。

> Trusted publishing 要求 npm CLI >= 11.5.1，workflow 里已经 `npm install -g npm@latest`。