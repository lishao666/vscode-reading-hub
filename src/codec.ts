import { createHash } from "node:crypto";

export function encodeWeReadValue(value: string | number): string {
  const input = String(value);
  const md5 = createHash("md5").update(input, "utf8").digest("hex");
  const chunks: string[] = [];
  let type = "4";
  if (/^\d+$/.test(input)) {
    type = "3";
    for (let i = 0; i < input.length; i += 9) {
      chunks.push(Number.parseInt(input.slice(i, i + 9), 10).toString(16));
    }
  } else {
    chunks.push([...input].map((character) => character.charCodeAt(0).toString(16)).join(""));
  }

  let result = `${md5.slice(0, 3)}${type}2${md5.slice(-2)}`;
  result += chunks.map((chunk) => `${chunk.length.toString(16).padStart(2, "0")}${chunk}`).join("g");
  if (result.length < 20) {
    result += md5.slice(0, 20 - result.length);
  }
  return result + createHash("md5").update(result, "utf8").digest("hex").slice(0, 3);
}

export function signQuery(query: string): string {
  let left = 0x15051505;
  let right = left;
  for (let i = query.length - 1; i > 0; i -= 2) {
    left = (left ^ (query.charCodeAt(i) << ((query.length - i) % 30))) & 0x7fffffff;
    right = (right ^ (query.charCodeAt(i - 1) << (i % 30))) & 0x7fffffff;
  }
  return (left + right).toString(16).toLowerCase();
}

function checkedShardBody(response: string): string {
  if (response.length <= 32) return "";
  const expected = response.slice(0, 32);
  const body = response.slice(32);
  const actual = createHash("md5").update(body, "utf8").digest("hex").toUpperCase();
  if (actual !== expected) throw new Error("微信读书正文分片校验失败");
  return body;
}

function swapPositions(payload: string): number[] {
  if (payload.length < 4) return [];
  if (payload.length < 11) return [0, 2];
  const count = Math.min(4, Math.floor((payload.length + 9) / 10));
  let seed = "";
  for (let i = payload.length - 1; i >= payload.length - count; i--) {
    seed += Number.parseInt(payload.charCodeAt(i).toString(2), 4).toString();
  }
  const limit = payload.length - count - 2;
  const step = String(limit).length;
  const result: number[] = [];
  for (let index = 0; result.length < 10 && index + step < seed.length; index += step) {
    result.push(Number.parseInt(seed.slice(index, index + step), 10) % limit);
    result.push(Number.parseInt(seed.slice(index + 1, index + 1 + step), 10) % limit);
  }
  return result;
}

function decodePayload(payload: string): string {
  if (!payload) return "";
  const characters = payload.slice(1).split("");
  const positions = swapPositions(characters.join(""));
  for (let i = positions.length - 1; i > 0; i -= 2) {
    for (let offset = 1; offset >= 0; offset--) {
      const left = positions[i] + offset;
      const right = positions[i - 1] + offset;
      [characters[left], characters[right]] = [characters[right], characters[left]];
    }
  }
  const base64 = characters.join("").replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
  const binary = Buffer.from(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="), "base64").toString("latin1");
  return repairMixedUtf8(binary);
}

/**
 * WeRead chapter shards can contain a mixture of raw single-byte characters
 * and UTF-8 byte sequences. Buffer.toString("utf8") replaces the raw bytes
 * with U+FFFD. Decode valid sequences manually and retain unmatched bytes.
 */
export function repairMixedUtf8(binary: string): string {
  let result = "";
  for (let index = 0; index < binary.length;) {
    const first = binary.charCodeAt(index);
    const second = index + 1 < binary.length ? binary.charCodeAt(index + 1) : -1;
    const third = index + 2 < binary.length ? binary.charCodeAt(index + 2) : -1;
    const fourth = index + 3 < binary.length ? binary.charCodeAt(index + 3) : -1;

    if (first >= 0xc0 && first <= 0xdf && isContinuation(second)) {
      result += String.fromCharCode(((first & 0x1f) << 6) | (second & 0x3f));
      index += 2;
      continue;
    }
    if (first >= 0xe0 && first <= 0xef && isContinuation(second) && isContinuation(third)) {
      result += String.fromCharCode(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f));
      index += 3;
      continue;
    }
    if (first >= 0xf0 && first <= 0xf4 && isContinuation(second) && isContinuation(third) && isContinuation(fourth)) {
      const codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      result += String.fromCodePoint(codePoint);
      index += 4;
      continue;
    }
    result += binary.charAt(index);
    index++;
  }
  return result;
}

function isContinuation(value: number): boolean {
  return value >= 0x80 && value <= 0xbf;
}

export function decodeContentShards(...responses: string[]): string {
  return decodePayload(responses.map(checkedShardBody).join(""));
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#8217;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function normalizeText(text: string): string {
  return text.replace(/\r/g, "").replace(/[\t　]/g, " ").replace(/[ ]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
