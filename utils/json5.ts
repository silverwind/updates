const identStart = /[A-Za-z_$]/;
const identPart = /[A-Za-z0-9_$]/;

export function parseJsonish(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;

  function skipComment(j: number): number {
    if (text[j + 1] === "/") {
      j += 2;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      return j;
    }
    const end = text.indexOf("*/", j + 2);
    if (end === -1) throw new SyntaxError("Unterminated block comment");
    return end + 2;
  }

  function skipTrivia(j: number): number {
    while (j < n) {
      if (/\s/.test(text[j])) { j++; continue; }
      if (text[j] === "/" && (text[j + 1] === "/" || text[j + 1] === "*")) { j = skipComment(j); continue; }
      break;
    }
    return j;
  }

  while (i < n) {
    const ch = text[i];

    if (ch === '"') {
      const start = i++;
      while (i < n) {
        const c = text[i++];
        if (c === "\\") i++;
        else if (c === '"') break;
      }
      out += text.slice(start, i);
      continue;
    }

    if (ch === "'") {
      out += '"';
      i++;
      while (i < n) {
        const c = text[i];
        if (c === "\\") {
          if (text[i + 1] === "'") out += "'";
          else if (text[i + 1] !== "\n") out += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        i++;
        if (c === "'") { out += '"'; break; }
        out += c === '"' ? '\\"' : c;
      }
      continue;
    }

    if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      i = skipComment(i);
      out += " ";
      continue;
    }

    if (ch === ",") {
      const next = text[skipTrivia(i + 1)];
      if (next !== "}" && next !== "]") out += ch;
      i++;
      continue;
    }

    if (identStart.test(ch)) {
      const start = i;
      while (i < n && identPart.test(text[i])) i++;
      const ident = text.slice(start, i);
      out += text[skipTrivia(i)] === ":" ? `"${ident}"` : ident;
      continue;
    }

    out += ch;
    i++;
  }

  return JSON.parse(out);
}
