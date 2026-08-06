export interface Book {
  bookId: string;
  title: string;
  author: string;
  cover?: string;
}

export interface BookshelfPage {
  items: Book[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface Chapter {
  chapterUid: number;
  sourceId?: string;
  chapterIdx: number;
  title: string;
  wordCount: number;
  paid?: number;
  price?: number;
}

export interface FanqieSession {
  cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None" }>;
  userAgent: string;
  isVip?: boolean;
  readerUrl?: string;
  readerAccessVerified?: boolean;
  storageState?: {
    cookies: FanqieSession["cookies"];
    origins: Array<{
      origin: string;
      localStorage: Array<{ name: string; value: string }>;
      indexedDB?: Array<unknown>;
    }>;
  };
  sessionStorage?: Array<{ name: string; value: string }>;
}

export interface WebSession {
  cookie: string;
  userAgent: string;
  referer: string;
  origin: string;
  protectedHeaders?: Record<string, string>;
}

export interface ReaderState {
  psvts: string;
  pclts: string;
  token: string;
}

export interface HttpResponse {
  statusCode: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

export interface ReadingClient {
  getBookshelf(): Promise<Book[]>;
  getBookshelfPage?(cursor?: string, limit?: number, force?: boolean): Promise<BookshelfPage>;
  syncBookshelf?(): Promise<Book[]>;
  getChapters(bookId: string, force?: boolean): Promise<Chapter[]>;
  getProgress(bookId: string): Promise<{ chapterUid?: number; chapterOffset?: number; progress?: number }>;
  getChapterText(bookId: string, chapter: Chapter, force?: boolean): Promise<string>;
  prefetchChapters?(bookId: string, chapters: Chapter[]): Promise<void>;
  publishProgress?(update: { bookId: string; chapterUid: number; fragmentIndex: number }): void;
  onProgress?(listener: (update: { bookId: string; chapterUid: number; fragmentIndex: number }) => void): { dispose(): void };
  clear(): Promise<void>;
}
