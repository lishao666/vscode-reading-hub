import { chromium, type Browser } from "playwright-core";
import type { WebSession } from "./types";

export async function readRenderedChapter(session: WebSession, readerUrl: string): Promise<string> {
  let browser: Browser | undefined;
  try {
    browser = await launchChrome();
    const context = await browser.newContext({ userAgent: session.userAgent });
    await context.addCookies(parseCookies(session.cookie));
    const page = await context.newPage();
    await page.setExtraHTTPHeaders(session.protectedHeaders || {});
    await page.goto(readerUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2_000);

    const text = await page.evaluate(() => {
      const selectors = [
        ".readerChapterContent",
        "[class*='readerChapterContent']",
        "[class*='chapterContent']",
        "[class*='readerContent']",
        "article"
      ];
      const candidates = new Set<Element>();
      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((element) => candidates.add(element));
      }
      let longest = "";
      for (const element of candidates) {
        const value = (element as HTMLElement).innerText?.trim() || "";
        if (value.length > longest.length) longest = value;
      }
      return longest;
    });
    await context.close();
    return text;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function launchChrome(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  }
}

function parseCookies(cookieHeader: string): Array<{ name: string; value: string; domain: string; path: string }> {
  return cookieHeader.split(";").map((part) => part.trim()).filter(Boolean).flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) return [];
    return [{ name: part.slice(0, separator), value: part.slice(separator + 1), domain: ".weread.qq.com", path: "/" }];
  });
}
