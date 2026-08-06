import type * as vscode from "vscode";
import * as opentype from "opentype.js";
import { decompress as decompressWoff2 } from "wawoff2";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright-core";
import type { Book, BookshelfPage, Chapter, FanqieSession, ReadingClient } from "./types";

const SECRET_SESSION = "vscodeReading.providers.fanqie.webSession";
const SECRET_BOOK_ROUTES = "vscodeReading.providers.fanqie.bookRoutes";
const FANQIE_ORIGIN = "https://fanqienovel.com";
const execFileAsync = promisify(execFile);

type JsonObject = Record<string, unknown>;

export class FanqieClient implements ReadingClient {
  private readonly chapterCache = new Map<string, string>();
  private readonly chapterRequests = new Map<string, Promise<string>>();
  private browser?: Browser;
  private context?: BrowserContext;
  private workPage?: Page;
  private readonly pendingOperations: Array<{ priority: number; sequence: number; execute: () => void }> = [];
  private operationRunning = false;
  private operationSequence = 0;
  private idleTimer?: NodeJS.Timeout;
  private lastStoragePersistAt = 0;
  private shuttingDown = false;

  constructor(private readonly secrets: vscode.SecretStorage, private readonly extensionPath = "", private readonly storagePath = "", private readonly performanceLog?: (line: string) => void) {}

  async setSession(value: FanqieSession): Promise<void> {
    await this.disposeBrowser();
    await this.secrets.store(SECRET_SESSION, JSON.stringify(value));
  }

  async getSession(): Promise<FanqieSession | undefined> {
    const raw = await this.secrets.get(SECRET_SESSION);
    if (!raw) return undefined;
    try { return JSON.parse(raw) as FanqieSession; } catch { return undefined; }
  }

  async clear(): Promise<void> {
    await this.disposeBrowser();
    await this.secrets.delete(SECRET_SESSION);
    await this.secrets.delete(SECRET_BOOK_ROUTES);
    this.chapterCache.clear();
    if (this.storagePath) await rm(join(this.storagePath, "fanqie"), { recursive: true, force: true }).catch(() => undefined);
  }

  dispose(): void {
    this.shuttingDown = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.pendingOperations.length = 0;
    const page = this.workPage;
    const context = this.context;
    const browser = this.browser;
    this.workPage = undefined;
    this.context = undefined;
    this.browser = undefined;
    void page?.close().catch(() => undefined);
    void context?.close().catch(() => undefined);
    void browser?.close({ reason: "VS Code is shutting down" }).catch(() => undefined);
  }

  async getBookshelf(): Promise<Book[]> {
    return (await this.getBookshelfPage(undefined, 20)).items;
  }

  async getBookshelfPage(cursor?: string, limit = 20, _force = false): Promise<BookshelfPage> {
    const offset = Math.max(0, Number(cursor || 0) || 0);
    return this.withPage(`${FANQIE_ORIGIN}/bookshelf`, async (page, responses) => {
      await settle(page);
      await responses.waitForMatching(["/reading/bookapi/bookshelf/info/"], 5_000);
      await responses.waitForMatching(["/api/book/simple/info"], 5_000);
      const shelfPayloads = await responses.readMatching(["/reading/bookapi/bookshelf/info/"]);
      const detailPayloads = await responses.readMatching(["/api/book/simple/info"]);
      const shelfIds = uniqueStrings(shelfPayloads.flatMap(extractBookIds));
      if (!shelfIds.length) throw new Error("番茄完整书架接口未返回书籍 ID");
      const requestedDetails = shelfIds.length ? await fetchSimpleBookInfo(page, shelfIds) : [];
      const books = uniqueBooks([...detailPayloads.flatMap(extractBooks), ...requestedDetails.flatMap(extractBooks)]);
      if (!books.length) throw new Error("番茄书籍详情接口未返回完整书架数据");
      const items = books.slice(offset, offset + limit);
      const hasMore = offset + items.length < books.length;
      return { items, hasMore, nextCursor: hasMore ? String(offset + items.length) : undefined };
    }, 80);
  }

  async syncBookshelf(): Promise<Book[]> {
    return (await this.withPage(`${FANQIE_ORIGIN}/bookshelf`, async (page, responses) => {
      await settle(page);
      await responses.waitForMatching(["/reading/bookapi/bookshelf/info/"], 5_000);
      await responses.waitForMatching(["/api/book/simple/info"], 5_000);
      const shelfPayloads = await responses.readMatching(["/reading/bookapi/bookshelf/info/"]);
      const detailPayloads = await responses.readMatching(["/api/book/simple/info"]);
      const shelfIds = uniqueStrings(shelfPayloads.flatMap(extractBookIds));
      if (!shelfIds.length) throw new Error("番茄完整书架接口未返回书籍 ID");
      const requestedDetails = shelfIds.length ? await fetchSimpleBookInfo(page, shelfIds) : [];
      const books = uniqueBooks([...detailPayloads.flatMap(extractBooks), ...requestedDetails.flatMap(extractBooks)]);
      if (!books.length) throw new Error("番茄书籍详情接口未返回完整书架数据");
      return books;
    }, 1));
  }

  async getChapters(bookId: string, force = false): Promise<Chapter[]> {
    const started = Date.now();
    const cachedChapters = force ? undefined : await this.readDirectoryCache(bookId);
    if (cachedChapters?.length) {
      this.trace("directory cache", started);
      return cachedChapters;
    }
    return this.fetchChapters(bookId, 80);
  }

  private async fetchChapters(bookId: string, priority: number): Promise<Chapter[]> {
    const shelfTitle = decodeShelfLocator(bookId);
    let effectiveBookId = bookId;
    if (shelfTitle) {
      const matched = (await this.syncBookshelf()).find((book) => book.title === shelfTitle);
      if (!matched) throw new Error(`番茄完整书架接口中没有找到《${shelfTitle}》`);
      effectiveBookId = matched.bookId;
    }
    const readerId = decodeReaderLocator(bookId);
    const initialUrl = readerId ? `${FANQIE_ORIGIN}/reader/${readerId}` : `${FANQIE_ORIGIN}/page/${encodeURIComponent(effectiveBookId)}`;
    const directUrl = readerId ? `${FANQIE_ORIGIN}/reader/${readerId}` : initialUrl;
    return this.withPage(directUrl, async (page, responses) => {
      await settle(page);
      const catalog = page.getByText("目录", { exact: true }).last();
      if (await catalog.isVisible().catch(() => false)) await catalog.click().catch(() => undefined);
      let apiItems = (await responses.readMatching(["/api/reader/directory/detail"])).flatMap(extractChapters);
      if (!apiItems.length) {
        await responses.waitForMatching(["/api/reader/directory/detail"], 10_000);
        apiItems = (await responses.readMatching(["/api/reader/directory/detail"])).flatMap(extractChapters);
      }
      const initialState = await page.evaluate(() => {
        const state = (window as unknown as { __INITIAL_STATE__?: { page?: unknown; reader?: unknown } }).__INITIAL_STATE__;
        return state || {};
      }).catch(() => ({}));
      const initialDirectory = extractChapters(initialState);
      apiItems = uniqueChapters([...apiItems, ...initialDirectory]);
      const resolvedBookId = (/^\d{10,}$/.test(effectiveBookId) ? effectiveBookId : undefined) || extractBookIds(initialState)[0];
      if (!apiItems.length && resolvedBookId && !page.url().includes(`/page/${resolvedBookId}`)) {
        await safeGoto(page, `${FANQIE_ORIGIN}/page/${resolvedBookId}`);
        await settle(page);
        const bookState = await page.evaluate(() => (window as unknown as { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__ || {}).catch(() => ({}));
        apiItems = uniqueChapters([...apiItems, ...extractChapters(bookState)]);
      }
      if (resolvedBookId && !apiItems.length) {
        const directPayload = await fetchDirectoryDetail(page, resolvedBookId);
        if (directPayload) apiItems = uniqueChapters([...apiItems, ...extractChapters(directPayload)]);
      }
      const items = sortFanqieChapters(uniqueChapters(apiItems));
      if (!items.length) {
        const detail = await responses.describeMatching(["/api/reader/directory/detail"]);
        throw new Error(`番茄目录请求失败：${detail || "官网接口返回空章节列表"}`);
      }
      const chapters = items.map((item, index) => ({
        chapterUid: fanqieChapterNumber(item.title) || index + 1,
        chapterIdx: index,
        sourceId: item.sourceId,
        title: item.title,
        wordCount: item.wordCount || 0
      }));
      await this.writeDirectoryCache(bookId, chapters);
      return chapters;
    }, priority);
  }

  async getProgress(): Promise<{}> { return {}; }

  async getChapterText(bookId: string, chapter: Chapter, force = false): Promise<string> {
    const key = `${bookId}:${chapter.sourceId || chapter.chapterUid}`;
    if (!force) {
      const pending = this.chapterRequests.get(key);
      if (pending) return pending;
    }
    const request = this.getChapterTextWithPriority(bookId, chapter, force, 100);
    if (!force) this.chapterRequests.set(key, request);
    try { return await request; } finally { if (this.chapterRequests.get(key) === request) this.chapterRequests.delete(key); }
  }

  private async getChapterTextWithPriority(bookId: string, chapter: Chapter, force: boolean, priority: number): Promise<string> {
    const started = Date.now();
    const itemId = chapter.sourceId;
    if (!itemId || !/^\d{10,}$/.test(itemId)) throw new Error("番茄章节缺少有效的正文标识");
    const key = `${bookId}:${itemId}`;
    if (!force && this.chapterCache.has(key)) { this.trace("chapter memory-cache", started); return this.chapterCache.get(key)!; }
    if (!force) {
      const persisted = await this.readChapterCache(key);
      if (persisted) {
        this.rememberChapter(key, persisted);
        this.trace("chapter disk-cache", started);
        return persisted;
      }
    }
    const text = await this.withPage(`${FANQIE_ORIGIN}/reader/${itemId}`, async (page, responses) => {
      await settle(page, ".muye-reader-content p");
      const fullPayloads = await responses.readMatching(["/api/reader/full"]);
      const apiChapter = fullPayloads.map(extractChapterContent).find((value) => value.text);
      const dom = await page.evaluate(() => {
        const container = document.querySelector<HTMLElement>(".muye-reader-content");
        const body = document.body?.innerText || "";
        const wordMatch = body.match(/本章字数[：:]\s*(\d+)\s*字/);
        return {
          text: container?.innerText?.trim() || "",
          paragraphCount: container?.querySelectorAll("p").length || 0,
          expected: Number(wordMatch?.[1] || 0),
          hasPaywall: Array.from(document.querySelectorAll<HTMLElement>(".muye-to-vip, .toutiao-to-vip"))
            .some((element) => element.offsetParent !== null && element.getBoundingClientRect().height > 0),
          hasNextChapter: Array.from(document.querySelectorAll<HTMLElement>("button, a")).some((element) => /下一章/.test(element.innerText || ""))
        };
      });
      let plain = normalizeChapterText(apiChapter?.text || dom.text);
      const expected = apiChapter?.wordCount || dom.expected || chapter.wordCount;
      const locked = Boolean(apiChapter?.locked);
      if ((dom.hasPaywall || locked) && plain.length < Math.max(300, expected * 0.45)) {
        throw new Error("当前账号没有此章节的完整网页阅读权限；插件不会绕过登录、付费或 SVIP 限制");
      }
      if (expected > 300 && plain.length < expected * 0.45) {
        throw new Error(`当前章节只获得约 ${plain.length} 字，未达到章节标记的 ${expected} 字，服务器可能仅返回了预览内容`);
      }
      if (plain.length < 80 || (!dom.hasNextChapter && dom.paragraphCount < 2)) throw new Error("番茄页面返回的章节正文为空或不完整");
      if (containsPrivateUseCharacters(plain)) {
        const fontBodies = await responses.readFontBodies();
        plain = decodeFanqieDynamicFont(plain, fontBodies);
        const fontKey = fontCacheKey(fontBodies);
        const mapping = await this.readFontMapping(fontKey);
        const fingerprints = await glyphFingerprints(fontBodies);
        const knownGlyphs = await this.readGlyphDictionary();
        applyFingerprintMappings(mapping, fingerprints, knownGlyphs);
        plain = applyFanqieCharacterMapping(plain, mapping);
        if (containsPrivateUseCharacters(plain) && supportsNativeOcr(process.platform) && this.extensionPath) {
          const ocrStarted = Date.now();
          const learned = await recognizeRenderedChapter(page, this.extensionPath, mapping).catch(() => undefined);
          this.trace("dynamic-font OCR", ocrStarted);
          if (learned) {
            plain = learned.text;
            await this.writeFontMapping(fontKey, learned.mapping);
            await this.learnGlyphDictionary(fingerprints, learned.mapping);
          }
        }
      }
      return plain;
    }, priority);
    this.rememberChapter(key, text);
    void this.writeChapterCache(key, text).catch(() => undefined);
    this.trace(`chapter foreground=${priority >= 100}`, started);
    return text;
  }

  async prefetchChapters(bookId: string, chapters: Chapter[]): Promise<void> {
    for (const chapter of chapters.slice(0, 2)) {
      const key = `${bookId}:${chapter.sourceId || chapter.chapterUid}`;
      if (this.chapterCache.has(key) || this.chapterRequests.has(key)) continue;
      const request = this.getChapterTextWithPriority(bookId, chapter, false, 10);
      this.chapterRequests.set(key, request);
      try { await request; } catch { /* Background prefetch is intentionally silent. */ }
      finally { if (this.chapterRequests.get(key) === request) this.chapterRequests.delete(key); }
    }
  }

  private async withPage<T>(url: string, action: (page: Page, responses: ResponseCollector) => Promise<T>, priority = 50): Promise<T> {
    return this.enqueue(async () => {
      const started = Date.now();
      const context = await this.ensureContext();
      const session = await this.getSession();
      if (!session) throw new Error("请先登录番茄小说");
      for (let attempt = 0; attempt < 2; attempt++) {
        const page = await this.ensureWorkPage(context, session);
        const responses = new ResponseCollector(page);
        try {
          await safeGoto(page, url);
          const result = await action(page, responses);
          this.trace(`page ${new URL(url).pathname}`, started);
          return result;
        } catch (error) {
          if (attempt === 0 && isRecoverablePageFailure(error)) {
            await page.close().catch(() => undefined);
            if (this.workPage === page) this.workPage = undefined;
            continue;
          }
          throw new Error(safeBrowserError(error));
        } finally {
          responses.dispose();
          await this.persistContextState(false).catch(() => undefined);
          this.scheduleIdleClose();
        }
      }
      throw new Error("番茄网页请求失败");
    }, priority);
  }

  private async ensureWorkPage(context: BrowserContext, session: FanqieSession): Promise<Page> {
    if (this.workPage && !this.workPage.isClosed()) return this.workPage;
    const page = await context.newPage();
    if (session.sessionStorage?.length) {
      await page.addInitScript((entries: Array<{ name: string; value: string }>) => {
        if (location.origin !== "https://fanqienovel.com") return;
        for (const entry of entries) window.sessionStorage.setItem(entry.name, entry.value);
      }, session.sessionStorage);
    }
    this.workPage = page;
    return page;
  }

  private enqueue<T>(operation: () => Promise<T>, priority: number): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error("VS Code 正在关闭"));
    return new Promise<T>((resolve, reject) => {
      const sequence = this.operationSequence++;
      this.pendingOperations.push({ priority, sequence, execute: () => {
        void operation().then(resolve, reject).finally(() => { this.operationRunning = false; this.runNextOperation(); });
      } });
      this.pendingOperations.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
      this.runNextOperation();
    });
  }

  private runNextOperation(): void {
    if (this.operationRunning) return;
    const next = this.pendingOperations.shift();
    if (!next) return;
    this.operationRunning = true;
    next.execute();
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.shuttingDown) throw new Error("VS Code 正在关闭");
    if (this.context && this.browser?.isConnected()) return this.context;
    if (this.context || this.browser) await this.disposeBrowser();
    const session = await this.getSession();
    if (!session) throw new Error("请先登录番茄小说");
    const started = Date.now();
    this.browser = await launchChrome();
    this.context = await this.browser.newContext({ userAgent: session.userAgent, storageState: session.storageState || { cookies: session.cookies, origins: [] } });
    await this.context.route("**/*", async (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media") await route.abort();
      else await route.continue();
    });
    this.trace("browser startup", started);
    return this.context;
  }

  private trace(operation: string, started: number): void {
    this.performanceLog?.(`[${new Date().toISOString()}] 番茄 ${operation}: ${Date.now() - started}ms`);
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.disposeBrowser(); }, 15 * 60 * 1000);
  }

  private async disposeBrowser(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const context = this.context;
    const browser = this.browser;
    const workPage = this.workPage;
    this.context = undefined;
    this.browser = undefined;
    this.workPage = undefined;
    if (context) await this.persistStorageState(context, true).catch(() => undefined);
    await workPage?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  private async persistContextState(force: boolean): Promise<void> {
    if (this.context) await this.persistStorageState(this.context, force);
  }

  private async persistStorageState(context: BrowserContext, force: boolean): Promise<void> {
    if (!force && Date.now() - this.lastStoragePersistAt < 3 * 60 * 1000) return;
    const session = await this.getSession();
    if (!session) return;
    const storageState = await context.storageState({ indexedDB: true });
    session.cookies = storageState.cookies;
    session.storageState = { cookies: storageState.cookies, origins: storageState.origins };
    await this.secrets.store(SECRET_SESSION, JSON.stringify(session));
    this.lastStoragePersistAt = Date.now();
  }

  private cacheDirectory(): string { return join(this.storagePath, "fanqie"); }
  private rememberChapter(key: string, text: string): void {
    this.chapterCache.delete(key);
    this.chapterCache.set(key, text);
    while (this.chapterCache.size > 20) this.chapterCache.delete(this.chapterCache.keys().next().value!);
  }
  private async readChapterCache(key: string): Promise<string | undefined> {
    if (!this.storagePath) return undefined;
    try { return await readFile(join(this.cacheDirectory(), "chapters", `${hashText(key)}.txt`), "utf8"); } catch { return undefined; }
  }
  private async writeChapterCache(key: string, text: string): Promise<void> {
    if (!this.storagePath) return;
    const directory = join(this.cacheDirectory(), "chapters");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${hashText(key)}.txt`), text, "utf8");
    await this.pruneChapterCache(directory);
  }
  private async pruneChapterCache(directory: string): Promise<void> {
    const files = await readdir(directory).catch(() => [] as string[]);
    if (files.length <= 20) return;
    const entries = await Promise.all(files.map(async (name) => ({ name, modified: (await stat(join(directory, name))).mtimeMs })));
    entries.sort((left, right) => right.modified - left.modified);
    await Promise.all(entries.slice(20).map((entry) => unlink(join(directory, entry.name)).catch(() => undefined)));
  }
  private async readDirectoryCache(bookId: string): Promise<Chapter[] | undefined> {
    if (!this.storagePath) return undefined;
    try {
      const cached = JSON.parse(await readFile(join(this.cacheDirectory(), "directories", `${hashText(bookId)}.json`), "utf8")) as { version?: number; savedAt: number; chapters: Chapter[] };
      return cached.version === 2 && cached.chapters?.length ? cached.chapters : undefined;
    } catch { return undefined; }
  }
  private async writeDirectoryCache(bookId: string, chapters: Chapter[]): Promise<void> {
    if (!this.storagePath) return;
    const directory = join(this.cacheDirectory(), "directories");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${hashText(bookId)}.json`), JSON.stringify({ version: 2, savedAt: Date.now(), chapters }), "utf8");
  }
  private async readFontMapping(fontKey: string): Promise<Record<string, string>> {
    if (!this.storagePath) return {};
    try { return JSON.parse(await readFile(join(this.cacheDirectory(), "fonts", `${fontKey}.json`), "utf8")) as Record<string, string>; } catch { return {}; }
  }
  private async writeFontMapping(fontKey: string, mapping: Record<string, string>): Promise<void> {
    if (!this.storagePath || !Object.keys(mapping).length) return;
    const directory = join(this.cacheDirectory(), "fonts");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${fontKey}.json`), JSON.stringify(mapping), "utf8");
  }
  private async readGlyphDictionary(): Promise<Record<string, string>> {
    if (!this.storagePath) return {};
    try { return JSON.parse(await readFile(join(this.cacheDirectory(), "fonts", "glyphs.json"), "utf8")) as Record<string, string>; } catch { return {}; }
  }
  private async learnGlyphDictionary(fingerprints: Record<string, string>, mapping: Record<string, string>): Promise<void> {
    if (!this.storagePath) return;
    const dictionary = await this.readGlyphDictionary();
    let changed = false;
    for (const [code, character] of Object.entries(mapping)) {
      const fingerprint = fingerprints[code];
      if (fingerprint && (!dictionary[fingerprint] || dictionary[fingerprint] === character)) {
        changed ||= dictionary[fingerprint] !== character;
        dictionary[fingerprint] = character;
      }
    }
    if (!changed) return;
    const directory = join(this.cacheDirectory(), "fonts");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "glyphs.json"), JSON.stringify(dictionary), "utf8");
  }
}

async function recognizeRenderedChapter(page: Page, extensionPath: string, existing: Record<string, string>): Promise<{ text: string; mapping: Record<string, string> }> {
  const paragraphs = await page.locator(".muye-reader-content p").allInnerTexts();
  if (!paragraphs.length) throw new Error("没有可识别的正文段落");
  const directory = await mkdtemp(join(tmpdir(), "vscode-reading-fanqie-"));
  try {
    await page.evaluate(() => {
      const original = document.querySelector<HTMLElement>(".muye-reader-content");
      const family = original ? getComputedStyle(original).fontFamily : "sans-serif";
      document.body.innerHTML = "";
      Object.assign(document.body.style, { margin: "0", background: "white" });
      const root = document.createElement("div");
      root.id = "vscode-reading-ocr";
      Object.assign(root.style, { fontFamily: family, fontSize: "40px", lineHeight: "1.8", fontWeight: "400", color: "black", background: "white", width: "1000px", padding: "24px" });
      document.body.append(root);
    });
    const root = page.locator("#vscode-reading-ocr");
    for (let index = 0; index < paragraphs.length; index++) {
      if (!containsPrivateUseCharacters(applyFanqieCharacterMapping(paragraphs[index], existing))) continue;
      await root.evaluate((element, text) => { element.textContent = text; }, paragraphs[index]);
      await root.screenshot({ path: join(directory, `${String(index).padStart(4, "0")}.png`) });
    }
    const { command, args } = nativeOcrCommand(extensionPath, directory, process.platform);
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 4 * 1024 * 1024, timeout: 60_000, windowsHide: true });
    const recognized = new Map<number, string>();
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^(\d+)\t(.+)$/);
      if (match) recognized.set(Number(match[1]), match[2].trim());
    }
    const mapping = { ...existing };
    const result = paragraphs.map((paragraph, index) => {
      const ocr = recognized.get(index);
      if (ocr) learnFanqieCharacterMapping(paragraph, ocr, mapping);
      return ocr || applyFanqieCharacterMapping(paragraph, mapping);
    }).join("\n\n");
    return { text: result.trim(), mapping };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function supportsNativeOcr(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export function nativeOcrCommand(extensionPath: string, directory: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: join(extensionPath, "bin", "fanqie-vision-ocr"), args: [directory] };
  if (platform === "win32") return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(extensionPath, "scripts", "windows_ocr.ps1"), directory]
  };
  throw new Error("当前系统没有可用的原生 OCR");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function fontCacheKey(bodies: Buffer[]): string {
  if (!bodies.length) return "default";
  return hashText(bodies.map((body) => createHash("sha256").update(body).digest("hex")).sort().join("|"));
}

export async function glyphFingerprints(fontBodies: Buffer[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const body of fontBodies) {
    try {
      const decoded = body.subarray(0, 4).toString("ascii") === "wOF2" ? await decompressWoff2(body) : body;
      const bytes = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer;
      const font = opentype.parse(bytes);
      for (let index = 0; index < font.glyphs.length; index++) {
        const glyph = font.glyphs.get(index);
        const encoded = glyph.unicodes.find(isPrivateUseCodePoint);
        if (encoded === undefined) continue;
        const commands = glyph.getPath(0, 0, font.unitsPerEm).commands.map((command) => {
          const normalized: Record<string, string> = { type: command.type };
          const values = command as unknown as Record<string, unknown>;
          for (const key of ["x", "y", "x1", "y1", "x2", "y2"] as const) {
            const value = values[key];
            if (typeof value === "number") normalized[key] = (value / font.unitsPerEm).toFixed(5);
          }
          return normalized;
        });
        result[encoded.toString(16)] = hashText(JSON.stringify(commands));
      }
    } catch {
      // Ignore unrelated or malformed font responses.
    }
  }
  return result;
}

export function applyFingerprintMappings(mapping: Record<string, string>, fingerprints: Record<string, string>, dictionary: Record<string, string>): void {
  for (const [code, fingerprint] of Object.entries(fingerprints)) {
    const character = dictionary[fingerprint];
    if (character && !mapping[code]) mapping[code] = character;
  }
}

export function applyFanqieCharacterMapping(value: string, mapping: Record<string, string>): string {
  return [...value].map((character) => mapping[character.codePointAt(0)!.toString(16)] || character).join("");
}

export function learnFanqieCharacterMapping(original: string, recognized: string, mapping: Record<string, string>): void {
  const left = [...original];
  const right = [...recognized];
  if (left.length !== right.length) return;
  for (let index = 0; index < left.length; index++) {
    const code = left[index].codePointAt(0)!;
    if (!isPrivateUseCodePoint(code) || !isReadableCodePoint(right[index].codePointAt(0)!)) continue;
    const key = code.toString(16);
    const candidate = right[index];
    if (!mapping[key] || mapping[key] === candidate) mapping[key] = candidate;
  }
}

class ResponseCollector {
  private readonly responses: Response[] = [];
  private readonly listener: (response: Response) => void;
  constructor(private readonly page: Page) {
    this.listener = (response) => {
      if (response.url().startsWith(FANQIE_ORIGIN) || response.request().resourceType() === "font") this.responses.push(response);
    };
    page.on("response", this.listener);
  }
  dispose(): void {
    this.page.off("response", this.listener);
  }
  async readFontBodies(): Promise<Buffer[]> {
    const fonts = this.responses.filter((response) => response.request().resourceType() === "font" || /\.(?:woff2?|ttf|otf)(?:\?|$)/i.test(response.url()));
    const values = await Promise.all(fonts.map((response) => response.ok() ? response.body().catch(() => undefined) : undefined));
    return values.filter((value): value is Buffer => Boolean(value?.length));
  }
  async waitForMatching(paths: string[], timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.responses.some((response) => paths.some((path) => response.url().includes(path)))) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async readMatching(paths: string[]): Promise<unknown[]> {
    const matches = this.responses.filter((response) => paths.some((path) => response.url().includes(path)));
    const values = await Promise.all(matches.map(async (response) => {
      if (!response.ok()) return undefined;
      try { return parseFanqieJson(await response.text()); } catch { return undefined; }
    }));
    return values.filter((value) => value !== undefined);
  }
  async describeMatching(paths: string[]): Promise<string> {
    const matches = this.responses.filter((response) => paths.some((path) => response.url().includes(path)));
    if (!matches.length) return "官网没有发出目录接口请求";
    const details = await Promise.all(matches.map(async (response) => {
      let official = "";
      try {
        const payload = parseFanqieJson(await response.text()) as Record<string, unknown>;
        const code = payload.code;
        const message = payload.message || payload.msg;
        if (code !== undefined || message) official = `，code=${String(code ?? "")}${message ? `，message=${String(message)}` : ""}`;
      } catch { /* HTTP status is still useful. */ }
      return `HTTP ${response.status()}${official}`;
    }));
    return details.join("；");
  }
}

export function containsPrivateUseCharacters(value: string): boolean {
  return /[\uE000-\uF8FF]/u.test(value);
}

export function decodeFanqieDynamicFont(value: string, fontBodies: Buffer[]): string {
  const mapping = new Map<number, number>();
  for (const body of fontBodies) {
    try {
      const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
      const font = opentype.parse(bytes);
      for (let index = 0; index < font.glyphs.length; index++) {
        const glyph = font.glyphs.get(index);
        const encoded = glyph.unicodes.find((code) => isPrivateUseCodePoint(code));
        if (encoded === undefined) continue;
        const original = glyph.unicodes.find((code) => !isPrivateUseCodePoint(code) && isReadableCodePoint(code)) ?? codePointFromGlyphName(glyph.name);
        if (original !== undefined && isReadableCodePoint(original)) mapping.set(encoded, original);
      }
    } catch {
      // Ignore unrelated or unsupported font responses.
    }
  }
  return [...value].map((character) => {
    const code = character.codePointAt(0)!;
    const decoded = mapping.get(code);
    return decoded === undefined ? character : String.fromCodePoint(decoded);
  }).join("");
}

function isPrivateUseCodePoint(code: number): boolean {
  return code >= 0xE000 && code <= 0xF8FF;
}

function isReadableCodePoint(code: number): boolean {
  return (code >= 0x20 && code <= 0xD7FF) || (code >= 0xF900 && code <= 0x10FFFF);
}

function codePointFromGlyphName(name?: string | null): number | undefined {
  const match = name?.match(/^(?:uni|u)([0-9a-f]{4,6})$/i);
  if (!match) return undefined;
  const code = Number.parseInt(match[1], 16);
  return Number.isFinite(code) ? code : undefined;
}

export function parseFanqieJson(value: string): unknown {
  // Chapter and book identifiers exceed Number.MAX_SAFE_INTEGER. Quote only
  // known identifier fields before JSON.parse so they remain exact strings.
  const protectedIds = value.replace(/("(?:book_?id(?:_str)?|bookId(?:Str)?|item_?id(?:_str)?|itemId(?:Str)?|chapter_?id(?:_str)?|chapterId(?:Str)?)"\s*:\s*)(\d{16,})/gi, "$1\"$2\"");
  return JSON.parse(protectedIds) as unknown;
}

export function extractBooks(payload: unknown): Book[] {
  const values: Book[] = [];
  walk(payload, (object) => {
    const bookId = stringField(object, ["bookId", "book_id", "bookID", "bookIdStr", "book_id_str"]);
    const title = stringField(object, ["bookName", "book_name", "bookTitle", "book_title", "title", "name"]);
    if (/^\d{10,}$/.test(bookId) && title) values.push({ bookId, title, author: stringField(object, ["author", "authorName", "author_name"]) });
  });
  return uniqueBooks(values);
}

export function extractBookIds(payload: unknown): string[] {
  const values: string[] = [];
  walk(payload, (object) => {
    const bookId = stringField(object, ["bookId", "book_id", "bookID", "bookIdStr", "book_id_str"]);
    if (/^\d{10,}$/.test(bookId)) values.push(bookId);
  });
  return uniqueStrings(values);
}

export function extractChapters(payload: unknown): Array<{ sourceId: string; title: string; wordCount?: number }> {
  const values: Array<{ sourceId: string; title: string; wordCount?: number }> = [];
  walk(payload, (object) => {
    const sourceId = stringField(object, ["itemId", "item_id", "itemIdStr", "item_id_str", "chapterId", "chapter_id", "chapterIdStr", "chapter_id_str"]);
    const title = stringField(object, ["title", "chapterTitle", "chapter_title"]);
    if (/^\d{10,}$/.test(sourceId) && title) values.push({ sourceId, title, wordCount: numberField(object, ["wordCount", "word_count", "chapterWordNumber"]) });
  });
  return uniqueChapters(values);
}

export function extractChapterContent(payload: unknown): { text: string; wordCount: number; locked: boolean } {
  let best = { text: "", wordCount: 0, locked: false };
  walk(payload, (object) => {
    const raw = stringField(object, ["content", "chapterContent", "chapter_content"]);
    const text = normalizeChapterText(raw);
    if (text.length > best.text.length) best = {
      text,
      wordCount: numberField(object, ["chapterWordNumber", "wordCount", "word_count"]),
      locked: booleanField(object, ["isChapterLock", "isLock", "is_locked"])
    };
  });
  return best;
}

function walk(value: unknown, visit: (object: JsonObject) => void, seen = new Set<unknown>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) { for (const item of value) walk(item, visit, seen); return; }
  const object = value as JsonObject;
  visit(object);
  for (const child of Object.values(object)) walk(child, visit, seen);
}

function stringField(object: JsonObject, names: string[]): string {
  for (const name of names) {
    const value = object[name];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return "";
}

function numberField(object: JsonObject, names: string[]): number {
  const value = Number(stringField(object, names));
  return Number.isFinite(value) ? value : 0;
}

function booleanField(object: JsonObject, names: string[]): boolean {
  return names.some((name) => object[name] === true || object[name] === 1 || object[name] === "1");
}

function uniqueBooks(books: Book[]): Book[] {
  const unique = new Map<string, Book>();
  for (const book of books) {
    if (!book.bookId || !book.title) continue;
    const key = book.title.replace(/\s+/g, "").toLocaleLowerCase();
    const existing = unique.get(key);
    if (!existing || (existing.bookId.startsWith("shelf:") && /^\d{10,}$/.test(book.bookId))) unique.set(key, book);
  }
  return [...unique.values()];
}

async function fetchSimpleBookInfo(page: Page, bookIds: string[]): Promise<unknown[]> {
  const payloads: unknown[] = [];
  for (let offset = 0; offset < bookIds.length; offset += 100) {
    const batch = bookIds.slice(offset, offset + 100);
    const raw = await page.evaluate(async (ids) => {
      const response = await fetch("/api/book/simple/info", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ book_ids: ids })
      });
      return response.ok ? response.text() : "";
    }, batch).catch(() => "");
    if (raw) try { payloads.push(parseFanqieJson(raw)); } catch { /* Ignore malformed fallback responses. */ }
  }
  return payloads;
}

async function fetchDirectoryDetail(page: Page, bookId: string): Promise<unknown | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await page.evaluate(async (id) => {
      const response = await fetch(`/api/reader/directory/detail?bookId=${encodeURIComponent(id)}`, { credentials: "include" });
      return response.ok ? response.text() : "";
    }, bookId).catch(() => "");
    if (raw) try {
      const payload = parseFanqieJson(raw);
      if (extractChapters(payload).length) return payload;
    } catch { /* Retry the official interface. */ }
    await page.waitForTimeout(250 * (attempt + 1));
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] { return [...new Set(values)]; }

function decodeShelfLocator(bookId: string): string | undefined {
  if (!bookId.startsWith("shelf:")) return undefined;
  try { return decodeURIComponent(bookId.slice("shelf:".length)); } catch { return undefined; }
}

function decodeReaderLocator(bookId: string): string | undefined {
  const value = bookId.match(/^reader:(\d{10,})$/)?.[1];
  return value;
}

function uniqueChapters<T extends { sourceId: string; title: string }>(items: T[]): T[] {
  const unique = new Map<string, T>();
  for (const item of items) {
    if (!item.sourceId || !item.title) continue;
    const existing = unique.get(item.sourceId);
    if (!existing || (!/^第\s*\d+\s*章/.test(existing.title) && /^第\s*\d+\s*章/.test(item.title))) unique.set(item.sourceId, item);
  }
  return [...unique.values()];
}

export function sortFanqieChapters<T extends { sourceId: string; title: string }>(items: T[]): T[] {
  const numbered = items
    .filter((item) => !/^(?:最近更新|继续阅读|当前章节)/.test(item.title.trim()))
    .map((item, position) => ({ item, position, number: Number(item.title.match(/^第\s*(\d+)\s*章/)?.[1] || 0) }));
  if (!numbered.some((entry) => entry.number > 0)) return items;
  return numbered.sort((left, right) => {
    if (!left.number || !right.number) return left.position - right.position;
    return left.number - right.number || left.position - right.position;
  }).map((entry) => entry.item);
}

export function hasFirstFanqieChapter(items: Array<{ title: string }>): boolean {
  const numbers = items.map((item) => fanqieChapterNumber(item.title)).filter((value) => value > 0);
  return !numbers.length || Math.min(...numbers) === 1;
}

function fanqieChapterNumber(title: string): number {
  return Number(title.match(/^第\s*(\d+)\s*章/)?.[1] || 0);
}

function normalizeChapterText(value: string): string {
  return value.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&").replace(/\n{3,}/g, "\n\n").trim();
}

async function safeGoto(page: Page, url: string): Promise<void> {
  try { await page.goto(url, { waitUntil: "commit", timeout: 25_000 }); }
  catch (error) { if (!page.url().startsWith(FANQIE_ORIGIN)) throw error; }
}

async function settle(page: Page, selector?: string): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 12_000 }).catch(() => undefined);
  if (selector) await page.locator(selector).first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
}

function safeBrowserError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/登录|权限|正文|书架|章节|动态字体|预览/.test(message)) return message.split("\n")[0];
  if (/Timeout|timeout/i.test(message)) return "番茄网页加载超时，请检查网络后重试";
  return "番茄网页请求失败";
}

export function isRecoverablePageFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Target page, context or browser has been closed|Page crashed|Execution context was destroyed/i.test(message);
}

async function launchChrome(): Promise<Browser> {
  try { return await chromium.launch({ channel: "chrome", headless: true }); }
  catch (chromeError) {
    if (process.platform === "win32") {
      try { return await chromium.launch({ channel: "msedge", headless: true }); } catch { throw chromeError; }
    }
    if (process.platform === "darwin") return chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
    throw chromeError;
  }
}
