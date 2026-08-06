import * as vscode from "vscode";
import type { Book, BookshelfPage, Chapter, ReadingClient } from "./types";
import { splitForStatusBar } from "./statusText";

export class StatusBarReader implements vscode.Disposable {
  private lastBookKey(): string { return `vscodeReading.lastBookId.${this.providerId}`; }
  private lastBookDetailsKey(): string { return `vscodeReading.lastBook.${this.providerId}`; }
  private lastChapterKey(bookId: string): string { return `vscodeReading.lastChapterUid.${this.providerId}.${bookId}`; }
  private lastFragmentKey(bookId: string, chapterUid: number): string {
    return `vscodeReading.lastFragmentIndex.${this.providerId}.${bookId}.${chapterUid}`;
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
  private progressSubscription?: { dispose(): void };
  private bookshelfSync?: Promise<void>;

  constructor(private client: ReadingClient, private providerId: string, private readonly state: vscode.Memento) {
    this.item.name = "阅读正文";
    this.applyConfiguration();
    this.previousChapterItem.name = "阅读上一章";
    this.previousChapterItem.text = "«";
    this.previousChapterItem.tooltip = "上一章";
    this.previousChapterItem.command = "vscodeReading.previousChapter";
    this.previousItem.name = "阅读上一页";
    this.previousItem.text = "‹";
    this.previousItem.tooltip = "上一页";
    this.previousItem.command = "vscodeReading.previous";
    this.nextItem.name = "阅读下一页";
    this.nextItem.text = "›";
    this.nextItem.tooltip = "下一页";
    this.nextItem.command = "vscodeReading.next";
    this.nextChapterItem.name = "阅读下一章";
    this.nextChapterItem.text = "»";
    this.nextChapterItem.tooltip = "下一章";
    this.nextChapterItem.command = "vscodeReading.nextChapter";
    this.bindProgressSync();
  }

  async setClient(client: ReadingClient, providerId: string): Promise<void> {
    this.hideItems();
    this.progressSubscription?.dispose();
    this.client = client;
    this.providerId = providerId;
    this.book = undefined;
    this.chapters = [];
    this.fragments = [];
    this.chapterIndex = 0;
    this.fragmentIndex = 0;
    this.reading = false;
    this.bindProgressSync();
    await vscode.commands.executeCommand("setContext", "vscodeReading.readerStarted", false);
  }

  async start(): Promise<void> {
    const cachedBook = this.state.get<Book>(this.lastBookDetailsKey());
    if (cachedBook?.bookId && cachedBook.title) {
      await this.openBook(cachedBook);
      void this.syncBookshelfCacheInBackground();
      return;
    }
    await this.pickBook();
  }

  async selectBook(): Promise<void> {
    await this.pickBook();
  }

  async selectChapter(): Promise<void> {
    if (!this.book) {
      const cachedBook = this.state.get<Book>(this.lastBookDetailsKey());
      if (cachedBook?.bookId && cachedBook.title) {
        await this.prepareBook(cachedBook);
        const savedChapterUid = this.state.get<number>(this.lastChapterKey(cachedBook.bookId));
        const savedChapterIndex = savedChapterUid ? this.chapters.findIndex((chapter) => chapter.chapterUid === savedChapterUid) : -1;
        if (savedChapterIndex >= 0) this.chapterIndex = savedChapterIndex;
      }
    }
    if (!this.book) {
      const books = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `正在读取${this.providerName()}书架…` }, () => this.client.getBookshelf());
      const lastBookId = this.state.get<string>(this.lastBookKey());
      const lastBook = lastBookId ? books.find((book) => book.bookId === lastBookId) : undefined;
      if (!lastBook) {
        vscode.window.showInformationMessage("请先使用“阅读：开始阅读”或“阅读：书架”。");
        return;
      }
      await this.prepareBook(lastBook);
      const savedChapterUid = this.state.get<number>(this.lastChapterKey(lastBook.bookId));
      const savedChapterIndex = savedChapterUid
        ? this.chapters.findIndex((chapter) => chapter.chapterUid === savedChapterUid)
        : -1;
      if (savedChapterIndex >= 0) this.chapterIndex = savedChapterIndex;
    }
    type ChapterPickItem = vscode.QuickPickItem & { index?: number; refresh?: boolean };
    const items: ChapterPickItem[] = this.chapters.map((chapter, index) => ({
      label: chapter.title,
      description: index === this.chapterIndex ? "当前章节" : undefined,
      index
    }));
    items.push({ label: "$(refresh) 刷新章节目录", description: "从阅读服务重新获取最新目录", alwaysShow: true, refresh: true });
    const selected = await this.showPositionedQuickPick(items, this.chapterIndex, `《${this.book!.title}》目录`);
    if (!selected) return;
    if (selected.refresh) {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "正在刷新章节目录…" }, () => this.prepareBook(this.book!, true));
      await this.selectChapter();
      return;
    }
    if (selected.index !== undefined) await this.loadChapter(selected.index);
  }

  private async pickBook(initialBooks?: Book[], initialPage?: BookshelfPage): Promise<void> {
    const allCacheKey = `vscodeReading.bookshelfAll.v1.${this.providerId}`;
    let completeBooks = this.state.get<Book[]>(allCacheKey);
    if (!completeBooks?.length && this.client.syncBookshelf && !initialBooks && !initialPage) {
      completeBooks = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `正在获取${this.providerName()}完整书架…` }, () => this.client.syncBookshelf!());
      if (completeBooks.length) await this.cacheCompleteBookshelf(completeBooks);
    }
    let page: BookshelfPage = completeBooks?.length
      ? { items: completeBooks, hasMore: false }
      : initialPage || (initialBooks ? { items: initialBooks, hasMore: false } : await this.loadBookshelfPage());
    const currentBookId = this.book?.bookId || this.state.get<string>(this.lastBookKey());
    const books: Book[] = [...page.items];
    type BookPickItem = vscode.QuickPickItem & { book?: Book; loadMore?: boolean; refresh?: boolean };
    const picker = vscode.window.createQuickPick<BookPickItem>();
    let cursor = page.nextCursor;
    let loading = false;
    let backgroundSyncing = false;
    let pickerClosed = false;
    const update = (loadLabel?: string, keepBottom = false) => {
      const items: BookPickItem[] = books.map((book) => ({ label: book.title, description: book.bookId === currentBookId ? `当前书籍 · ${book.author}` : book.author, book }));
      items.push(page.hasMore
        ? { label: loadLabel || "$(add) 加载更多", description: backgroundSyncing ? "后台正在同步完整书架，也可以立即加载下一批" : "继续读取下一批书籍", alwaysShow: true, loadMore: true }
        : { label: "$(check) 没有更多了", description: `共加载 ${books.length} 本`, alwaysShow: true });
      if (backgroundSyncing) items.push({ label: "$(sync~spin) 正在后台同步完整书架…", description: "正文和目录请求会优先处理", alwaysShow: true });
      items.push({ label: "$(refresh) 刷新书架", description: "从阅读服务重新获取书架", alwaysShow: true, refresh: true });
      picker.items = items;
      if (keepBottom) {
        const target = items.find((item) => item.loadMore) || items.find((item) => !item.book && !item.refresh);
        if (target) picker.activeItems = [target];
      }
    };
    const startBackgroundSync = (): void => {
      const completeKey = `vscodeReading.bookshelfComplete.v4.${this.providerId}`;
      if (!this.client.syncBookshelf || !page.hasMore || backgroundSyncing || this.state.get<boolean>(completeKey, false)) return;
      backgroundSyncing = true;
      update();
      void this.client.syncBookshelf().then(async (synced) => {
        if (!synced.length) return;
        for (const book of synced) if (!books.some((existing) => existing.bookId === book.bookId)) books.push(book);
        page = { items: books.slice(0, 20), hasMore: false };
        cursor = undefined;
        await this.cacheCompleteBookshelf(books);
      }).catch(() => undefined).finally(() => {
        backgroundSyncing = false;
        if (!pickerClosed) update();
      });
    };
    update();
    if (currentBookId) {
      const index = books.findIndex((book) => book.bookId === currentBookId);
      if (index >= 0) picker.activeItems = [picker.items[index]];
    }
    picker.placeholder = "选择底栏要阅读的书籍";
    picker.matchOnDescription = true;
    const selected = await new Promise<Book | undefined>((resolve) => {
      let accepted = false;
      let searchGeneration = 0;
      let searchTimer: NodeJS.Timeout | undefined;
      picker.onDidChangeValue((value) => {
        const generation = ++searchGeneration;
        if (searchTimer) clearTimeout(searchTimer);
        if (!value.trim() || !page.hasMore || loading) return;
        searchTimer = setTimeout(() => {
          void (async () => {
            loading = true;
            picker.busy = true;
            try {
              while (page.hasMore && generation === searchGeneration) {
                page = await this.loadBookshelfPage(cursor, false);
                cursor = page.nextCursor;
                for (const book of page.items) if (!books.some((existing) => existing.bookId === book.bookId)) books.push(book);
                update();
                if (books.some((book) => book.title.toLocaleLowerCase().includes(value.trim().toLocaleLowerCase()))) break;
              }
            } finally { picker.busy = false; loading = false; }
          })();
        }, 250);
      });
      picker.onDidAccept(async () => {
        const item = picker.selectedItems[0] || picker.activeItems[0];
        if (item?.refresh && !loading) {
          loading = true;
          picker.busy = true;
          try {
            await Promise.all(this.state.keys()
              .filter((key) => (key.startsWith("vscodeReading.bookshelfPage.") && key.includes(`.${this.providerId}.`)) || (key.startsWith("vscodeReading.bookshelfComplete.") && key.endsWith(`.${this.providerId}`)) || key === `vscodeReading.bookshelfAll.v1.${this.providerId}`)
              .map((key) => this.state.update(key, undefined)));
            page = await this.loadBookshelfPage(undefined, true, true);
            const refreshed = this.client.syncBookshelf ? await this.client.syncBookshelf() : page.items;
            if (refreshed.length) await this.cacheCompleteBookshelf(refreshed);
            page = { items: refreshed, hasMore: false };
            cursor = undefined;
            books.splice(0, books.length, ...refreshed);
            update();
          } finally { picker.busy = false; loading = false; }
          return;
        }
        if (item?.loadMore && !loading) {
          loading = true;
          picker.busy = true;
          update("$(loading~spin) 正在加载更多…", true);
          try {
            page = await this.loadBookshelfPage(cursor);
            cursor = page.nextCursor;
            for (const book of page.items) if (!books.some((existing) => existing.bookId === book.bookId)) books.push(book);
            update(undefined, true);
          } finally { picker.busy = false; loading = false; }
          return;
        }
        if (!item?.book) return;
        accepted = true;
        picker.hide();
        resolve(item.book);
      });
      picker.onDidHide(() => { pickerClosed = true; if (searchTimer) clearTimeout(searchTimer); picker.dispose(); if (!accepted) resolve(undefined); });
      picker.show();
      startBackgroundSync();
    });
    if (selected) await this.openBook(selected);
  }

  private async loadBookshelfPage(cursor?: string, showProgress = true, force = false): Promise<BookshelfPage> {
    const cacheKey = `vscodeReading.bookshelfPage.v4.${this.providerId}.${cursor || "start"}`;
    if (!force) {
      const cached = this.state.get<BookshelfPage>(cacheKey);
      if (cached?.items?.length) return cached;
    }
    const load = async (): Promise<BookshelfPage> => {
      let result: BookshelfPage;
      if (this.client.getBookshelfPage) result = await this.client.getBookshelfPage(cursor, 20, force);
      else {
      const books = await this.client.getBookshelf();
      const offset = Math.max(0, Number(cursor || 0) || 0);
      const items = books.slice(offset, offset + 20);
      const hasMore = offset + items.length < books.length;
        result = { items, hasMore, nextCursor: hasMore ? String(offset + items.length) : undefined };
      }
      await this.state.update(cacheKey, result);
      return result;
    };
    if (!showProgress) return load();
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `正在读取${this.providerName()}书架…` }, load);
  }

  private async cacheCompleteBookshelf(books: Book[]): Promise<void> {
    const writes: Thenable<void>[] = [];
    for (let offset = 0; offset < books.length; offset += 20) {
      const items = books.slice(offset, offset + 20);
      const hasMore = offset + items.length < books.length;
      writes.push(this.state.update(`vscodeReading.bookshelfPage.v4.${this.providerId}.${offset || "start"}`, {
        items, hasMore, nextCursor: hasMore ? String(offset + items.length) : undefined
      } satisfies BookshelfPage));
    }
    writes.push(this.state.update(`vscodeReading.bookshelfComplete.v4.${this.providerId}`, true));
    writes.push(this.state.update(`vscodeReading.bookshelfAll.v1.${this.providerId}`, books));
    await Promise.all(writes);
  }

  private async syncBookshelfCacheInBackground(): Promise<void> {
    if (!this.client.syncBookshelf || this.state.get<Book[]>(`vscodeReading.bookshelfAll.v1.${this.providerId}`)?.length) return;
    if (this.bookshelfSync) return this.bookshelfSync;
    this.bookshelfSync = this.client.syncBookshelf().then(async (books) => {
      if (books.length) await this.cacheCompleteBookshelf(books);
    }).catch(() => undefined).finally(() => { this.bookshelfSync = undefined; });
    return this.bookshelfSync;
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
      this.item.text = `$(loading~spin) 正在加载《${book.title}》书籍内容…`;
      this.item.tooltip = "正在读取目录和正文，请稍候…";
      this.showItems();
      await this.prepareBook(book);
      const lastChapterUid = this.state.get<number>(this.lastChapterKey(book.bookId));
      const savedIndex = lastChapterUid ? this.chapters.findIndex((chapter) => chapter.chapterUid === lastChapterUid) : -1;
      const progress = savedIndex < 0 ? await this.client.getProgress(book.bookId).catch(() => ({} as { chapterUid?: number })) : {};
      const progressIndex = progress.chapterUid ? this.chapters.findIndex((chapter) => chapter.chapterUid === Number(progress.chapterUid)) : -1;
      this.chapterIndex = savedIndex >= 0 ? savedIndex : progressIndex >= 0 ? progressIndex : 0;
      const chapter = this.chapters[this.chapterIndex];
      const savedFragment = savedIndex >= 0
        ? this.state.get<number>(this.lastFragmentKey(book.bookId, chapter.chapterUid), 0)
        : 0;
      await this.loadChapter(this.chapterIndex, false, false, savedFragment);
    } catch (error) {
      Object.assign(this, previousState);
      if (this.reading && this.fragments.length) this.render();
      else this.hideItems();
      throw error;
    }
  }

  private async prepareBook(book: Book, force = false): Promise<void> {
    this.book = book;
    const cacheKey = `vscodeReading.chapters.v4.${this.providerId}.${book.bookId}`;
    const cached = force ? undefined : this.state.get<Chapter[]>(cacheKey);
    this.chapters = cached?.length ? cached : await this.client.getChapters(this.book.bookId, force);
    if (!this.chapters.length) throw new Error("这本书没有可读取章节");
    await this.state.update(cacheKey, this.chapters);
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
      .filter((key) => key.startsWith("vscodeReading.lastBookId.") || key.startsWith("vscodeReading.lastBook.") || key.startsWith("vscodeReading.lastChapterUid.") || key.startsWith("vscodeReading.lastFragmentIndex.") || key.startsWith("vscodeReading.bookshelfPage.") || key.startsWith("vscodeReading.bookshelfComplete.") || key.startsWith("vscodeReading.bookshelfAll.") || key.startsWith("vscodeReading.chapters.") || key.startsWith("vscodeWeread."))
      .map((key) => this.state.update(key, undefined)));
    this.book = undefined;
    this.chapters = [];
    this.fragments = [];
    this.chapterIndex = 0;
    this.fragmentIndex = 0;
    this.reading = false;
    this.hideItems();
    await vscode.commands.executeCommand("setContext", "vscodeReading.readerStarted", false);
  }

  refreshConfiguration(): void {
    this.applyConfiguration();
    if (this.reading && this.visible) this.showItems();
  }

  dispose(): void {
    this.progressSubscription?.dispose();
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
    const displayText = `${chapter.title}\n${text}`;
    this.fragments = splitForStatusBar(displayText, vscode.workspace.getConfiguration("vscodeReading").get("statusBarMaxLength", 50));
    if (!this.fragments.length) throw new Error("章节正文为空");
    this.fragmentIndex = preferredFragment === undefined
      ? (goToEnd ? this.fragments.length - 1 : 0)
      : Math.min(preferredFragment, this.fragments.length - 1);
    this.reading = true;
    await this.state.update(this.lastBookKey(), this.book.bookId);
    await this.state.update(this.lastBookDetailsKey(), this.book);
    await this.state.update(this.lastChapterKey(this.book.bookId), chapter.chapterUid);
    this.client.publishProgress?.({ bookId: this.book.bookId, chapterUid: chapter.chapterUid, fragmentIndex: this.fragmentIndex });
    await vscode.commands.executeCommand("setContext", "vscodeReading.readerStarted", true);
    this.render();
    const upcoming = this.chapters.slice(index + 1, index + 3);
    if (upcoming.length && this.client.prefetchChapters) void this.client.prefetchChapters(this.book.bookId, upcoming);
  }

  private render(): void {
    if (!this.book) return;
    const chapter = this.chapters[this.chapterIndex];
    const content = this.fragments[this.fragmentIndex] || "";
    this.item.text = content.replace(/\$/g, "\\$");
    this.item.tooltip = `${this.book.title}\n${chapter.title}\n${this.fragmentIndex + 1} / ${this.fragments.length}\n\n点击进入下一页`;
    this.item.accessibilityInformation = { label: `${this.book.title}，${chapter.title}，${content}` };
    void this.state.update(this.lastFragmentKey(this.book.bookId, chapter.chapterUid), this.fragmentIndex);
    this.client.publishProgress?.({ bookId: this.book.bookId, chapterUid: chapter.chapterUid, fragmentIndex: this.fragmentIndex });
    this.showItems();
  }

  private showItems(): void {
    const showControls = vscode.workspace.getConfiguration("vscodeReading").get("showControlButtons", false);
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
    void vscode.commands.executeCommand("setContext", "vscodeReading.readerVisible", true);
  }

  private hideItems(): void {
    this.previousChapterItem.hide();
    this.previousItem.hide();
    this.item.hide();
    this.nextItem.hide();
    this.nextChapterItem.hide();
    this.visible = false;
    void vscode.commands.executeCommand("setContext", "vscodeReading.readerVisible", false);
  }

  private providerName(): string {
    return this.providerId === "fanqie" ? "番茄小说" : "微信读书";
  }

  private applyConfiguration(): void {
    const clickable = vscode.workspace.getConfiguration("vscodeReading").get("clickContentToNext", false);
    this.item.command = clickable ? "vscodeReading.next" : undefined;
  }

  private bindProgressSync(): void {
    this.progressSubscription = this.client.onProgress?.((update) => {
      void this.state.update(this.lastChapterKey(update.bookId), update.chapterUid);
      void this.state.update(this.lastFragmentKey(update.bookId, update.chapterUid), update.fragmentIndex);
    });
  }
}
