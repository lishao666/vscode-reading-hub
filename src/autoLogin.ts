import * as vscode from "vscode";
import type { Browser, BrowserContext, Page, Request } from "playwright-core";
import { chromium } from "playwright-core";
import type { WebSession } from "./types";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export async function captureWeReadSession(): Promise<WebSession | undefined> {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    browser = await launchSystemChrome();
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("https://weread.qq.com/", { waitUntil: "domcontentloaded" });

    vscode.window.showInformationMessage("请在新打开的 Chrome 中扫码登录微信读书，然后打开一本书并翻一页。插件检测到阅读请求后会自动完成配置。");
    const request = await waitForReadRequest(page);
    const cookies = await context.cookies("https://weread.qq.com");
    const cookie = cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    const headers = await request.allHeaders();
    const protectedHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (/^x-wrpa-\d+$/i.test(name)) protectedHeaders[name.toLowerCase()] = value;
    }
    if (!cookie.includes("wr_vid=") || !cookie.includes("wr_skey=")) {
      throw new Error("已捕获阅读请求，但没有获取到完整微信读书 Cookie，请重新扫码登录");
    }
    if (!Object.keys(protectedHeaders).length) {
      throw new Error("阅读请求中没有 x-wrpa 授权头，请确认已打开正文并实际翻了一页");
    }
    return {
      cookie,
      userAgent: headers["user-agent"] || await page.evaluate(() => navigator.userAgent),
      referer: headers.referer || page.url(),
      origin: headers.origin || "https://weread.qq.com",
      protectedHeaders
    };
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function launchSystemChrome(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "chrome", headless: false });
  } catch (error) {
    if (process.platform === "darwin") {
      return chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: false });
    }
    throw new Error(`没有找到可用的 Google Chrome：${error instanceof Error ? error.message : String(error)}`);
  }
}

function waitForReadRequest(page: Page): Promise<Request> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      page.off("request", listener);
      reject(new Error("等待登录超时。请重新执行自动登录，并在 5 分钟内扫码、打开书籍和翻页"));
    }, LOGIN_TIMEOUT_MS);
    const listener = (request: Request): void => {
      if (!request.url().includes("/web/book/read") || request.method() !== "POST") return;
      clearTimeout(timeout);
      page.off("request", listener);
      resolve(request);
    };
    page.on("request", listener);
  });
}
