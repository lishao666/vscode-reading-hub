export interface Book {
  bookId: string;
  title: string;
  author: string;
  cover?: string;
}

export interface Chapter {
  chapterUid: number;
  chapterIdx: number;
  title: string;
  wordCount: number;
  paid?: number;
  price?: number;
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
