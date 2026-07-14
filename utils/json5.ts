/**
 * Minimal JSON5/JSONC-tolerant parser. Strips line/block comments and trailing
 * commas, converts single-quoted strings and unquoted identifier keys to their
 * JSON equivalents, then defers to JSON.parse. Covers JSONC fully and the common
 * subset of JSON5 used in the wild; does not support exotic escapes (\x, \0),
 * hex/Infinity/NaN literals, or line continuations inside single-quoted strings.
 */
const identStart = /[A-Za-z_$]/;
const identPart = /[A-Za-z0-9_$]/;

export function parseJsonish(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;
  let pendingComma = -1; // index in `out` of a comma that becomes trailing if the next token closes a container

  // Skip whitespace and comments starting at index j, returning the next significant index.
  function skipTrivia(j: number): number {
    while (j < n) {
      if (/\s/.test(text[j])) { j++; continue; }
      if (text[j] === "/" && text[j + 1] === "/") {
        j += 2;
        while (j < n && text[j] !== "\n") j++;
        continue;
      }
      if (text[j] === "/" && text[j + 1] === "*") {
        j += 2;
        while (j < n && (text[j] !== "*" || text[j + 1] !== "/")) j++;
        j += 2;
        continue;
      }
      break;
    }
    return j;
  }

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

    // Single-quoted string: re-emit as a double-quoted JSON string.
    if (ch === "'") {
      pendingComma = -1;
      out += '"';
      i++;
      while (i < n) {
        const c = text[i];
        if (c === "\\") {
          const next = text[i + 1];
          if (next === "'") { out += "'"; i += 2; continue; } // \' -> '
          if (next === "\n") { i += 2; continue; } // line continuation, drop
          out += c;
          if (i + 1 < n) { out += next; i += 2; } else { i++; }
          continue;
        }
        if (c === '"') { out += '\\"'; i++; continue; } // escape embedded double quote
        if (c === "'") { out += '"'; i++; break; } // closing quote
        out += c;
        i++;
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

    // Unquoted identifier: a key if followed by ':', otherwise a literal (true/false/null).
    if (identStart.test(ch)) {
      pendingComma = -1;
      let ident = "";
      while (i < n && identPart.test(text[i])) { ident += text[i]; i++; }
      out += text[skipTrivia(i)] === ":" ? JSON.stringify(ident) : ident;
      continue;
    }

    if (!/\s/.test(ch)) pendingComma = -1;
    out += ch;
    i++;
  }

  return JSON.parse(out);
}
