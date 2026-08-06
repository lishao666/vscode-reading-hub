const test = require("node:test");
const assert = require("node:assert/strict");
const { encodeWeReadValue, htmlToText, normalizeText, repairMixedUtf8, signQuery } = require("../dist/codec.js");
const { parseSession } = require("../dist/session.js");
const { splitForStatusBar } = require("../dist/statusText.js");
const opentype = require("opentype.js");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { SharedFanqieClient } = require("../dist/fanqieCoordinator.js");
const { applyFanqieCharacterMapping, applyFingerprintMappings, containsPrivateUseCharacters, decodeFanqieDynamicFont, extractBookIds, extractBooks, extractChapters, extractChapterContent, glyphFingerprints, hasFirstFanqieChapter, isRecoverablePageFailure, learnFanqieCharacterMapping, nativeOcrCommand, parseFanqieJson, sortFanqieChapters, supportsNativeOcr } = require("../dist/fanqieClient.js");

test("encodes WeRead identifiers deterministically", () => {
  assert.equal(encodeWeReadValue("123456"), encodeWeReadValue("123456"));
  assert.match(encodeWeReadValue("123456"), /^[a-f0-9g]+$/);
  assert.notEqual(encodeWeReadValue("123456"), encodeWeReadValue("123457"));
});

test("signs sorted query deterministically", () => {
  assert.equal(signQuery("a=1&b=2"), signQuery("a=1&b=2"));
  assert.match(signQuery("a=1&b=2"), /^[a-f0-9]+$/);
});

test("extracts readable text from chapter html", () => {
  assert.equal(normalizeText(htmlToText("<p>第一段</p><p>第二段 &amp; 内容</p>")), "第一段\n 第二段 & 内容");
});

test("repairs mixed UTF-8 bytes without replacement characters", () => {
  const source = "朝夕阅读𠮷";
  const binary = Buffer.from(source, "utf8").toString("latin1");
  assert.equal(repairMixedUtf8(binary), source);
  assert.equal(repairMixedUtf8("A\x80B"), "A\x80B");
});

test("parses a copied curl session", () => {
  const session = parseSession("curl 'https://weread.qq.com/web/book/read' -H 'cookie: mock_a=1; mock_b=example' -H 'user-agent: Test Agent' -H 'x-wrpa-0: mock-signature'");
  assert.equal(session.cookie, "mock_a=1; mock_b=example");
  assert.equal(session.userAgent, "Test Agent");
  assert.equal(session.protectedHeaders["x-wrpa-0"], "mock-signature");
});

test("splits long content for the VS Code status bar", () => {
  const fragments = splitForStatusBar("这是第一句话。这是一句非常长的内容，需要在合适的位置进行切分，避免状态栏显示得太长。", 20);
  assert.ok(fragments.length >= 3);
  assert.ok(fragments.every((fragment) => fragment.length <= 21));
});

test("detects Fanqie private-use font characters", () => {
  assert.equal(containsPrivateUseCharacters("正常中文正文"), false);
  assert.equal(containsPrivateUseCharacters("正文\ue450混淆"), true);
});

test("decodes Fanqie private-use characters from loaded font metadata", () => {
  const path = new opentype.Path();
  const glyph = new opentype.Glyph({ name: "uni4E2D", unicode: 0xe450, advanceWidth: 500, path });
  glyph.addUnicode(0x4e2d);
  const font = new opentype.Font({ familyName: "FanqieTest", styleName: "Regular", unitsPerEm: 1000, ascender: 800, descender: -200, glyphs: [new opentype.Glyph({ name: ".notdef", advanceWidth: 500, path: new opentype.Path() }), glyph] });
  const body = Buffer.from(font.toArrayBuffer());
  assert.equal(decodeFanqieDynamicFont("正\ue450文", [body]), "正中文");
});

test("learns and reuses Fanqie OCR character mappings", () => {
  const mapping = {};
  learnFanqieCharacterMapping("\ue49c城\ue423\ue421", "金城大学", mapping);
  assert.deepEqual(mapping, { e49c: "金", e423: "大", e421: "学" });
  assert.equal(applyFanqieCharacterMapping("\ue49c城\ue423\ue421", mapping), "金城大学");
});

test("reuses Fanqie glyph knowledge when a font changes its PUA code", async () => {
  const path = new opentype.Path();
  path.moveTo(10, 20); path.lineTo(200, 700); path.close();
  const makeFont = (code) => new opentype.Font({ familyName: "FanqieFingerprint", styleName: "Regular", unitsPerEm: 1000, ascender: 800, descender: -200, glyphs: [
    new opentype.Glyph({ name: ".notdef", advanceWidth: 500, path: new opentype.Path() }),
    new opentype.Glyph({ name: `uni${code.toString(16)}`, unicode: code, advanceWidth: 500, path })
  ] });
  const first = await glyphFingerprints([Buffer.from(makeFont(0xe401).toArrayBuffer())]);
  const second = await glyphFingerprints([Buffer.from(makeFont(0xe499).toArrayBuffer())]);
  assert.equal(first.e401, second.e499);
  const mapping = {};
  applyFingerprintMappings(mapping, second, { [first.e401]: "金" });
  assert.deepEqual(mapping, { e499: "金" });
});

test("only retries recoverable Fanqie work-page failures", () => {
  assert.equal(isRecoverablePageFailure(new Error("Page crashed")), true);
  assert.equal(isRecoverablePageFailure(new Error("Execution context was destroyed")), true);
  assert.equal(isRecoverablePageFailure(new Error("HTTP 403")), false);
});

test("selects invisible native OCR helpers on macOS and Windows", () => {
  assert.equal(supportsNativeOcr("darwin"), true);
  assert.equal(supportsNativeOcr("win32"), true);
  assert.equal(supportsNativeOcr("linux"), false);
  assert.match(nativeOcrCommand("/extension", "/images", "darwin").command, /fanqie-vision-ocr$/);
  const windows = nativeOcrCommand("C:\\extension", "C:\\images", "win32");
  assert.equal(windows.command, "powershell.exe");
  assert.ok(windows.args.includes("-NonInteractive"));
  assert.ok(windows.args.includes("-ExecutionPolicy"));
});

test("preserves Fanqie 19 digit identifiers", () => {
  const payload = parseFanqieJson('{"data":{"book_id_str":7638538561230228504,"itemId":7638538670122730008}}');
  assert.equal(payload.data.book_id_str, "7638538561230228504");
  assert.equal(payload.data.itemId, "7638538670122730008");
});

test("normalizes Fanqie bookshelf and directory payloads", () => {
  const payload = { data: { book_list: [{ book_id_str: "7638538561230228504", book_title: "测试书籍", author_name: "作者" }], item_list: [{ item_id_str: "7638538670122730008", title: "第1章", word_count: 2256 }] } };
  assert.deepEqual(extractBooks(payload), [{ bookId: "7638538561230228504", title: "测试书籍", author: "作者" }]);
  assert.deepEqual(extractChapters(payload), [{ sourceId: "7638538670122730008", title: "第1章", wordCount: 2256 }]);
});

test("extracts every chapter from Fanqie page chapterListWithVolume", () => {
  const payload = { page: { chapterTotal: 3, chapterListWithVolume: [[
    { itemId: "7638538670122730008", title: "第1章 开始" },
    { itemId: "7638538820715037208", title: "第2章 后续" },
    { itemId: "7638538948209295896", title: "第3章 结束" }
  ]] } };
  assert.deepEqual(extractChapters(payload).map((chapter) => chapter.title), ["第1章 开始", "第2章 后续", "第3章 结束"]);
});

test("extracts the complete Fanqie simple-book-info response", () => {
  const payload = { data: { book_info: [
    { book_id: "7638538561230228504", book_name: "第一本", author_name: "作者甲" },
    { book_id: "7638538561230228505", book_name: "第二本", author_name: "作者乙" }
  ] } };
  assert.deepEqual(extractBooks(payload).map((book) => book.title), ["第一本", "第二本"]);
});

test("collects Fanqie book ids nested inside bookshelf groups", () => {
  const payload = { data: { book_shelf_info: [{ group_id: "g1", children: [
    { book_id: "7638538561230228504" }, { book_id: "7638538561230228505" }
  ] }] } };
  assert.deepEqual(extractBookIds(payload), ["7638538561230228504", "7638538561230228505"]);
});

test("sorts Fanqie directory by chapter number and removes summary entries", () => {
  const chapters = sortFanqieChapters([
    { sourceId: "3", title: "最近更新：第3章" },
    { sourceId: "2", title: "第2章 第二章" },
    { sourceId: "1", title: "第1章 第一章" }
  ]);
  assert.deepEqual(chapters.map((chapter) => chapter.sourceId), ["1", "2"]);
});

test("keeps duplicate Fanqie chapter numbers and unnumbered prologues", () => {
  const chapters = sortFanqieChapters([
    { sourceId: "0", title: "序章" },
    { sourceId: "1", title: "第83章 第一条" },
    { sourceId: "2", title: "第83章 第二条" },
    { sourceId: "3", title: "第84章 后续" }
  ]);
  assert.deepEqual(chapters.map((chapter) => chapter.sourceId), ["0", "1", "2", "3"]);
});

test("rejects a Fanqie directory cache that starts after chapter one", () => {
  assert.equal(hasFirstFanqieChapter([{ title: "第1章 开始" }, { title: "第2章 后续" }]), true);
  assert.equal(hasFirstFanqieChapter([{ title: "第7章 当前章节" }, { title: "第8章 后续" }]), false);
});

test("prefers real Fanqie chapter entries over shared-id summary cards", () => {
  const chapters = extractChapters({ data: [
    { item_id_str: "7638538670122730008", title: "继续阅读" },
    { item_id_str: "7638538670122730008", title: "第1章 第一章" }
  ] });
  assert.equal(chapters[0].title, "第1章 第一章");
});

test("deduplicates Fanqie books from API and virtual shelf cards", () => {
  const books = extractBooks({ data: [
    { book_id_str: "7638538561230228504", book_title: "测试书籍" },
    { book_id_str: "7638538561230228504", book_title: "测试书籍" }
  ] });
  assert.equal(books.length, 1);
});

test("keeps local Fanqie shelf locators distinct from 19 digit ids", () => {
  const title = "嘉豪就变强？操场雨中舞剑开天门";
  const locator = `shelf:${encodeURIComponent(title)}`;
  assert.ok(locator.startsWith("shelf:"));
  assert.equal(decodeURIComponent(locator.slice(6)), title);
});

test("extracts the longest Fanqie chapter content", () => {
  const result = extractChapterContent({ data: { chapter: { content: "<p>第一段</p><p>第二段正文</p>", chapterWordNumber: 8, isChapterLock: false } } });
  assert.equal(result.text, "第一段\n第二段正文");
  assert.equal(result.wordCount, 8);
  assert.equal(result.locked, false);
});

test("routes multiple Fanqie window clients through one IPC master", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fanqie-ipc-test-"));
  let firstCalls = 0;
  let secondCalls = 0;
  const fake = (items, count) => ({
    getBookshelf: async () => { count(); return items; },
    getBookshelfPage: async () => ({ items, hasMore: false }), getChapters: async () => [], getProgress: async () => ({}),
    getChapterText: async () => "正文", prefetchChapters: async () => undefined, setSession: async () => undefined,
    getSession: async () => undefined, clear: async () => undefined, dispose: () => undefined
  });
  const first = new SharedFanqieClient(fake([{ bookId: "1", title: "主窗口", author: "" }], () => firstCalls++), directory);
  const second = new SharedFanqieClient(fake([{ bookId: "2", title: "从窗口", author: "" }], () => secondCalls++), directory);
  try {
    assert.equal((await first.getBookshelf())[0].title, "主窗口");
    assert.equal((await second.getBookshelf())[0].title, "主窗口");
    assert.equal(firstCalls, 2);
    assert.equal(secondCalls, 0);
    first.dispose();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await second.getBookshelf())[0].title, "从窗口");
    assert.equal(secondCalls, 1);
  } finally {
    first.dispose(); second.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
