import {assignmentValues} from "./make.ts";

export function isShellFileName(filename: string): boolean {
  return filename.endsWith(".sh");
}

const shellAssignRe = /^\s*(?:(?:export|readonly|local|declare|typeset)\s+(?:-\w+\s+)*)*[A-Za-z_]\w*=\(?((?:.*[^\s;)])?)[\s;)]*$/;
const defaultExpansionRe = /^\$\{\w+:?[-=](.*)\}$/;

export function shellAssignmentValues(content: string): Array<string> {
  return assignmentValues(content, shellAssignRe, defaultExpansionRe);
}
