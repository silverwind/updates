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
  let pendingComma = -1; // index in `out` of a comma that becomes trailing if the next token closes a container

  while (i < n) {
    const ch = text[i];

    if (ch === '"') {
      pendingComma = -1;
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

    // Strip trailing commas in a single pass so commas inside string values are left untouched.
    if (ch === ",") {
      pendingComma = out.length;
      out += ch;
      i++;
      continue;
    }

    if (ch === "}" || ch === "]") {
      if (pendingComma >= 0) out = out.slice(0, pendingComma) + out.slice(pendingComma + 1);
      pendingComma = -1;
      out += ch;
      i++;
      continue;
    }

    if (!/\s/.test(ch)) pendingComma = -1;
    out += ch;
    i++;
  }

  return JSON.parse(out);
}
