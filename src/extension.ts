import * as vscode from "vscode";
import { captureWeReadSession } from "./autoLogin";
import { parseSession } from "./session";
import { StatusBarReader } from "./statusBarReader";
import { WeReadClient } from "./wereadClient";

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/cookie\s*[:=][^\n]*/gi, "Cookie=[已隐藏]")
    .replace(/(authorization|token|secret|x-wrpa-\d+)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
    .replace(/(wr_skey|wr_vid|skey|uin)=[^;\s]+/gi, "$1=[已隐藏]")
    .slice(0, 500);
}

export function activate(context: vscode.ExtensionContext): void {
  const client = new WeReadClient(context.secrets);
  const statusReader = new StatusBarReader(client, context.globalState);

  const configureApiKey = vscode.commands.registerCommand("vscodeReading.configureApiKey", async () => {
    const value = await vscode.window.showInputBox({ prompt: "输入微信读书 Skill API Key", placeHolder: "wrk-xxxxxxxx", password: true, ignoreFocusOut: true });
    if (value === undefined) return;
    if (!value.trim().startsWith("wrk-")) throw new Error("API Key 必须以 wrk- 开头");
    await client.setApiKey(value.trim());
    vscode.window.showInformationMessage("微信读书 API Key 已安全保存。");
  });

  const configureSession = vscode.commands.registerCommand("vscodeReading.configureSession", async () => {
    const action = await vscode.window.showInformationMessage(
      "请先在浏览器登录微信读书网页版，再从开发者工具复制 /web/book/read 请求的 Cookie 或 cURL。登录态将保存在 VS Code SecretStorage。",
      "打开微信读书网页", "粘贴登录态"
    );
    if (action === "打开微信读书网页") {
      await vscode.env.openExternal(vscode.Uri.parse("https://weread.qq.com/"));
      return;
    }
    if (action !== "粘贴登录态") return;
    const input = await vscode.window.showInputBox({ prompt: "粘贴 Cookie 或 /web/book/read cURL", password: true, ignoreFocusOut: true });
    if (input === undefined) return;
    const session = parseSession(input);
    if (!session) throw new Error("没有识别到有效 Cookie，请复制完整的 Cookie 或 cURL");
    await client.setSession(session);
    vscode.window.showInformationMessage("微信读书网页登录态已安全保存。");
  });

  const login = vscode.commands.registerCommand("vscodeReading.login", async () => {
    const confirmed = await vscode.window.showInformationMessage(
      "自动登录将打开一个独立的 Chrome 窗口。扫码后请打开任意书籍并翻一页；插件会读取该独立窗口中的微信读书 Cookie 和网页授权头，并仅保存到本机 VS Code SecretStorage。",
      { modal: true }, "开始登录"
    );
    if (confirmed !== "开始登录") return;
    try {
      const session = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "等待微信读书扫码登录和阅读请求…",
        cancellable: false
      }, () => captureWeReadSession());
      if (!session) return;
      await client.setSession(session);
      vscode.window.showInformationMessage("微信读书自动登录成功，网页登录态已安全保存。");
    } catch (error) {
      vscode.window.showErrorMessage(`微信读书自动登录失败：${safeErrorMessage(error)}`);
    }
  });

  const ensureConfigured = async (): Promise<boolean> => {
    if (!await client.getApiKey()) {
      const configure = await vscode.window.showWarningMessage("请先配置微信读书 API Key。", "立即配置");
      if (configure === "立即配置") await vscode.commands.executeCommand("vscodeReading.configureApiKey");
      if (!await client.getApiKey()) return false;
    }
    if (!await client.getSession()) {
      const configure = await vscode.window.showWarningMessage("请先登录微信读书。", "自动登录", "手动粘贴 cURL");
      if (configure === "自动登录") await vscode.commands.executeCommand("vscodeReading.login");
      if (configure === "手动粘贴 cURL") await vscode.commands.executeCommand("vscodeReading.configureSession");
      if (!await client.getSession()) return false;
    }
    return true;
  };

  const runReaderAction = async (action: () => Promise<void>): Promise<void> => {
    try {
      if (!await ensureConfigured()) return;
      await action();
    } catch (error) {
      vscode.window.showErrorMessage(`微信读书操作失败：${safeErrorMessage(error)}`);
    }
  };

  const openReader = vscode.commands.registerCommand("vscodeReading.openReader", () => runReaderAction(() => statusReader.start()));
  const selectBook = vscode.commands.registerCommand("vscodeReading.selectBook", () => runReaderAction(() => statusReader.selectBook()));
  const selectChapter = vscode.commands.registerCommand("vscodeReading.selectChapter", () => runReaderAction(() => statusReader.selectChapter()));
  const refresh = vscode.commands.registerCommand("vscodeReading.refresh", () => runReaderAction(() => statusReader.refresh()));
  const previous = vscode.commands.registerCommand("vscodeReading.previous", () => runReaderAction(() => statusReader.previous()));
  const next = vscode.commands.registerCommand("vscodeReading.next", () => runReaderAction(() => statusReader.next()));
  const previousChapter = vscode.commands.registerCommand("vscodeReading.previousChapter", () => runReaderAction(() => statusReader.previousChapter()));
  const nextChapter = vscode.commands.registerCommand("vscodeReading.nextChapter", () => runReaderAction(() => statusReader.nextChapter()));
  const hide = vscode.commands.registerCommand("vscodeReading.hide", () => statusReader.toggleVisibility());
  const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("vscodeReading.showControlButtons") || event.affectsConfiguration("vscodeReading.clickContentToNext")) {
      statusReader.refreshConfiguration();
    }
  });

  const clearData = vscode.commands.registerCommand("vscodeReading.clearData", async () => {
    const confirmed = await vscode.window.showWarningMessage("确定清除已保存的 API Key、Cookie、阅读位置和内存正文缓存吗？", { modal: true }, "清除");
    if (confirmed !== "清除") return;
    await client.clear();
    await statusReader.clearHistory();
    vscode.window.showInformationMessage("登录信息、阅读位置和本地正文缓存已清除。");
  });

  context.subscriptions.push(configureApiKey, configureSession, login, openReader, selectBook, selectChapter, refresh, previous, next, previousChapter, nextChapter, hide, clearData, configurationListener, statusReader);
}

export function deactivate(): void {}
