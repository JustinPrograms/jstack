import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StoryStackError } from "../errors.js";
import { validateMarkdownBody } from "./schema.js";

export function packageRootFromModule(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export async function loadCheckpointTemplate(packageRoot = packageRootFromModule()): Promise<string> {
  const templatePath = path.join(packageRoot, "templates", "context.v1.md");
  try {
    return validateMarkdownBody(await readFile(templatePath, "utf8"));
  } catch (error) {
    if (error instanceof StoryStackError) throw error;
    throw new StoryStackError(`Cannot load checkpoint template at ${templatePath}`, "MISSING_TEMPLATE");
  }
}

export function replaceSection(body: string, heading: string, contents: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const marker = `## ${heading}`;
  const start = lines.findIndex((line) => line === marker);
  if (start < 0) throw new StoryStackError(`Template is missing '${marker}'`, "MISSING_TEMPLATE_SECTION");
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("## ")) {
      end = index;
      break;
    }
  }
  const replacement = contents.trim().length > 0 ? contents.trim() : "Not recorded.";
  lines.splice(start + 1, end - start - 1, "", replacement, "");
  return validateMarkdownBody(lines.join("\n"));
}
