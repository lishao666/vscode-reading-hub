import type { WebSession } from "./types";

const DEFAULT_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

function header(input: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return input.match(new RegExp(`-H\\s+'${escaped}:\\s*([^']+)'`, "i"))?.[1]?.trim()
    || input.match(new RegExp(`-H\\s+"${escaped}:\\s*([^"]+)"`, "i"))?.[1]?.trim()
    || "";
}

export function parseSession(input: string): WebSession | undefined {
  const normalized = input.replace(/\\\r?\n/g, " ").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  const cookie = normalized.match(/(?:-b|--cookie)\s+'([^']+)'/i)?.[1]
    || normalized.match(/(?:-b|--cookie)\s+"([^"]+)"/i)?.[1]
    || header(normalized, "cookie")
    || (normalized.toLowerCase().startsWith("cookie:") ? normalized.replace(/^cookie:\s*/i, "") : "")
    || (/^[^\s=;]+=[^\s]+/.test(normalized) ? normalized : "");
  if (!cookie) return undefined;
  const protectedHeaders: Record<string, string> = {};
  for (const match of normalized.matchAll(/-H\s+'(x-wrpa-\d+):\s*([^']+)'/gi)) {
    protectedHeaders[match[1].toLowerCase()] = match[2].trim();
  }
  for (const match of normalized.matchAll(/-H\s+"(x-wrpa-\d+):\s*([^"]+)"/gi)) {
    protectedHeaders[match[1].toLowerCase()] = match[2].trim();
  }
  return {
    cookie: cookie.split(";").map((part) => part.trim()).filter((part) => part.includes("=")).join("; "),
    userAgent: header(normalized, "user-agent") || DEFAULT_AGENT,
    referer: header(normalized, "referer") || "https://weread.qq.com/",
    origin: header(normalized, "origin") || "https://weread.qq.com",
    protectedHeaders
  };
}
