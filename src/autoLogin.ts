import * as vscode from "vscode";
import type { Browser, BrowserContext, Page, Request } from "playwright-core";
import { chromium } from "playwright-core";
import type { FanqieSession, WebSession } from "./types";

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

export async function captureFanqieSession(): Promise<FanqieSession | undefined> {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    browser = await launchSystemChrome();
    context = await browser.newContext();
    const page = await context.newPage();
    await gotoFanqiePage(page, "https://fanqienovel.com/bookshelf");
    vscode.window.showInformationMessage("请在新打开的 Chrome 中登录番茄小说。登录成功后必须随意打开一本小说的正文页面；插件检测到已登录的章节正文后才会完成配置。");
    const account = await waitForFanqieReader(page, context);
    const cookies = await context.cookies("https://fanqienovel.com");
    const storageState = await context.storageState({ indexedDB: true });
    const sessionStorage = await page.evaluate(() => Object.keys(window.sessionStorage).map((name) => ({ name, value: window.sessionStorage.getItem(name) || "" })));
    if (!cookies.length) throw new Error("登录成功后没有获取到番茄网页登录 Cookie");
    return {
      cookies: cookies.map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({ name, value, domain, path, expires, httpOnly, secure, sameSite })),
      userAgent: await page.evaluate(() => navigator.userAgent),
      isVip: account.isVip,
      readerUrl: account.readerUrl,
      readerAccessVerified: true,
      storageState: {
        cookies: storageState.cookies,
        origins: storageState.origins
      },
      sessionStorage
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

async function waitForFanqieReader(page: Page, context: BrowserContext): Promise<{ isVip: boolean; readerUrl: string }> {
  const started = Date.now();
  while (Date.now() - started < LOGIN_TIMEOUT_MS) {
    const account = await page.evaluate(() => {
      const state = (window as typeof window & { __INITIAL_STATE__?: { common?: { id?: string | number; name?: string; avatar?: string; isVip?: boolean } } }).__INITIAL_STATE__;
      const common = state?.common;
      const body = document.body?.innerText || "";
      const chapterData = (state as any)?.reader?.chapterData || {};
      const expected = Number(chapterData.chapterWordNumber || 0);
      const contentText = document.querySelector<HTMLElement>(".muye-reader-content")?.innerText?.trim() || "";
      const hasVipElement = Array.from(document.querySelectorAll<HTMLElement>('[class*="vip"], [title*="VIP"], [alt*="VIP"]'))
        .some((element) => element.offsetParent !== null);
      const hasPaywall = Boolean(document.querySelector(".muye-to-vip, .toutiao-to-vip"));
      const lockedChapterIsComplete = Boolean(chapterData.isChapterLock)
        && expected > 0
        && contentText.length >= expected * 0.45
        && !hasPaywall;
      const loginButtonVisible = Array.from(document.querySelectorAll<HTMLElement>("button, div, span"))
        .some((element) => element.offsetParent !== null && /^(登录|注册|会员登录后，可在网页畅读全文)$/.test(element.innerText.trim()));
      const accountVisible = Array.from(document.querySelectorAll<HTMLElement>('[class*="user" i], [class*="avatar" i], [class*="account" i]'))
        .some((element) => element.offsetParent !== null && element.getBoundingClientRect().width > 0);
      const paragraphCount = document.querySelectorAll(".muye-reader-content p").length;
      return {
        identity: String(common?.id || common?.name || common?.avatar || ""),
        isVip: Boolean(common?.isVip) || hasVipElement || /VIP|SVIP|正在使用会员特权/.test(body) || lockedChapterIsComplete,
        accountVisible,
        loginButtonVisible,
        readerReady: /^\/reader\/\d+/.test(location.pathname)
          && paragraphCount >= 2
      };
    }).catch(() => ({ identity: "", isVip: false, accountVisible: false, loginButtonVisible: true, readerReady: false }));
    const cookies = await context.cookies("https://fanqienovel.com");
    const hasAccountCookie = cookies.some((cookie) => /^(sessionid|sessionid_ss|sid_tt|sid_guard|uid_tt|uid_tt_ss)$/i.test(cookie.name) && cookie.value);
    const loggedIn = Boolean(account.identity) || account.accountVisible || (hasAccountCookie && !account.loginButtonVisible);
    if (loggedIn && account.readerReady) return { isVip: account.isVip, readerUrl: page.url() };
    await page.waitForTimeout(1000);
  }
  throw new Error("等待番茄正文请求超时。请在 5 分钟内完成登录，并打开任意一本小说的正文页面");
}

async function gotoFanqiePage(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "commit", timeout: 20_000 });
  } catch (error) {
    if (!page.url().startsWith("https://fanqienovel.com/")) throw error;
  }
  await page.waitForTimeout(800);
}
