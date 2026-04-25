/**
 * Minimal JSON5/JSONC-tolerant parser. Strips line/block comments and
 * trailing commas, then defers to JSON.parse. Covers JSONC fully and the
 * common subset of JSON5 used in the wild; does not support unquoted keys
 * or single-quoted strings.
 */
export function parseJsonish(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = text[i];
        out += c;
        i++;
        if (c === "\\" && i < n) {
          out += text[i];
          i++;
          continue;
        }
        if (c === '"') break;
      }
      continue;
    }

    if (ch === "/" && i + 1 < n && text[i + 1] === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && i + 1 < n && text[i + 1] === "*") {
      i += 2;
      while (i < n && (text[i] !== "*" || text[i + 1] !== "/")) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  out = out.replace(/,(\s*[}\]])/g, "$1");

  return JSON.parse(out);
}
