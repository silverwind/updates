import {parseDockerTag} from "./docker.ts";
import {makeImageDigestRe, parseGoInstalls, parseMakeImageValue} from "./make.ts";
import {normalizePep503} from "./pypi.ts";
import {isVersionLikeRef} from "./shared.ts";
import {parsePep440} from "../utils/semver.ts";

type Annotation = {line: number, column: number, value: string, fields: Record<string, string>};
type AnnotationEdit = {line: number, column: number, oldValue: string, newValue: string};

export const forgeDatasourceRe: RegExp = /^(github|gitea|forgejo)-(tags|releases)$/;
const datasourceModes = new Map([["npm", "npm"], ["pypi", "pypi"], ["crate", "cargo"], ["go", "go"], ["docker", "docker"]]);
export const annotationMode = (datasource: string): string | undefined => forgeDatasourceRe.test(datasource) ? "actions" : datasourceModes.get(datasource);
const versionings = new Set(["semver", "semver-coerced", "loose", "docker", "pep440"]);
const knownFields = new Set(["datasource", "depName", "packageName", "lookupName", "versioning", "registryUrl", "extractVersion"]);

const markerRe = /(?:renovate|updates):/;
const commentRe = /(["'`])(?:\\.|(?!\1)[^\\])*\1|((?<!\S)#|(?<![:/])\/\/|<!--)(?:\s*(?:renovate|updates):(.*))?/g;
const specRe = /(?:\[[\dA-Fa-f:.]+\](?::\d+)?\/)?[^\s"'`=,;()[\]{}<>]+/g;
const versionRe = /[^\s"'`=,;()[\]{}<>@:-][^\s"'`=,;()[\]{}<>@:]*/g;

export function unsupportedAnnotationField(fields: Record<string, string>): string {
  const {datasource, versioning, registryUrl} = fields;
  const mode = annotationMode(datasource);
  if (!mode) return `datasource=${datasource}`;
  if (versioning && (!versionings.has(versioning) || versioning === "docker" && mode !== "docker")) return `versioning=${versioning}`;
  if (registryUrl && !registryUrl.startsWith("https://")) return `registryUrl=${registryUrl}`; // forge tokens follow the host
  return Object.keys(fields).find(field => !knownFields.has(field) ||
    mode !== "actions" && (field === "registryUrl" || field === "extractVersion")) ?? "";
}

function selectValue(code: string, {datasource, versioning, depName, packageName, lookupName}: Record<string, string>) {
  const name = packageName || lookupName || depName;
  const normalize = datasource === "pypi" ? normalizePep503 : (value: string) => value;
  const matches = (re: RegExp, test: (value: string) => unknown) => code.matchAll(re).filter(match => test(match[0])).toArray();
  const candidates = datasource === "docker" ? matches(specRe, value =>
    parseMakeImageValue(value) || name && parseDockerTag(value.replace(makeImageDigestRe, ""))) : datasource === "go" ?
    matches(specRe, value => parseGoInstalls([{name: "", value}]).length || name && isVersionLikeRef(value)) : name ?
      matches(versionRe, datasource === "pypi" || versioning === "pep440" ? parsePep440 : isVersionLikeRef) : [];
  const named = name ? candidates.filter(match => match[0].startsWith(`${name}@`) || match[0].startsWith(`${name}:`) ||
    normalize(/([^\s"'`=,;()[\]{}<>]+)(?:@|==)$/.exec(code.slice(Math.max(0, match.index - name.length - 3), match.index))?.[1] ?? "") ===
    normalize(name)) : [];
  const selected = named.length ? named : candidates;
  return selected.length === 1 ? selected[0] : undefined;
}

const commentOf = (text: string) => text.matchAll(commentRe).find(match => match[2]);

export function parseAnnotations(content: string): Array<Annotation> {
  const lines = content.split("\n");
  const annotations: Array<Annotation> = [];
  for (const [index, text] of lines.entries()) {
    const comment = markerRe.test(text) ? commentOf(text) : undefined;
    if (!comment?.[3]) continue;
    const fields: Record<string, string> = Object.fromEntries(comment[3].replace(/-->\s*$/, "").trim().split(/\s+/).map(field => {
      const separator = field.indexOf("=");
      return separator === -1 ? [field, ""] : [field.slice(0, separator), field.slice(separator + 1)];
    }));
    if (!fields.datasource) continue;
    let line = index;
    let code = text.slice(0, comment.index);
    if (!code.replace(/^\s*-/, "").trim()) {
      do line++; while (line < lines.length && !lines[line].trim());
      code = line < lines.length ? lines[line].slice(0, commentOf(lines[line])?.index) : "";
    }
    const match = selectValue(code.replaceAll(":-", "  "), fields); // shell `${VAR:-default}`
    if (match) annotations.push({line, column: match.index, value: match[0], fields});
  }
  return annotations;
}

export function updateAnnotatedLines(content: string, edits: Array<AnnotationEdit>): string {
  const lines = content.split("\n");
  for (const {line, column, oldValue, newValue} of edits.toSorted((left, right) => right.column - left.column)) {
    const text = lines[line];
    const end = column + oldValue.length;
    if (!text?.startsWith(oldValue, column) || /[\w.:/+-]/.test(text[end] ?? "")) continue;
    lines[line] = `${text.slice(0, column)}${newValue}${text.slice(end)}`;
  }
  return lines.join("\n");
}
