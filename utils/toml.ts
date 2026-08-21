type TomlValue = string | number | boolean | Array<TomlValue> | TomlObject;
type TomlObject = {[key: string]: TomlValue};

const arrayTableRe = /^\[\[([^\]]+)\]\]$/;
const tableRe = /^\[([^[\]]+)\]$/;

const emptyTable = (): TomlObject => Object.create(null);

export function parseToml(input: string): TomlObject {
  const root = emptyTable();
  let current = root;
  const lines = input.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (!line) continue;

    const arrayTableMatch = arrayTableRe.exec(line);
    if (arrayTableMatch) {
      let target: TomlObject = root;
      const keys = splitDottedKey(arrayTableMatch[1]);
      for (let k = 0; k < keys.length - 1; k++) {
        const existing = target[keys[k]];
        if (Array.isArray(existing)) {
          target = existing[existing.length - 1] as TomlObject;
        } else {
          if (!existing || typeof existing !== "object") target[keys[k]] = emptyTable();
          target = target[keys[k]] as TomlObject;
        }
      }
      const lastKey = keys[keys.length - 1];
      if (!Array.isArray(target[lastKey])) target[lastKey] = [];
      const newTable = emptyTable();
      (target[lastKey]).push(newTable);
      current = newTable;
      continue;
    }

    const tableMatch = tableRe.exec(line);
    if (tableMatch) {
      current = descend(root, splitDottedKey(tableMatch[1]));
      continue;
    }

    const eqIdx = unquotedIndex(line, "=");
    if (eqIdx < 0) continue;
    const rawKey = line.slice(0, eqIdx).trim();
    const rawVal = line.slice(eqIdx + 1).trim();
    const keys = splitDottedKey(rawKey);
    const target = descend(current, keys.slice(0, -1));
    const finalKey = keys[keys.length - 1];
    const mlDelim = ['"""', "'''"].find(delimiter =>
      rawVal.startsWith(delimiter) && !rawVal.includes(delimiter, 3)) ?? "";

    if ((rawVal.startsWith("[") || rawVal.startsWith("{")) && !inlineTableClosed(rawVal)) {
      let body = rawVal;
      let j = i + 1;
      for (; j < lines.length; j++) {
        body += `\n${stripComment(lines[j])}`;
        if (inlineTableClosed(body)) break;
      }
      i = j;
      target[finalKey] = parseValue(body);
    } else if (mlDelim) {
      let body = rawVal.slice(3);
      let j = i + 1;
      for (; j < lines.length; j++) {
        const closeIdx = lines[j].indexOf(mlDelim);
        if (closeIdx >= 0) {
          body += (body ? "\n" : "") + lines[j].slice(0, closeIdx);
          break;
        }
        body += (body ? "\n" : "") + lines[j];
      }
      i = j;
      target[finalKey] = parseValue(mlDelim + body + mlDelim);
    } else {
      target[finalKey] = parseValue(rawVal);
    }
  }

  return root;
}

function parseValue(raw: string): TomlValue {
  if (raw.startsWith("[")) {
    const items: Array<TomlValue> = [];
    const closeIdx = raw.lastIndexOf("]");
    for (const part of splitTopLevel(raw.slice(1, closeIdx < 0 ? raw.length : closeIdx))) {
      const clean = part.trim();
      if (clean) items.push(parseValue(clean));
    }
    return items;
  }
  if (raw.startsWith("{")) {
    return parseInlineTable(raw);
  }
  if (raw.startsWith('"""')) {
    return unescapeString(raw.slice(3, raw.lastIndexOf('"""')));
  }
  if (raw.startsWith("'''")) {
    return raw.slice(3, raw.lastIndexOf("'''"));
  }
  if (raw.startsWith('"')) {
    return unescapeString(raw.slice(1, raw.lastIndexOf('"')));
  }
  if (raw.startsWith("'")) {
    return raw.slice(1, raw.lastIndexOf("'"));
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function parseInlineTable(raw: string): TomlObject {
  const obj = emptyTable();
  const inner = raw.slice(1, raw.lastIndexOf("}")).trim();
  if (!inner) return obj;
  for (const part of splitTopLevel(inner)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    obj[key] = parseValue(part.slice(eq + 1).trim());
  }
  return obj;
}

function scanValue(s: string, split: boolean): Array<string> | null {
  const parts: Array<string> = [];
  let depth = 0;
  let inStr: string | null = null;
  let start = 0;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (inStr) {
      if (ch === "\\" && inStr === '"') { k++; continue; }
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (!split && depth === 0) return parts;
    } else if (split && ch === "," && depth === 0) {
      parts.push(s.slice(start, k));
      start = k + 1;
    }
  }
  if (!split) return null;
  if (start < s.length) parts.push(s.slice(start));
  return parts;
}

function inlineTableClosed(s: string): boolean {
  return scanValue(s, false) !== null;
}

function splitTopLevel(s: string): Array<string> {
  return scanValue(s, true)!;
}

function splitDottedKey(key: string): Array<string> {
  const keys: Array<string> = [];
  let current = "";
  let inQuote: string | null = null;
  for (const ch of key) {
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; continue; }
      current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ".") {
      keys.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) keys.push(current.trim());
  return keys;
}

function stripComment(line: string): string {
  const index = unquotedIndex(line, "#");
  return index < 0 ? line : line.slice(0, index);
}

function unquotedIndex(s: string, target: string): number {
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\" && inStr === '"') { i++; continue; }
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === target) {
      return i;
    }
  }
  return -1;
}

function descend(target: TomlObject, keys: Array<string>): TomlObject {
  for (const key of keys) {
    if (!(key in target) || typeof target[key] !== "object" || Array.isArray(target[key])) {
      target[key] = emptyTable();
    }
    target = target[key];
  }
  return target;
}

function unescapeString(s: string): string {
  return s.replace(/\\(["\\bfnrt]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/g, (_, c) => {
    switch (c[0]) {
      case '"': return '"';
      case "\\": return "\\";
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "u": case "U": return String.fromCodePoint(Number.parseInt(c.slice(1), 16));
      default: return c;
    }
  });
}
