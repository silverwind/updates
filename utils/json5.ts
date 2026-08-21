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

    if (ch === "}" || ch === "]") {
      out += ch;
      i++;
      continue;
    }

    if (identStart.test(ch)) {
      let ident = "";
      while (i < n && identPart.test(text[i])) { ident += text[i]; i++; }
      out += text[skipTrivia(i)] === ":" ? JSON.stringify(ident) : ident;
      continue;
    }

    out += ch;
    i++;
  }

  return JSON.parse(out);
}
