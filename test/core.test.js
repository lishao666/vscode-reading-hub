const test = require("node:test");
const assert = require("node:assert/strict");
const { encodeWeReadValue, htmlToText, normalizeText, repairMixedUtf8, signQuery } = require("../dist/codec.js");
const { parseSession } = require("../dist/session.js");
const { splitForStatusBar } = require("../dist/statusText.js");

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
  const session = parseSession("curl 'https://weread.qq.com/web/book/read' -H 'cookie: wr_vid=1; wr_skey=abc' -H 'user-agent: Test Agent' -H 'x-wrpa-0: signed-value'");
  assert.equal(session.cookie, "wr_vid=1; wr_skey=abc");
  assert.equal(session.userAgent, "Test Agent");
  assert.equal(session.protectedHeaders["x-wrpa-0"], "signed-value");
});

test("splits long content for the VS Code status bar", () => {
  const fragments = splitForStatusBar("这是第一句话。这是一句非常长的内容，需要在合适的位置进行切分，避免状态栏显示得太长。", 20);
  assert.ok(fragments.length >= 3);
  assert.ok(fragments.every((fragment) => fragment.length <= 21));
});
