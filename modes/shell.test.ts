import {parseGoInstalls, parseImages} from "./make.ts";
import {shellAssignmentValues} from "./shell.ts";

const script = [
  `TOOL_PACKAGE="\${TOOL_PACKAGE:-example.com/org/tool/cmd/tool@v1}"`,
  "  export LINTER=example.com/org/linter@v1.2.3;  # linter",
  "declare -r TOOLS=(example.com/org/a@v1.0.0 'example.com/org/b@v2.0.0')  # tools",
  "SPACED = example.com/org/spaced@v1.0.0",
  `readonly APP_IMAGE="\${APP_IMAGE:=org/app:1.0}"`,
  `REMOTE_IMAGE=\${REGISTRY}/org/app:1.0`,
].join("\n");

test("shellAssignmentValues feeds make's parsers, unwrapping arrays and default expansions", () => {
  const values = shellAssignmentValues(script);
  expect(parseGoInstalls(values)).toEqual([
    {installPath: "example.com/org/tool/cmd/tool", version: "v1"},
    {installPath: "example.com/org/linter", version: "v1.2.3"},
    {installPath: "example.com/org/a", version: "v1.0.0"},
    {installPath: "example.com/org/b", version: "v2.0.0"},
  ]);
  expect(parseImages(values).map(image => `${image.writtenImage}:${image.ref.tag}`)).toEqual(["org/app:1.0"]);
});
