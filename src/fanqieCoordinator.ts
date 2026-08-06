import * as fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import * as net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FanqieClient } from "./fanqieClient";
import type { Book, BookshelfPage, Chapter, FanqieSession, ReadingClient } from "./types";

type Method = "setSession" | "clear" | "getBookshelf" | "getBookshelfPage" | "syncBookshelf" | "getChapters" | "getProgress" | "getChapterText" | "prefetchChapters" | "publishProgress";
type Message = { id: string; method: Method; args: unknown[] };

export class SharedFanqieClient implements ReadingClient {
  private server?: net.Server;
  private master = false;
  private disposed = false;
  private readonly endpoint: string;
  private readonly lockDirectory: string;
  private readonly progressFile: string;
  private readonly progressEvents = new EventEmitter();
  private progressWatcher?: FSWatcher;

  constructor(private readonly local: FanqieClient, private readonly storagePath: string) {
    const key = createHash("sha256").update(storagePath).digest("hex").slice(0, 24);
    this.endpoint = process.platform === "win32" ? `\\\\.\\pipe\\vscode-reading-fanqie-${key}` : join(tmpdir(), `vrh-fq-${key}.sock`);
    this.lockDirectory = join(storagePath, "fanqie-master.lock");
    this.progressFile = join(storagePath, "fanqie-progress.json");
    void this.startProgressWatcher();
  }

  async setSession(value: FanqieSession): Promise<void> { await this.call("setSession", [value]); }
  async getSession(): Promise<FanqieSession | undefined> { return this.local.getSession(); }
  async clear(): Promise<void> { await this.call("clear", []); }
  async getBookshelf(): Promise<Book[]> { return this.call("getBookshelf", []); }
  async getBookshelfPage(cursor?: string, limit?: number, force?: boolean): Promise<BookshelfPage> { return this.call("getBookshelfPage", [cursor, limit, force]); }
  async syncBookshelf(): Promise<Book[]> { return this.call("syncBookshelf", []); }
  async getChapters(bookId: string, force?: boolean): Promise<Chapter[]> { return this.call("getChapters", [bookId, force]); }
  async getProgress(bookId: string): Promise<{}> { return this.call("getProgress", [bookId]); }
  async getChapterText(bookId: string, chapter: Chapter, force?: boolean): Promise<string> { return this.call("getChapterText", [bookId, chapter, force]); }
  async prefetchChapters(bookId: string, chapters: Chapter[]): Promise<void> { await this.call("prefetchChapters", [bookId, chapters]); }
  publishProgress(update: { bookId: string; chapterUid: number; fragmentIndex: number }): void { void this.call("publishProgress", [update]).catch(() => undefined); }
  onProgress(listener: (update: { bookId: string; chapterUid: number; fragmentIndex: number }) => void): { dispose(): void } {
    this.progressEvents.on("progress", listener);
    return { dispose: () => this.progressEvents.off("progress", listener) };
  }

  dispose(): void {
    this.disposed = true;
    if (this.server) { void this.server.close(); this.server = undefined; }
    this.progressWatcher?.close();
    if (this.master && process.platform !== "win32") void fs.unlink(this.endpoint).catch(() => undefined);
    if (this.master) void fs.rmdir(this.lockDirectory).catch(() => undefined);
    this.master = false;
    this.local.dispose();
  }

  private async call<T>(method: Method, args: unknown[]): Promise<T> {
    if (this.disposed) throw new Error("阅读服务正在关闭");
    if (await this.becomeMasterIfNeeded()) return this.invokeLocal<T>(method, args);
    try { return await this.request<T>(method, args); }
    catch { if (await this.becomeMasterIfNeeded()) return this.invokeLocal<T>(method, args); throw new Error("番茄阅读主窗口暂时不可用，请稍后重试"); }
  }

  private async invokeLocal<T>(method: Method, args: unknown[]): Promise<T> {
    if (method === "publishProgress") {
      await fs.writeFile(this.progressFile, JSON.stringify(args[0]), "utf8");
      return undefined as T;
    }
    const target = this.local as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>;
    return await target[method](...args) as T;
  }

  private async startProgressWatcher(): Promise<void> {
    await fs.mkdir(this.storagePath, { recursive: true });
    if (this.disposed || this.progressWatcher) return;
    this.progressWatcher = watch(this.storagePath, (_event, filename) => {
      if (filename !== "fanqie-progress.json") return;
      void fs.readFile(this.progressFile, "utf8").then((raw) => {
        const update = JSON.parse(raw) as { bookId: string; chapterUid: number; fragmentIndex: number };
        if (update.bookId && update.chapterUid) this.progressEvents.emit("progress", update);
      }).catch(() => undefined);
    });
  }

  private async becomeMasterIfNeeded(): Promise<boolean> {
    if (this.master) return true;
    if (await this.serverAvailable()) return false;
    await fs.mkdir(this.storagePath, { recursive: true });
    try {
      await fs.mkdir(this.lockDirectory);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (await this.serverAvailable()) return false;
      await fs.rm(this.lockDirectory, { recursive: true, force: true }).catch(() => undefined);
      await fs.mkdir(this.lockDirectory).catch(() => undefined);
    }
    if (await this.serverAvailable()) return false;
    await this.startServer();
    this.master = true;
    return true;
  }

  private async serverAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection(this.endpoint);
      const done = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      setTimeout(() => done(false), 250).unref();
    });
  }

  private async startServer(): Promise<void> {
    if (process.platform !== "win32") await fs.unlink(this.endpoint).catch(() => undefined);
    this.server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const raw = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          void this.handle(JSON.parse(raw) as Message, socket);
        }
      });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.endpoint, () => resolve()); });
    if (process.platform !== "win32") await fs.chmod(this.endpoint, 0o600).catch(() => undefined);
  }

  private async handle(message: Message, socket: net.Socket): Promise<void> {
    try {
      const result = await this.invokeLocal(message.method, message.args);
      socket.write(JSON.stringify({ id: message.id, ok: true, result }) + "\n");
    } catch (error) {
      socket.write(JSON.stringify({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
    }
  }

  private request<T>(method: Method, args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random()}`;
      const socket = net.createConnection(this.endpoint);
      let buffer = "";
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("IPC timeout")); }, 120_000);
      socket.on("connect", () => socket.write(JSON.stringify({ id, method, args } satisfies Message) + "\n"));
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer); socket.destroy();
        const response = JSON.parse(buffer.slice(0, newline)) as { id: string; ok: boolean; result?: T; error?: string };
        response.ok ? resolve(response.result as T) : reject(new Error(response.error || "IPC error"));
      });
      socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
  }
}
