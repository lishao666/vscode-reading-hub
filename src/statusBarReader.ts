import * as vscode from "vscode";
import type { Book, Chapter } from "./types";
import { WeReadClient } from "./wereadClient";
import { splitForStatusBar } from "./statusText";

export class StatusBarReader implements vscode.Disposable {
  private static readonly lastBookKey = "vscodeWeread.lastBookId";
  private static lastChapterKey(bookId: string): string { return `vscodeWeread.lastChapterUid.${bookId}`; }
  private static lastFragmentKey(bookId: string, chapterUid: number): string {
    return `vscodeWeread.lastFragmentIndex.${bookId}.${chapterUid}`;
  }
  // VS Code only supports left/right status bar alignment. Low priorities place
  // the reader after built-in workspace/source-control/problem items, which is
  // visually much closer to the center instead of occupying the first slot.
  private readonly previousChapterItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2);
  private readonly previousItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  private readonly nextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
  private readonly nextChapterItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
  private book?: Book;
  private chapters: Chapter[] = [];
  private chapterIndex = 0;
  private fragments: string[] = [];
  private fragmentIndex = 0;
  private reading = false;
  private visible = false;

  constructor(private readonly client: WeReadClient, private readonly state: vscode.Memento) {
    this.item.name = "微信读书正文";
    this.applyConfiguration();
    this.previousChapterItem.name = "微信读书上一章";
    this.previousChapterItem.text = "«";
    this.previousChapterItem.tooltip = "上一章";
    this.previousChapterItem.command = "vscodeWeread.previousChapter";
    this.previousItem.name = "微信读书上一页";
    this.previousItem.text = "‹";
    this.previousItem.tooltip = "上一页";
    this.previousItem.command = "vscodeWeread.previous";
    this.nextItem.name = "微信读书下一页";
    this.nextItem.text = "›";
    this.nextItem.tooltip = "下一页";
    this.nextItem.command = "vscodeWeread.next";
    this.nextChapterItem.name = "微信读书下一章";
    this.nextChapterItem.text = "»";
    this.nextChapterItem.tooltip = "下一章";
    this.nextChapterItem.command = "vscodeWeread.nextChapter";
  }

  async start(): Promise<void> {
    const books = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "正在读取微信读书书架…" }, () => this.client.getBookshelf());
    const lastBookId = this.state.get<string>(StatusBarReader.lastBookKey);
    const lastBook = lastBookId ? books.find((book) => book.bookId === lastBookId) : undefined;
    if (lastBook) {
      await this.openBook(lastBook);
      return;
    }
    await this.pickBook(books);
  }

  async selectBook(): Promise<void> {
    const books = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "正在读取微信读书书架…" }, () => this.client.getBookshelf());
    await this.pickBook(books);
  }

  async selectChapter(): Promise<void> {
    if (!this.book) {
      const books = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "正在读取微信读书书架…" }, () => this.client.getBookshelf());
      const lastBookId = this.state.get<string>(StatusBarReader.lastBookKey);
      const lastBook = lastBookId ? books.find((book) => book.bookId === lastBookId) : undefined;
      if (!lastBook) {
        vscode.window.showInformationMessage("请先使用“微信读书：开始阅读”或“微信读书：书架”。");
        return;
      }
      await this.prepareBook(lastBook);
      const savedChapterUid = this.state.get<number>(StatusBarReader.lastChapterKey(lastBook.bookId));
      const savedChapterIndex = savedChapterUid
        ? this.chapters.findIndex((chapter) => chapter.chapterUid === savedChapterUid)
        : -1;
      if (savedChapterIndex >= 0) this.chapterIndex = savedChapterIndex;
    }
    const items = this.chapters.map((chapter, index) => ({
      label: chapter.title,
      description: index === this.chapterIndex ? "当前章节" : undefined,
      index
    }));
    const selected = await this.showPositionedQuickPick(items, this.chapterIndex, `选择《${this.book!.title}》的章节`);
    if (!selected) return;
    await this.loadChapter(selected.index);
  }

  private async pickBook(books: Book[]): Promise<void> {
    const currentBookId = this.book?.bookId || this.state.get<string>(StatusBarReader.lastBookKey);
    const items = books.map((book) => ({
      label: book.title,
      description: book.bookId === currentBookId ? `当前书籍 · ${book.author}` : book.author,
      book
    }));
    const currentIndex = currentBookId ? books.findIndex((book) => book.bookId === currentBookId) : -1;
    const selected = await this.showPositionedQuickPick(items, currentIndex, "选择底栏要阅读的书籍");
    if (!selected) return;
    await this.openBook(selected.book);
  }

  private showPositionedQuickPick<T extends vscode.QuickPickItem>(items: T[], activeIndex: number, placeHolder: string): Promise<T | undefined> {
    return new Promise((resolve) => {
      const picker = vscode.window.createQuickPick<T>();
      picker.items = items;
      picker.placeholder = placeHolder;
      picker.matchOnDescription = true;
      if (activeIndex >= 0 && activeIndex < items.length) picker.activeItems = [items[activeIndex]];
      let accepted = false;
      picker.onDidAccept(() => {
        accepted = true;
        const selected = picker.selectedItems[0] || picker.activeItems[0];
        picker.hide();
        resolve(selected);
      });
      picker.onDidHide(() => {
        picker.dispose();
        if (!accepted) resolve(undefined);
      });
      picker.show();
    });
  }

  private async openBook(book: Book): Promise<void> {
    const previousState = {
      book: this.book, chapters: this.chapters, chapterIndex: this.chapterIndex,
      fragments: this.fragments, fragmentIndex: this.fragmentIndex, reading: this.reading
    };
    try {
      await this.prepareBook(book);
      const lastChapterUid = this.state.get<number>(StatusBarReader.lastChapterKey(book.bookId));
      const savedIndex = lastChapterUid ? this.chapters.findIndex((chapter) => chapter.chapterUid === lastChapterUid) : -1;
      const progress = savedIndex < 0 ? await this.client.getProgress(book.bookId).catch(() => ({} as { chapterUid?: number })) : {};
      const progressIndex = progress.chapterUid ? this.chapters.findIndex((chapter) => chapter.chapterUid === Number(progress.chapterUid)) : -1;
      this.chapterIndex = savedIndex >= 0 ? savedIndex : progressIndex >= 0 ? progressIndex : 0;
      const chapter = this.chapters[this.chapterIndex];
      const savedFragment = savedIndex >= 0
        ? this.state.get<number>(StatusBarReader.lastFragmentKey(book.bookId, chapter.chapterUid), 0)
        : 0;
      await this.loadChapter(this.chapterIndex, false, false, savedFragment);
    } catch (error) {
      Object.assign(this, previousState);
      if (this.reading && this.fragments.length) this.render();
      else this.hideItems();
      throw error;
    }
  }

  private async prepareBook(book: Book): Promise<void> {
    this.book = book;
    this.chapters = await this.client.getChapters(this.book.bookId);
    if (!this.chapters.length) throw new Error("这本书没有可读取章节");
  }

  async next(): Promise<void> {
    if (!this.reading) return this.start();
    if (this.fragmentIndex < this.fragments.length - 1) {
      this.fragmentIndex++;
      this.render();
    } else {
      await this.loadChapter(this.chapterIndex + 1);
    }
  }

  async previous(): Promise<void> {
    if (!this.reading) return this.start();
    if (this.fragmentIndex > 0) {
      this.fragmentIndex--;
      this.render();
    } else {
      await this.loadChapter(this.chapterIndex - 1, true);
    }
  }

  async nextChapter(): Promise<void> { await this.loadChapter(this.chapterIndex + 1); }
  async previousChapter(): Promise<void> { await this.loadChapter(this.chapterIndex - 1, true); }

  async refresh(): Promise<void> {
    if (!this.reading || !this.book) return this.start();
    await this.loadChapter(this.chapterIndex, false, true, this.fragmentIndex);
  }

  toggleVisibility(): void {
    if (!this.reading) return;
    if (this.visible) this.hideItems();
    else this.showItems();
  }

  async clearHistory(): Promise<void> {
    await Promise.all(this.state.keys()
      .filter((key) => key === StatusBarReader.lastBookKey || key.startsWith("vscodeWeread.lastChapterUid.") || key.startsWith("vscodeWeread.lastFragmentIndex."))
      .map((key) => this.state.update(key, undefined)));
  }

  refreshConfiguration(): void {
    this.applyConfiguration();
    if (this.reading && this.visible) this.showItems();
  }

  dispose(): void {
    this.previousChapterItem.dispose();
    this.previousItem.dispose();
    this.item.dispose();
    this.nextItem.dispose();
    this.nextChapterItem.dispose();
  }

  private async loadChapter(index: number, goToEnd = false, force = false, preferredFragment?: number): Promise<void> {
    if (!this.book || index < 0 || index >= this.chapters.length) return;
    const chapter = this.chapters[index];
    const previousChapterIndex = this.chapterIndex;
    const previousFragments = this.fragments;
    const previousFragmentIndex = this.fragmentIndex;
    this.item.text = `$(loading~spin) ${this.book.title} · ${chapter.title}`;
    this.showItems();
    let text: string;
    try {
      text = await this.client.getChapterText(this.book.bookId, chapter, force);
    } catch (error) {
      this.chapterIndex = previousChapterIndex;
      this.fragments = previousFragments;
      this.fragmentIndex = previousFragmentIndex;
      if (this.reading && this.fragments.length) this.render();
      else this.hideItems();
      throw error;
    }
    this.chapterIndex = index;
    this.fragments = splitForStatusBar(text, vscode.workspace.getConfiguration("vscodeWeread").get("statusBarMaxLength", 50));
    if (!this.fragments.length) throw new Error("章节正文为空，可能没有阅读权限或登录态已失效");
    this.fragmentIndex = preferredFragment === undefined
      ? (goToEnd ? this.fragments.length - 1 : 0)
      : Math.min(preferredFragment, this.fragments.length - 1);
    this.reading = true;
    await this.state.update(StatusBarReader.lastBookKey, this.book.bookId);
    await this.state.update(StatusBarReader.lastChapterKey(this.book.bookId), chapter.chapterUid);
    await vscode.commands.executeCommand("setContext", "vscodeWeread.readerStarted", true);
    this.render();
  }

  private render(): void {
    if (!this.book) return;
    const chapter = this.chapters[this.chapterIndex];
    const content = this.fragments[this.fragmentIndex] || "";
    this.item.text = content.replace(/\$/g, "\\$");
    this.item.tooltip = `${this.book.title}\n${chapter.title}\n${this.fragmentIndex + 1} / ${this.fragments.length}\n\n点击进入下一页`;
    this.item.accessibilityInformation = { label: `${this.book.title}，${chapter.title}，${content}` };
    void this.state.update(StatusBarReader.lastFragmentKey(this.book.bookId, chapter.chapterUid), this.fragmentIndex);
    this.showItems();
  }

  private showItems(): void {
    const showControls = vscode.workspace.getConfiguration("vscodeWeread").get("showControlButtons", false);
    if (showControls) {
      this.previousChapterItem.show();
      this.previousItem.show();
    } else {
      this.previousChapterItem.hide();
      this.previousItem.hide();
    }
    this.item.show();
    if (showControls) {
      this.nextItem.show();
      this.nextChapterItem.show();
    } else {
      this.nextItem.hide();
      this.nextChapterItem.hide();
    }
    this.visible = true;
    void vscode.commands.executeCommand("setContext", "vscodeWeread.readerVisible", true);
  }

  private hideItems(): void {
    this.previousChapterItem.hide();
    this.previousItem.hide();
    this.item.hide();
    this.nextItem.hide();
    this.nextChapterItem.hide();
    this.visible = false;
    void vscode.commands.executeCommand("setContext", "vscodeWeread.readerVisible", false);
  }

  private applyConfiguration(): void {
    const clickable = vscode.workspace.getConfiguration("vscodeWeread").get("clickContentToNext", false);
    this.item.command = clickable ? "vscodeWeread.next" : undefined;
  }
}
