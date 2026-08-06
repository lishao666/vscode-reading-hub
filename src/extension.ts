import * as vscode from "vscode";
import { captureFanqieSession, captureWeReadSession } from "./autoLogin";
import { FanqieClient } from "./fanqieClient";
import { SharedFanqieClient } from "./fanqieCoordinator";
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
  const performanceOutput = vscode.window.createOutputChannel("阅读中心性能");
  const wereadClient = new WeReadClient(context.secrets, performanceOutput);
  const performanceLog = (line: string): void => {
    if (vscode.workspace.getConfiguration("vscodeReading").get<boolean>("performanceLogging", false)) performanceOutput.appendLine(line);
  };
  const fanqieClient = new SharedFanqieClient(
    new FanqieClient(context.secrets, context.extensionPath, context.globalStorageUri.fsPath, performanceLog),
    context.globalStorageUri.fsPath
  );
  type ProviderId = "weread" | "fanqie";
  const providerKey = "vscodeReading.currentProvider";
  let providerId = context.globalState.get<ProviderId>(providerKey, "weread");
  const currentClient = () => providerId === "fanqie" ? fanqieClient : wereadClient;
  const providerName = () => providerId === "fanqie" ? "番茄小说" : "微信读书";
  const statusReader = new StatusBarReader(currentClient(), providerId, context.globalState);

  const configureApiKey = vscode.commands.registerCommand("vscodeReading.configureApiKey", async () => {
    const value = await vscode.window.showInputBox({ prompt: "输入微信读书 Skill API Key", placeHolder: "wrk-xxxxxxxx", password: true, ignoreFocusOut: true });
    if (value === undefined) return;
    if (!value.trim().startsWith("wrk-")) throw new Error("API Key 必须以 wrk- 开头");
    await wereadClient.setApiKey(value.trim());
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
    await wereadClient.setSession(session);
    vscode.window.showInformationMessage("微信读书网页登录态已安全保存。");
  });

  const loginProvider = async (target: ProviderId): Promise<boolean> => {
    if (target === "fanqie") {
      const confirmed = await vscode.window.showInformationMessage(
        "将打开独立 Chrome 登录番茄小说。登录后请随意打开一本小说的正文页面，插件检测到章节正文访问后才会完成配置。登录态只保存到 VS Code SecretStorage。",
        { modal: true }, "开始登录"
      );
      if (confirmed !== "开始登录") return false;
      try {
        const session = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "等待番茄小说登录…", cancellable: false }, () => captureFanqieSession());
        if (!session) return false;
        await fanqieClient.setSession(session);
        vscode.window.showInformationMessage(`番茄小说登录及正文访问验证成功${session.isVip ? "，已识别到 SVIP 网页身份" : "；暂未识别到 SVIP 网页身份"}。`);
        return true;
      } catch (error) {
        vscode.window.showErrorMessage(`番茄小说登录失败：${safeErrorMessage(error)}`);
        return false;
      }
    }
    const confirmed = await vscode.window.showInformationMessage(
      "自动登录将打开一个独立的 Chrome 窗口。扫码后请打开任意书籍并翻一页；插件会读取该独立窗口中的微信读书 Cookie 和网页授权头，并仅保存到本机 VS Code SecretStorage。",
      { modal: true }, "开始登录"
    );
    if (confirmed !== "开始登录") return false;
    try {
      const session = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "等待微信读书扫码登录和阅读请求…",
        cancellable: false
      }, () => captureWeReadSession());
      if (!session) return false;
      await wereadClient.setSession(session);
      vscode.window.showInformationMessage("微信读书自动登录成功，网页登录态已安全保存。");
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`微信读书自动登录失败：${safeErrorMessage(error)}`);
      return false;
    }
  };

  const login = vscode.commands.registerCommand("vscodeReading.login", async () => {
    const selected = await vscode.window.showQuickPick([
      { label: "微信读书", description: await wereadClient.getSession() ? "已保存登录态" : "未登录", id: "weread" as ProviderId },
      { label: "番茄小说", description: await fanqieClient.getSession() ? "已保存登录态" : "未登录", id: "fanqie" as ProviderId }
    ], { placeHolder: "选择要登录的阅读服务" });
    if (!selected) return;
    await loginProvider(selected.id);
  });

  const ensureConfigured = async (): Promise<boolean> => {
    if (providerId === "fanqie") {
      if (!await fanqieClient.getSession()) {
        const configure = await vscode.window.showWarningMessage("请先登录番茄小说。", "立即登录");
        if (configure === "立即登录") await loginProvider("fanqie");
      }
      return Boolean(await fanqieClient.getSession());
    }
    if (!await wereadClient.getApiKey()) {
      const configure = await vscode.window.showWarningMessage("请先配置微信读书 API Key。", "立即配置");
      if (configure === "立即配置") await vscode.commands.executeCommand("vscodeReading.configureApiKey");
      if (!await wereadClient.getApiKey()) return false;
    }
    if (!await wereadClient.getSession()) {
      const configure = await vscode.window.showWarningMessage("请先登录微信读书。", "自动登录", "手动粘贴 cURL");
      if (configure === "自动登录") await loginProvider("weread");
      if (configure === "手动粘贴 cURL") await vscode.commands.executeCommand("vscodeReading.configureSession");
      if (!await wereadClient.getSession()) return false;
    }
    return true;
  };

  const runReaderAction = async (action: () => Promise<void>): Promise<void> => {
    try {
      if (!await ensureConfigured()) return;
      await action();
    } catch (error) {
      vscode.window.showErrorMessage(`${providerName()}操作失败：${safeErrorMessage(error)}`);
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
  const switchProvider = vscode.commands.registerCommand("vscodeReading.switchProvider", async () => {
    const selected = await vscode.window.showQuickPick([
      { label: "微信读书", description: providerId === "weread" ? "当前书源" : "", id: "weread" as ProviderId },
      { label: "番茄小说", description: providerId === "fanqie" ? "当前书源" : "实验性支持", id: "fanqie" as ProviderId }
    ], { placeHolder: "选择阅读书源" });
    if (!selected) return;
    const switched = selected.id !== providerId;
    if (switched) {
      providerId = selected.id;
      await context.globalState.update(providerKey, providerId);
      await statusReader.setClient(currentClient(), providerId);
      vscode.window.showInformationMessage(`已切换到${providerName()}。`);
    }
    let ready = providerId === "fanqie" ? Boolean(await fanqieClient.getSession()) : Boolean(await wereadClient.getSession());
    if (!ready) {
      const action = await vscode.window.showWarningMessage(`${providerName()}尚未登录，是否立即登录？`, "立即登录");
      if (action === "立即登录") ready = await loginProvider(providerId);
    }
    if (switched && ready) await runReaderAction(() => statusReader.start());
  });
  const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("vscodeReading.showControlButtons") || event.affectsConfiguration("vscodeReading.clickContentToNext")) {
      statusReader.refreshConfiguration();
    }
  });

  const toggleControlButtons = vscode.commands.registerCommand("vscodeReading.toggleControlButtons", async () => {
    const configuration = vscode.workspace.getConfiguration("vscodeReading");
    const enabled = !configuration.get<boolean>("showControlButtons", false);
    await configuration.update("showControlButtons", enabled, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`阅读操作按钮已${enabled ? "显示" : "隐藏"}。`);
  });

  const toggleClickContentToNext = vscode.commands.registerCommand("vscodeReading.toggleClickContentToNext", async () => {
    const configuration = vscode.workspace.getConfiguration("vscodeReading");
    const enabled = !configuration.get<boolean>("clickContentToNext", false);
    await configuration.update("clickContentToNext", enabled, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`点击正文翻页已${enabled ? "允许" : "禁止"}。`);
  });

  const clearData = vscode.commands.registerCommand("vscodeReading.clearData", async () => {
    const confirmed = await vscode.window.showWarningMessage("确定清除已保存的 API Key、Cookie、阅读位置和内存正文缓存吗？", { modal: true }, "清除");
    if (confirmed !== "清除") return;
    await Promise.all([wereadClient.clear(), fanqieClient.clear()]);
    await statusReader.clearHistory();
    vscode.window.showInformationMessage("登录信息、阅读位置和本地正文缓存已清除。");
  });

  context.subscriptions.push(performanceOutput, configureApiKey, configureSession, login, openReader, selectBook, selectChapter, refresh, previous, next, previousChapter, nextChapter, hide, switchProvider, toggleControlButtons, toggleClickContentToNext, clearData, configurationListener, statusReader, { dispose: () => { void fanqieClient.dispose(); void wereadClient.dispose(); } });
}

export function deactivate(): void {}
