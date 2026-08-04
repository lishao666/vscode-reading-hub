# VS Code WeRead

在 VS Code 最底部状态栏阅读微信读书正文。

## 实现方式

- 微信读书官方 Skill API：书架、目录、阅读进度。
- 微信读书网页版登录态：按章节请求正文；会员、购买和试读权限由微信读书服务端判断。
- VS Code 状态栏分页显示正文，支持前后翻页和切换章节。
- VS Code `SecretStorage`：保存 API Key 和 Cookie。
- 正文只保存在当前扩展进程的内存中，不写入磁盘。
- 检测到 EPUB 字体混淆产生的替换字符时，会在后台调用系统 Chrome 让微信读书官方页面完成字符还原。

正文使用的是微信读书网页内部接口，并非官方公开的第三方正文 API，可能随网页更新而失效。请仅用于个人阅读并遵守微信读书服务条款。

## 开发运行

```bash
npm install
npm run compile
```

用 VS Code 打开本目录，按 `F5` 启动 Extension Development Host，然后运行命令：

1. `微信读书：配置 API Key`
2. `微信读书：自动登录`
3. `微信读书：开始阅读`

macOS 默认快捷键：`Cmd+,` 上一页，`Cmd+.` 下一页，`Cmd+Option+↑/↓` 上一章/下一章，`Control+Cmd+M` 显示或隐藏底栏正文。隐藏正文后，翻页快捷键会立即释放；可关闭 `vscodeWeread.enableDefaultKeybindings` 后自行绑定。

操作按钮默认隐藏，正文默认不可点击。可在设置中开启 `vscodeWeread.showControlButtons` 和 `vscodeWeread.clickContentToNext`。按钮开启后的顺序为 `«  ‹  正文  ›  »`。

插件会分别记录每本书最后阅读的章节和页码。使用 `微信读书：书架` 可重新选择书籍，使用 `微信读书：选择章节` 可跳转章节，使用 `微信读书：刷新` 可重新获取当前章节并保持当前页。

## 数据与隐私

- API Key 和网页登录态只保存到 VS Code `SecretStorage`，不会写入项目文件。
- 正文只保存在扩展进程内存和当前章节缓存中；执行“微信读书：清除登录信息和缓存”会同时清除保存的阅读位置。
- 插件会向微信读书官方 Skill API 和微信读书网页版请求数据。除这些请求外，不会上传工作区文件或编辑器内容。
- 本扩展不是腾讯或微信读书官方产品。正文接口为网页内部接口，可能因服务端变更而失效。

## 自动登录

执行 `微信读书: 自动登录` 后，插件会打开一个独立的系统 Chrome 窗口。扫码登录，打开任意书籍并翻一页；检测到 `/web/book/read` 请求后，插件会自动保存 Cookie 和 `x-wrpa-*` 授权头并关闭该独立浏览器。

自动登录不会读取日常 Chrome 配置，凭据只保存在 VS Code `SecretStorage`。

## 手动获取网页登录态（备用）

1. 在浏览器打开 <https://weread.qq.com/> 并登录。
2. 打开浏览器开发者工具的 Network 面板。
3. 在网页中打开一本书并翻页。
4. 找到 `/web/book/read` 请求。
5. 复制该请求的 cURL，回到 VS Code 执行 `微信读书: 配置网页登录态` 后粘贴。插件会保存 Cookie 以及该请求中的 `x-wrpa-*` 网页授权头。

Cookie 相当于登录凭据，请勿分享或提交到 Git。

## 致谢

网页阅读协议和正文分片兼容思路参考了 MIT 许可的 `Pay4att/vscode-wechat-book` Marketplace 发布包。本项目重新设计了凭据存储和阅读界面。
