const identStart = /[A-Za-z_$]/;
const identPart = /[A-Za-z0-9_$]/;

export function parseJsonish(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;

  function skipComment(j: number): number {
    if (text[j + 1] === "/") {
      j += 2;
      while (j < n && text[j] !== "\n") j++;
      return j;
    }
    j += 2;
    while (j < n && (text[j] !== "*" || text[j + 1] !== "/")) j++;
    return j + 2;
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
          const next = text[i + 1];
          if (next === "'") { out += "'"; i += 2; continue; }
          if (next === "\n") { i += 2; continue; }
          out += c;
          if (i + 1 < n) { out += next; i += 2; } else { i++; }
          continue;
        }
        if (c === '"') { out += '\\"'; i++; continue; }
        if (c === "'") { out += '"'; i++; break; }
        out += c;
        i++;
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
      if (next === "}" || next === "]") {
        i++;
        continue;
      }
      out += ch;
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
