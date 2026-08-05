import * as https from "node:https";
import { createHash } from "node:crypto";
import type * as vscode from "vscode";
import { decodeContentShards, encodeWeReadValue, htmlToText, normalizeText, signQuery } from "./codec";
import { readRenderedChapter } from "./renderedChapter";
import type { Book, Chapter, HttpResponse, ReaderState, WebSession } from "./types";

const SKILL_ENDPOINT = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.4";
const SECRET_API_KEY = "vscodeReading.providers.weread.apiKey";
const SECRET_SESSION = "vscodeReading.providers.weread.webSession";
const LEGACY_SECRET_API_KEY = "vscodeWeread.apiKey";
const LEGACY_SECRET_SESSION = "vscodeWeread.webSession";
const READER_TOKEN = "3c5c8717f3daf09iop3423zafeqoi";

export class WeReadClient {
  // Cache chapters read during the current extension process only. Chapter
  // text is never persisted to disk or prefetched in the background.
  private readonly chapterCache = new Map<string, string>();
  private dataGeneration = 0;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  setApiKey(value: string): Thenable<void> { return this.secrets.store(SECRET_API_KEY, value); }
  async getApiKey(): Promise<string | undefined> {
    return this.getAndMigrateSecret(SECRET_API_KEY, LEGACY_SECRET_API_KEY);
  }
  setSession(value: WebSession): Thenable<void> { return this.secrets.store(SECRET_SESSION, JSON.stringify(value)); }

  async getSession(): Promise<WebSession | undefined> {
    const value = await this.getAndMigrateSecret(SECRET_SESSION, LEGACY_SECRET_SESSION);
    if (!value) return undefined;
    try { return JSON.parse(value) as WebSession; } catch { return undefined; }
  }

  async clear(): Promise<void> {
    this.dataGeneration++;
    await Promise.all([
      this.secrets.delete(SECRET_API_KEY),
      this.secrets.delete(SECRET_SESSION),
      this.secrets.delete(LEGACY_SECRET_API_KEY),
      this.secrets.delete(LEGACY_SECRET_SESSION)
    ]);
    this.clearChapterCache();
  }

  clearChapterCache(): void { this.chapterCache.clear(); }

  private async getAndMigrateSecret(currentKey: string, legacyKey: string): Promise<string | undefined> {
    const current = await this.secrets.get(currentKey);
    if (current) return current;
    const legacy = await this.secrets.get(legacyKey);
    if (!legacy) return undefined;
    await this.secrets.store(currentKey, legacy);
    await this.secrets.delete(legacyKey);
    return legacy;
  }

  async getBookshelf(): Promise<Book[]> {
    const payload = await this.callSkill("/shelf/sync", {});
    return (Array.isArray(payload.books) ? payload.books : []).map((book: any) => ({
      bookId: String(book.bookId || ""), title: String(book.title || ""), author: String(book.author || ""), cover: book.cover
    })).filter((book: Book) => book.bookId && book.title);
  }

  async getChapters(bookId: string): Promise<Chapter[]> {
    const payload = await this.callSkill("/book/chapterinfo", { bookId });
    return (Array.isArray(payload.chapters) ? payload.chapters : []).map((chapter: any, index: number) => ({
      chapterUid: Number(chapter.chapterUid || 0),
      chapterIdx: Number(chapter.chapterIdx ?? index),
      title: String(chapter.title || `第 ${index + 1} 章`),
      wordCount: Number(chapter.wordCount || 0),
      paid: chapter.paid,
      price: chapter.price
    })).filter((chapter: Chapter) => chapter.chapterUid > 0);
  }

  async getProgress(bookId: string): Promise<{ chapterUid?: number; chapterOffset?: number; progress?: number }> {
    const payload = await this.callSkill("/book/getprogress", { bookId });
    return payload.book || payload;
  }

  async getChapterText(bookId: string, chapter: Chapter, force = false): Promise<string> {
    const generation = this.dataGeneration;
    const key = `${bookId}:${chapter.chapterUid}`;
    if (!force && this.chapterCache.has(key)) return this.chapterCache.get(key)!;
    const session = await this.requireSession();
    let state = await this.fetchReaderState(session, bookId, chapter.chapterUid, generation);
    try {
      const text = await this.fetchCompleteChapter(session, state, bookId, chapter, generation);
      this.assertCurrentGeneration(generation);
      this.chapterCache.set(key, text);
      return text;
    } catch (error) {
      if (this.isAccessDenied(error)) throw error;
      this.assertCurrentGeneration(generation);
      state = await this.fetchReaderState(session, bookId, chapter.chapterUid, generation);
      const text = await this.fetchCompleteChapter(session, state, bookId, chapter, generation);
      this.assertCurrentGeneration(generation);
      this.chapterCache.set(key, text);
      return text;
    }
  }

  private async fetchCompleteChapter(session: WebSession, state: ReaderState, bookId: string, chapter: Chapter, generation: number): Promise<string> {
    const normal = await this.fetchChapter(session, state, bookId, chapter, false, generation);
    if (!this.looksTruncated(normal, chapter)) return this.repairRenderedTextIfNeeded(session, bookId, chapter, normal);

    // The web reader can use more than one rendering mode for content that the
    // current account is already authorized to read. Both requests use the
    // same server-validated session and do not bypass access checks.
    const alternate = await this.fetchChapter(session, state, bookId, chapter, true, generation).catch((error) => {
      this.assertCurrentGeneration(generation);
      if (this.isAccessDenied(error)) throw error;
      return "";
    });
    const best = alternate.length > normal.length ? alternate : normal;
    if (this.looksTruncated(best, chapter)) {
      throw new Error(`《${chapter.title}》只返回了 ${best.length} 字，目录标记约 ${chapter.wordCount} 字。请在微信读书网页版打开这个付费章节，确认正文已完全显示后，重新复制该页面 /web/book/read 请求的 cURL 并更新网页登录态。`);
    }
    return this.repairRenderedTextIfNeeded(session, bookId, chapter, best);
  }

  private async repairRenderedTextIfNeeded(session: WebSession, bookId: string, chapter: Chapter, text: string): Promise<string> {
    if (!text.includes("\uFFFD")) return text;
    const rendered = normalizeText(await readRenderedChapter(session, this.readerUrl(bookId, chapter.chapterUid)));
    if (!rendered || rendered.includes("\uFFFD") || rendered.length < text.length * 0.6) return text;
    return rendered;
  }

  private looksTruncated(text: string, chapter: Chapter): boolean {
    if (!chapter.wordCount || chapter.wordCount < 300) return false;
    const visibleLength = text.replace(/\s/g, "").length;
    return visibleLength < Math.min(500, Math.floor(chapter.wordCount * 0.2));
  }

  private async callSkill(apiName: string, params: Record<string, unknown>): Promise<any> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error("尚未配置微信读书 API Key");
    const body = JSON.stringify({ api_name: apiName, skill_version: SKILL_VERSION, ...params });
    const response = await this.request("POST", SKILL_ENDPOINT, {
      Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body))
    }, body);
    const payload = JSON.parse(response.body || "{}");
    if (response.statusCode >= 400 || payload.errcode) throw new Error(`Skill 服务请求失败（HTTP ${response.statusCode}）`);
    if (payload.upgrade_info) throw new Error("微信读书 Skill 需要升级");
    return payload;
  }

  private async requireSession(): Promise<WebSession> {
    const session = await this.getSession();
    if (!session) throw new Error("尚未配置微信读书网页登录态");
    return session;
  }

  private async fetchReaderState(session: WebSession, bookId: string, chapterUid: number, generation: number): Promise<ReaderState> {
    await this.renewSession(session, generation);
    const response = await this.request("GET", this.readerUrl(bookId, chapterUid), this.webHeaders(session, {
      Referer: "https://weread.qq.com/", Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }));
    await this.updateCookies(session, response.headers, generation);
    const match = response.body.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;\s*\(function/);
    if (!match?.[1]) throw new Error("网页登录态无效或书籍不可读，请重新配置 Cookie");
    const reader = JSON.parse(match[1]).reader || {};
    return { psvts: String(reader.psvts || ""), pclts: String(reader.pclts || ""), token: String(reader.token || READER_TOKEN) };
  }

  private async fetchChapter(session: WebSession, state: ReaderState, bookId: string, chapter: Chapter, style: boolean, generation: number): Promise<string> {
    const e0 = await this.postContent(session, state, bookId, chapter.chapterUid, "/web/book/chapter/e_0", style, generation);
    if (e0.startsWith("{") && e0.includes('"bookId"')) {
      const t0 = await this.postContent(session, state, bookId, chapter.chapterUid, "/web/book/chapter/t_0", style, generation);
      let t1 = "";
      try { t1 = await this.postContent(session, state, bookId, chapter.chapterUid, "/web/book/chapter/t_1", style, generation); } catch {}
      return normalizeText(decodeContentShards(t0, t1));
    }
    const [e1, e3] = await Promise.all([
      this.postContent(session, state, bookId, chapter.chapterUid, "/web/book/chapter/e_1", style, generation),
      this.postContent(session, state, bookId, chapter.chapterUid, "/web/book/chapter/e_3", style, generation)
    ]);
    return normalizeText(htmlToText(decodeContentShards(e0, e1, e3)));
  }

  private async postContent(session: WebSession, state: ReaderState, bookId: string, chapterUid: number, endpoint: string, style: boolean, generation: number): Promise<string> {
    const body = JSON.stringify(this.contentParams(bookId, chapterUid, state.psvts, style));
    const response = await this.request("POST", `https://weread.qq.com${endpoint}`, this.webHeaders(session, {
      Referer: this.readerUrl(bookId, chapterUid), "Content-Type": "application/json;charset=UTF-8", "Content-Length": String(Buffer.byteLength(body))
    }), body);
    await this.updateCookies(session, response.headers, generation);
    if (response.statusCode >= 400 || !response.body || response.body === "{}") {
      throw new Error(`章节不可读或登录态失效（HTTP ${response.statusCode}）`);
    }
    return response.body;
  }

  private async renewSession(session: WebSession, generation: number): Promise<void> {
    const body = JSON.stringify({ rq: "%2Fweb%2Fbook%2Fread", ql: false });
    const response = await this.request("POST", "https://weread.qq.com/web/login/renewal", this.webHeaders(session, {
      Referer: "https://weread.qq.com/", "Content-Type": "application/json;charset=UTF-8", "Content-Length": String(Buffer.byteLength(body))
    }), body);
    await this.updateCookies(session, response.headers, generation);
  }

  private readerUrl(bookId: string, chapterUid: number): string {
    return `https://weread.qq.com/web/reader/${encodeWeReadValue(bookId)}k${encodeWeReadValue(chapterUid)}`;
  }

  private contentParams(bookId: string, chapterUid: number, psvts: string, style: boolean): Record<string, string | number | boolean> {
    let timestamp = Math.floor(Date.now() / 1000);
    if (encodeWeReadValue(timestamp) === psvts) timestamp++;
    const random = Math.floor(Math.random() * 10000);
    const params: Record<string, string | number | boolean> = {
      b: encodeWeReadValue(bookId), c: encodeWeReadValue(chapterUid), r: String(random * random), ct: String(timestamp),
      ps: psvts, pc: encodeWeReadValue(timestamp), sc: 1, prevChapter: false, st: style ? 1 : 0
    };
    const query = Object.keys(params).sort().map((key) => `${key}=${encodeURIComponent(String(params[key]))}`).join("&");
    params.s = signQuery(query);
    return params;
  }

  private webHeaders(session: WebSession, extra: Record<string, string>): Record<string, string> {
    return { Accept: "application/json, text/plain, */*", "User-Agent": session.userAgent, Cookie: session.cookie,
      Origin: session.origin, Referer: session.referer, "X-Requested-With": "XMLHttpRequest", ...(session.protectedHeaders || {}), ...extra };
  }

  private isAccessDenied(error: unknown): boolean {
    return error instanceof Error && /章节不可读|无权限|HTTP\s+(401|403)/i.test(error.message);
  }

  private assertCurrentGeneration(generation: number): void {
    if (generation !== this.dataGeneration) throw new Error("操作已取消，登录信息已清除");
  }

  private async updateCookies(session: WebSession, headers: NodeJS.Dict<string | string[]>, generation: number): Promise<void> {
    this.assertCurrentGeneration(generation);
    const additions = headers["set-cookie"];
    if (!additions) return;
    const values = new Map<string, string>();
    for (const part of session.cookie.split(";")) {
      const index = part.indexOf("="); if (index > 0) values.set(part.slice(0, index).trim(), part.slice(index + 1));
    }
    for (const item of typeof additions === "string" ? [additions] : additions) {
      const pair = item.split(";", 1)[0]; const index = pair.indexOf("="); if (index > 0) values.set(pair.slice(0, index), pair.slice(index + 1));
    }
    session.cookie = [...values].map(([name, value]) => `${name}=${value}`).join("; ");
    this.assertCurrentGeneration(generation);
    await this.setSession(session);
    if (generation !== this.dataGeneration) {
      await this.secrets.delete(SECRET_SESSION);
      this.assertCurrentGeneration(generation);
    }
  }

  private request(method: string, requestUrl: string, headers: Record<string, string>, body?: string, redirectCount = 0): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const request = https.request(requestUrl, { method, headers, timeout: 15_000 }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const statusCode = response.statusCode || 0;
          const location = response.headers.location;
          if (location && statusCode >= 300 && statusCode < 400 && redirectCount < 5) {
            const redirected = new URL(location, requestUrl).toString();
            const nextMethod = statusCode === 303 ? "GET" : method;
            void this.request(nextMethod, redirected, headers, nextMethod === "GET" ? undefined : body, redirectCount + 1).then(resolve, reject);
            return;
          }
          resolve({ statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      request.on("timeout", () => request.destroy(new Error("微信读书请求超时")));
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }
}
