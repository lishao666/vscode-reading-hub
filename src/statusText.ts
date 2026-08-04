export function splitForStatusBar(text: string, maxLength: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^。！？!?；;…]+[。！？!?；;…]*/g) || [normalized];
  const result: string[] = [];
  for (const sentence of sentences) {
    let remaining = sentence.trim();
    while (remaining.length > maxLength) {
      const search = remaining.slice(0, maxLength + 1);
      const positions = [search.lastIndexOf("，"), search.lastIndexOf(","), search.lastIndexOf("、"), search.lastIndexOf("："), search.lastIndexOf(":"), search.lastIndexOf(" ")];
      const breakpoint = Math.max(...positions, Math.floor(maxLength * 0.6));
      result.push(remaining.slice(0, breakpoint + 1).trim());
      remaining = remaining.slice(breakpoint + 1).trim();
    }
    if (remaining) result.push(remaining);
  }
  return result;
}
