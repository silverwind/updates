// Minimal TOML parser for pyproject.toml files.
// Supports: tables, dotted keys, basic strings, literal strings,
// arrays of strings, booleans, integers, floats, inline tables.

type TomlValue = string | number | boolean | Array<TomlValue> | TomlObject;
type TomlObject = {[key: string]: TomlValue};

export function parseToml(input: string): TomlObject {
  const root: TomlObject = {};
  let current = root;
  const lines = input.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (!line) continue;

    // Array of tables: [[name]]
    const arrayTableMatch = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (arrayTableMatch) {
      let target: TomlObject = root;
      const keys = splitDottedKey(arrayTableMatch[1]);
      for (let k = 0; k < keys.length - 1; k++) {
        const existing = target[keys[k]];
        if (Array.isArray(existing)) {
          target = existing[existing.length - 1] as TomlObject;
        } else {
          if (!existing || typeof existing !== "object") target[keys[k]] = {};
          target = target[keys[k]] as TomlObject;
        }
      }
      const lastKey = keys[keys.length - 1];
      if (!Array.isArray(target[lastKey])) target[lastKey] = [];
      const newTable: TomlObject = {};
      (target[lastKey]).push(newTable);
      current = newTable;
      continue;
    }

    // Table header
    const tableMatch = /^\[([^[\]]+)\]$/.exec(line);
    if (tableMatch) {
      current = descend(root, splitDottedKey(tableMatch[1]));
      continue;
    }

    // Key = value
    const eqIdx = indexOfUnquoted(line, "=");
    if (eqIdx < 0) continue;
    const rawKey = line.slice(0, eqIdx).trim();
    const rawVal = line.slice(eqIdx + 1).trim();
    const keys = splitDottedKey(rawKey);
    const target = descend(current, keys.slice(0, -1));
    const finalKey = keys[keys.length - 1];
    const mlDelim = multilineStringDelim(rawVal);

    // Multi-line array: gather lines until the outer array's closing "]" (depth-aware), then
    // parse the full text with parseValue so nested arrays and inline tables stay intact.
    if (rawVal.startsWith("[") && !inlineTableClosed(rawVal)) {
      let body = rawVal;
      let j = i + 1;
      for (; j < lines.length; j++) {
        body += `\n${stripComment(lines[j])}`;
        if (inlineTableClosed(body)) break;
      }
      i = j;
      target[finalKey] = parseValue(body);
    } else if (rawVal.startsWith("{") && !inlineTableClosed(rawVal)) {
      // Multi-line inline table: gather lines until the table's closing brace.
      let body = rawVal;
      let j = i + 1;
      for (; j < lines.length; j++) {
        body += `\n${stripComment(lines[j])}`;
        if (inlineTableClosed(body)) break;
      }
      i = j;
      target[finalKey] = parseInlineTable(body);
    } else if (mlDelim) {
      // Multi-line basic/literal string: gather raw lines up to the closing delimiter, then
      // re-wrap and hand to parseValue so escaping/literal handling stays in one place.
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

function parseArrayItems(segment: string, items: Array<TomlValue>): void {
  const trimmed = segment.trim();
  if (!trimmed) return;
  for (const part of splitTopLevel(trimmed)) {
    const clean = part.trim();
    if (!clean) continue;
    items.push(parseValue(clean));
  }
}

// Returns the opening delimiter if raw starts a multi-line string that does not close on the same line, else "".
function multilineStringDelim(raw: string): string {
  const delim = raw.slice(0, 3);
  if (delim !== '"""' && delim !== "'''") return "";
  return raw.includes(delim, 3) ? "" : delim;
}

function parseValue(raw: string): TomlValue {
  if (raw.startsWith("[")) {
    const items: Array<TomlValue> = [];
    const closeIdx = lastIndexOfUnquoted(raw, "]");
    parseArrayItems(raw.slice(1, closeIdx < 0 ? raw.length : closeIdx), items);
    return items;
  }
  if (raw.startsWith("{")) {
    return parseInlineTable(raw);
  }
  // Multi-line basic string
  if (raw.startsWith('"""')) {
    return unescapeString(raw.slice(3, raw.lastIndexOf('"""')));
  }
  // Multi-line literal string
  if (raw.startsWith("'''")) {
    return raw.slice(3, raw.lastIndexOf("'''"));
  }
  if (raw.startsWith('"')) {
    return unescapeString(raw.slice(1, raw.lastIndexOf('"')));
  }
  if (raw.startsWith("'")) {
    return raw.slice(1, raw.lastIndexOf("'"));
  }
  return inferScalar(raw);
}

function inferScalar(raw: string): TomlValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function parseInlineTable(raw: string): TomlObject {
  const obj: TomlObject = {};
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

// True once the brackets/braces in `s` balance out — i.e. the inline table that opened with "{" has closed.
function inlineTableClosed(s: string): boolean {
  let depth = 0;
  let inStr: string | null = null;
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
      if (depth === 0) return true;
    }
  }
  return false;
}

function splitTopLevel(s: string): Array<string> {
  const parts: Array<string> = [];
  let depth = 0;
  let inStr: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\" && inStr === '"') { i++; continue; }
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (start < s.length) parts.push(s.slice(start));
  return parts;
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
  const idx = indexOfUnquoted(line, "#");
  return idx < 0 ? line : line.slice(0, idx);
}

function* unquotedIndices(s: string, target: string): Generator<number> {
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\" && inStr === '"') { i++; continue; }
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === target) {
      yield i;
    }
  }
}

function indexOfUnquoted(s: string, target: string): number {
  return unquotedIndices(s, target).next().value ?? -1;
}

function lastIndexOfUnquoted(s: string, target: string): number {
  let last = -1;
  for (const i of unquotedIndices(s, target)) last = i;
  return last;
}

function descend(target: TomlObject, keys: Array<string>): TomlObject {
  for (const key of keys) {
    if (!(key in target) || typeof target[key] !== "object" || Array.isArray(target[key])) {
      target[key] = {};
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
