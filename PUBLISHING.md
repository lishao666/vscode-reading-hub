# 双市场发布说明

本项目通过同一个 VSIX 同步发布到：

- Visual Studio Marketplace：供 VS Code 等编辑器安装。
- Open VSX Registry：供 Cursor 及使用 Open VSX 的兼容编辑器安装。

## 首次配置

在 GitHub 仓库的 `Settings` → `Secrets and variables` → `Actions` 中创建：

- `VSCE_PAT`：Visual Studio Marketplace Personal Access Token，需要 Marketplace `Manage` 权限。
- `OVSX_PAT`：Open VSX Access Token，需要先签署 Eclipse Foundation Open VSX Publisher Agreement，并拥有 `LiShao` namespace。

令牌只能保存为 GitHub Actions Secret，不要写入代码、README、Issue 或日志。

## 发布新版本

1. 修改 `package.json` 和 `package-lock.json` 中的版本号。
2. 更新 `CHANGELOG.md`。
3. 运行 `npm test`、`npx tsc --noEmit` 和 `npx vsce package`。
4. 提交并推送到 `main`。
5. 打开 GitHub 仓库的 `Actions` → `Publish Extension`。
6. 点击 `Run workflow`。

工作流只构建一次 VSIX，然后将同一文件分别发布到两个市场，确保代码和版本一致。两个市场的审核和搜索索引时间可能不同，因此用户可见时间不一定完全同步。

如果其中一个市场发布失败，不要提升版本号；修复令牌或平台问题后重新发布同一个 VSIX 到失败的市场即可。
