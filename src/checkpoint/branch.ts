import { StoryStackError } from "../errors.js";

export function assertSafeBranchName(value: string, options: { allowDetached?: boolean } = {}): void {
  if (options.allowDetached && value === "(detached)") return;
  if (
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value === "@" ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    /[\0-\x20\x7f~^:?*[\\]/u.test(value)
  ) {
    throw new StoryStackError(`Unsafe or invalid local branch name '${value}'`, "INVALID_BRANCH");
  }
  for (const component of value.split("/")) {
    if (component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock")) {
      throw new StoryStackError(`Unsafe or invalid local branch name '${value}'`, "INVALID_BRANCH");
    }
  }
}
