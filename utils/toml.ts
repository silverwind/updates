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
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;

    // Table header
    const tableMatch = /^\[([^\]]+)\]$/.exec(line);
    if (tableMatch) {
      current = root;
      for (const key of splitDottedKey(tableMatch[1])) {
        if (!(key in current) || typeof current[key] !== "object" || Array.isArray(current[key])) {
          current[key] = {};
        }
        current = current[key];
      }
      continue;
    }

    // Key = value
    const eqIdx = findEquals(line);
    if (eqIdx < 0) continue;
    const rawKey = line.slice(0, eqIdx).trim();
    const rawVal = line.slice(eqIdx + 1).trim();
    const keys = splitDottedKey(rawKey);
    let target = current;
    for (let k = 0; k < keys.length - 1; k++) {
      if (!(keys[k] in target) || typeof target[keys[k]] !== "object" || Array.isArray(target[keys[k]])) {
        target[keys[k]] = {};
      }
      target = target[keys[k]] as TomlObject;
    }
    const finalKey = keys[keys.length - 1];

    // Multi-line array
    if (rawVal.startsWith("[") && !rawVal.includes("]")) {
      const items: Array<TomlValue> = [];
      parseArrayItems(rawVal.slice(1), items);
      for (let j = i + 1; j < lines.length; j++) {
        const aLine = lines[j].replace(/#.*$/, "").trim();
        if (!aLine) continue;
        if (aLine.includes("]")) {
          parseArrayItems(aLine.replace(/].*$/, ""), items);
          i = j;
          break;
        }
        parseArrayItems(aLine, items);
      }
      target[finalKey] = items;
    } else {
      target[finalKey] = parseValue(rawVal);
    }
  }

  return root;
}

function parseArrayItems(segment: string, items: Array<TomlValue>): void {
  const trimmed = segment.trim();
  if (!trimmed) return;
  // Extract string items from comma-separated segment
  const re = /"""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:[^"\\]|\\.)*)"|'([^']*)'|([^,\s\]]+)/g;
  let m;
  while ((m = re.exec(trimmed))) {
    const val = m[1] ?? m[2] ?? (m[3] !== undefined ? unescapeString(m[3]) : undefined) ?? m[4] ?? m[5];
    if (val !== undefined && val !== "") {
      items.push(inferScalar(val));
    }
  }
}

function parseValue(raw: string): TomlValue {
  if (raw.startsWith("[")) {
    const items: Array<TomlValue> = [];
    parseArrayItems(raw.slice(1, raw.lastIndexOf("]")), items);
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
  if (/^[+-]?\d+$/.test(raw)) return Number(raw);
  if (/^[+-]?\d+\.\d+$/.test(raw)) return Number(raw);
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

function findEquals(line: string): number {
  let inQuote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === "\\" && inQuote === '"') { i++; continue; }
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === "=") {
      return i;
    }
  }
  return -1;
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
