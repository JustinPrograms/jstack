export type SafetyDisposition = "allow" | "require-explicit-request" | "deny";

export interface SafetyDecision {
  disposition: SafetyDisposition;
  reason: string;
  rule: string;
}

export function hookCommandFromPayload(source: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const candidates = [record.tool_input, record.input, record];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const command = (candidate as Record<string, unknown>).command;
    if (typeof command === "string" && command.trim().length > 0) return command;
  }
  return null;
}

function normalizedCommand(command: string | readonly string[], stripGitInvocationOptions = true): string {
  const source = typeof command === "string" ? command : command.join(" ");
  let normalized = source
    .replace(/[\r\n]+/gu, ";")
    .replace(/\t+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\{[a-z_][a-z0-9_]*\}(?=[<>])/giu, "")
    .replace(
      /(^|[;&|(){}]\s*)["'][^"'\r\n]*[\\/](git|gh|glab|curl|wget|jira|jira-cli|powershell|pwsh|cmd|bash|zsh|ksh|sh|env|sudo|doas)(?:\.exe)?["'](?=\s|$)/giu,
      "$1$2",
    )
    .replace(
      /(^|[;&|(){}]\s*)[^\s;&|(){}]+[\\/](git|gh|glab|curl|wget|jira|jira-cli|powershell|pwsh|cmd|bash|zsh|ksh|sh|env|sudo|doas)(?:\.exe)?(?=\s|$)/giu,
      "$1$2",
    )
    .replace(/\b(git|gh|glab|curl|wget|jira|jira-cli|powershell|pwsh|cmd|bash|zsh|ksh|sh)\.exe\b/giu, "$1");

  if (!stripGitInvocationOptions) return normalized;
  const optionValue = String.raw`(?:"[^"]*"|'[^']*'|[^\s]+)`;
  return normalized.replace(
    new RegExp(
      String.raw`\bgit\s+(?:(?:(?:-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env|--attr-source)\s+${optionValue}|-[cC](?:"[^"]*"|'[^']*'|[^\s]+)|(?:--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env|--attr-source)=${optionValue}|-(?:p|P)|--(?:bare|no-replace-objects|no-lazy-fetch|no-advice|no-pager|paginate|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs|no-optional-locks|exec-path))\s+)+`,
      "giu",
    ),
    "git ",
  );
}

function shellSegments(command: string): string[] {
  return executableCommandWords(command).map((words) => words.join(" "));
}

function parenthesizedCommand(source: string, openIndex: number): { content: string; endIndex: number } | null {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quote !== null) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"') index += 1;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "\\") index += 1;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return { content: source.slice(openIndex + 1, index), endIndex: index };
    }
  }
  return null;
}

function backtickCommand(source: string, openIndex: number): { content: string; endIndex: number } | null {
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "\\") index += 1;
    else if (character === "`") return { content: source.slice(openIndex + 1, index), endIndex: index };
  }
  return null;
}

function shellCommandWords(source: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let processSubstitutionDepth = 0;
  let processSubstitutionQuote: "'" | '"' | null = null;
  let processSubstitutionContent = "";

  const finishWord = () => {
    if (word.length === 0) return;
    words.push(word);
    word = "";
  };
  const finishCommand = () => {
    finishWord();
    const withoutRedirections: string[] = [];
    for (let index = 0; index < words.length; index += 1) {
      const candidate = words[index] ?? "";
      if (/^(?:\d*(?:>>?|>\||<<<|<<-?|<|<>|>&|<&)|&>>?|\*>>?)$/u.test(candidate)) {
        index += 1;
        continue;
      }
      if (/^(?:\d*(?:>>?|>\||<<<|<<-?|<|<>|>&|<&)|&>>?|\*>>?).+/u.test(candidate)) continue;
      withoutRedirections.push(candidate);
    }
    while (/^[a-z_][a-z0-9_]*=/iu.test(withoutRedirections[0] ?? "")) withoutRedirections.shift();
    if (withoutRedirections.length > 0) commands.push(withoutRedirections);
    words = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (processSubstitutionDepth > 0) {
      word += character;
      if (processSubstitutionQuote !== null) {
        processSubstitutionContent += character;
        if (character === processSubstitutionQuote) processSubstitutionQuote = null;
        else if (character === "\\" && processSubstitutionQuote === '"' && index + 1 < source.length) {
          index += 1;
          word += source[index] ?? "";
          processSubstitutionContent += source[index] ?? "";
        }
      } else if (character === "'" || character === '"') {
        processSubstitutionContent += character;
        processSubstitutionQuote = character;
      } else if (character === "\\" && index + 1 < source.length) {
        processSubstitutionContent += character;
        index += 1;
        word += source[index] ?? "";
        processSubstitutionContent += source[index] ?? "";
      } else if (character === "(") {
        processSubstitutionContent += character;
        processSubstitutionDepth += 1;
      } else if (character === ")") {
        processSubstitutionDepth -= 1;
        if (processSubstitutionDepth === 0) {
          commands.push(...shellCommandWords(processSubstitutionContent));
          processSubstitutionContent = "";
        } else {
          processSubstitutionContent += character;
        }
      } else {
        processSubstitutionContent += character;
      }
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else if (character === "\\" && quote === '"' && index + 1 < source.length) {
        index += 1;
        word += source[index] ?? "";
      } else if (quote === '"' && character === "$" && source[index + 1] === "(") {
        const nested = parenthesizedCommand(source, index + 1);
        if (nested === null) word += character;
        else {
          commands.push(...shellCommandWords(nested.content));
          word += source.slice(index, nested.endIndex + 1);
          index = nested.endIndex;
        }
      } else if (quote === '"' && character === "`") {
        const nested = backtickCommand(source, index);
        if (nested === null) word += character;
        else {
          commands.push(...shellCommandWords(nested.content));
          word += source.slice(index, nested.endIndex + 1);
          index = nested.endIndex;
        }
      } else if (quote === '"' && /[<>]/u.test(character) && source[index + 1] === "(") {
        const nested = parenthesizedCommand(source, index + 1);
        if (nested === null) word += character;
        else {
          commands.push(...shellCommandWords(nested.content));
          word += source.slice(index, nested.endIndex + 1);
          index = nested.endIndex;
        }
      } else {
        word += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "\\" && index + 1 < source.length) {
      index += 1;
      word += source[index] ?? "";
    } else if (/\s/u.test(character)) {
      finishWord();
    } else if (character === "(" && /[<>]$/u.test(word)) {
      word += character;
      processSubstitutionDepth = 1;
      processSubstitutionContent = "";
    } else if (character === "&" && /[<>]$/u.test(word)) {
      word += character;
    } else if (character === "&" && source[index + 1] === ">") {
      word += character;
    } else if (character === "|" && />$/u.test(word)) {
      word += character;
    } else if (/[;&|(){}`]/u.test(character)) {
      finishCommand();
    } else {
      word += character;
    }
  }
  finishCommand();
  return commands;
}

function executableName(word: string | undefined): string {
  if (word === undefined) return "";
  const normalized = word.replace(/\\/gu, "/");
  return (normalized.split("/").at(-1) ?? normalized).replace(/\.exe$/iu, "").toLowerCase();
}

function recurseExecutableWords(words: readonly string[], depth: number): string[][] {
  if (words.length === 0) return [];
  if (depth >= 32) return [["__justinstack_uninspectable_wrapper__"]];
  return unwrapExecutableWords([...words], depth + 1);
}

function shellPayloadWords(payload: string, depth: number): string[][] {
  return shellCommandWords(payload).flatMap((words) => recurseExecutableWords(words, depth));
}

function skipOptionWithRequiredValue(
  words: readonly string[],
  index: number,
  shortOptions: ReadonlySet<string>,
  longOptions: ReadonlySet<string>,
): number | null {
  const token = words[index];
  if (token === undefined) return null;
  const lower = token.toLowerCase();
  if (longOptions.has(lower)) return index + 2;
  if ([...longOptions].some((option) => lower.startsWith(`${option}=`))) return index + 1;
  if (shortOptions.has(token)) return index + 2;
  if ([...shortOptions].some((option) => token.startsWith(option) && token.length > option.length)) return index + 1;
  return null;
}

function unwrapEnvironment(words: readonly string[], depth: number): string[][] {
  const valuedShort = new Set(["-a", "-C", "-S", "-u"]);
  const valuedLong = new Set(["--argv0", "--chdir", "--split-string", "--unset"]);
  let index = 1;
  while (index < words.length) {
    const token = words[index] ?? "";
    if (token === "--") {
      index += 1;
      break;
    }
    if (/^[a-z_][a-z0-9_]*=/iu.test(token)) {
      index += 1;
      continue;
    }

    const lower = token.toLowerCase();
    const splitString = token === "-S" || lower === "--split-string";
    const splitStringWithValue = token.startsWith("-S") && token.length > 2 || lower.startsWith("--split-string=");
    if (splitString || splitStringWithValue) {
      const value = splitString
        ? words[index + 1]
        : token.startsWith("-S")
          ? token.slice(2)
          : token.slice(token.indexOf("=") + 1);
      if (value === undefined) return [[...words]];
      const remainder = words.slice(index + (splitString ? 2 : 1));
      const expanded = shellCommandWords(value).flat();
      return recurseExecutableWords([...expanded, ...remainder], depth);
    }

    const afterValuedOption = skipOptionWithRequiredValue(words, index, valuedShort, valuedLong);
    if (afterValuedOption !== null) {
      if (afterValuedOption > words.length) return [[...words]];
      index = afterValuedOption;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return recurseExecutableWords(words.slice(index), depth);
}

function unwrapPrivilegeWrapper(words: readonly string[], depth: number): string[][] {
  const valuedShort = new Set(["-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u", "-a"]);
  const valuedLong = new Set([
    "--chdir",
    "--chroot",
    "--close-from",
    "--command-timeout",
    "--config",
    "--group",
    "--host",
    "--login-class",
    "--other-user",
    "--prompt",
    "--role",
    "--type",
    "--user",
  ]);
  let index = 1;
  while (index < words.length) {
    const token = words[index] ?? "";
    if (token === "--") {
      index += 1;
      break;
    }
    const afterValuedOption = skipOptionWithRequiredValue(words, index, valuedShort, valuedLong);
    if (afterValuedOption !== null) {
      if (afterValuedOption > words.length) return [[...words]];
      index = afterValuedOption;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  while (/^[a-z_][a-z0-9_]*=/iu.test(words[index] ?? "")) index += 1;
  return recurseExecutableWords(words.slice(index), depth);
}

function unwrapTime(words: readonly string[], depth: number): string[][] {
  const valuedShort = new Set(["-f", "-o"]);
  const valuedLong = new Set(["--format", "--output"]);
  let index = 1;
  while (index < words.length) {
    const token = words[index] ?? "";
    if (token === "--") {
      index += 1;
      break;
    }
    const afterValuedOption = skipOptionWithRequiredValue(words, index, valuedShort, valuedLong);
    if (afterValuedOption !== null) {
      if (afterValuedOption > words.length) return [[...words]];
      index = afterValuedOption;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return recurseExecutableWords(words.slice(index), depth);
}

function unwrapExec(words: readonly string[], depth: number): string[][] {
  let index = 1;
  while (index < words.length) {
    const token = words[index] ?? "";
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "-a") {
      index += 2;
      continue;
    }
    if (token.startsWith("-a") && token.length > 2 || token.startsWith("-") && token !== "-") {
      index += 1;
      continue;
    }
    break;
  }
  return recurseExecutableWords(words.slice(index), depth);
}

function unwrapShell(words: readonly string[], depth: number): string[][] {
  const valuedOptions = new Set(["--init-file", "--rcfile", "-o", "-O", "+O"]);
  let index = 1;
  while (index < words.length) {
    const token = words[index] ?? "";
    if (token === "--") return [[...words]];
    if (valuedOptions.has(token)) {
      index += 2;
      continue;
    }
    if (/^--(?:init-file|rcfile)=/iu.test(token) || /^[-+]O.+/u.test(token)) {
      index += 1;
      continue;
    }
    if (/^-[^-]*c[^-]*$/iu.test(token)) {
      const payload = words[index + 1];
      return payload === undefined ? [[...words]] : shellPayloadWords(payload, depth);
    }
    if (token.startsWith("-") || token.startsWith("+")) {
      index += 1;
      continue;
    }
    return [[...words]];
  }
  return [[...words]];
}

function stripRemoteCliRoutingOptions(words: readonly string[]): string[] {
  const valued = new Set(["-R", "--repo", "--hostname", "--api-host", "--token"]);
  const result = [words[0] ?? ""];
  for (let index = 1; index < words.length; index += 1) {
    const token = words[index] ?? "";
    const lower = token.toLowerCase();
    if (token.startsWith("-R") && token.length > 2) continue;
    if (valued.has(token) || valued.has(lower)) {
      index += 1;
      continue;
    }
    if ([...valued].some((option) => lower.startsWith(`${option.toLowerCase()}=`))) continue;
    result.push(token);
  }
  return result;
}

function unwrapExecutableWords(words: string[], depth = 0): string[][] {
  const name = executableName(words[0]);
  if (name === "!") return recurseExecutableWords(words.slice(1), depth);
  if (name === "env") return unwrapEnvironment(words, depth);
  if (name === "sudo" || name === "doas") return unwrapPrivilegeWrapper(words, depth);
  if (name === "time") return unwrapTime(words, depth);
  if (name === "exec") return unwrapExec(words, depth);
  if (name === "nohup") {
    const index = words[1] === "--" ? 2 : words[1]?.startsWith("-") === true ? 2 : 1;
    return recurseExecutableWords(words.slice(index), depth);
  }
  if (name === "command") {
    let index = 1;
    while (words[index]?.startsWith("-") === true) {
      if (words[index] === "-v" || words[index] === "-V") return [words];
      index += 1;
    }
    return recurseExecutableWords(words.slice(index), depth);
  }
  if (name === "call") return recurseExecutableWords(words.slice(1), depth);
  if (name === "gh" || name === "glab") return [stripRemoteCliRoutingOptions(words)];
  if (["bash", "zsh", "ksh", "sh"].includes(name)) return unwrapShell(words, depth);
  if (name === "cmd") {
    const marker = words.findIndex((word, index) => index > 0 && /^\/[ck]/iu.test(word));
    if (marker < 0) return [words];
    const option = words[marker] ?? "";
    const attached = option.slice(2);
    const payload = [attached, ...words.slice(marker + 1)].filter((part) => part.length > 0).join(" ");
    return shellCommandWords(payload).flatMap((segment) => {
      const variants = [segment, segment.map((word) => word.replace(/\^(?=[a-z0-9_.-])/giu, ""))];
      return variants.flatMap((variant) => {
        const normalizedSegment = [...variant];
        if (normalizedSegment[0] !== undefined) normalizedSegment[0] = normalizedSegment[0].replace(/^[@^]+/u, "");
        return recurseExecutableWords(normalizedSegment, depth);
      });
    });
  }
  if (name === "powershell" || name === "pwsh") {
    const encoded = words.some((word, index) => {
      if (index === 0) return false;
      const lower = word.toLowerCase();
      return lower.length >= 2 && "-encodedcommand".startsWith(lower);
    });
    if (encoded) return [["__justinstack_uninspectable_wrapper__"]];
    const marker = words.findIndex((word, index) => {
      if (index === 0) return false;
      const lower = word.toLowerCase();
      return (lower.length >= 2 && "-command".startsWith(lower)) || lower === "-commandwithargs";
    });
    return marker < 0 ? [words] : shellPayloadWords(words.slice(marker + 1).join(" "), depth);
  }
  return [words];
}

function executableCommandWords(source: string): string[][] {
  return shellCommandWords(source).flatMap((words) => unwrapExecutableWords(words));
}

function powerShellNativeInterpretation(source: string): string {
  let interpreted = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quote === "'") {
      interpreted += character;
      if (character === "'" && source[index + 1] === "'") {
        index += 1;
        interpreted += source[index] ?? "";
      } else if (character === "'") quote = null;
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? null : '"';
      interpreted += character;
      continue;
    }
    if (character === "'" && quote === null) {
      quote = "'";
      interpreted += character;
      continue;
    }
    if (character === "`" && index + 1 < source.length) {
      index += 1;
      interpreted += source[index] ?? "";
      continue;
    }
    const previous = source[index - 1];
    const afterStopParsing = source[index + 3];
    if (
      quote === null && source.slice(index, index + 3) === "--%" &&
      (previous === undefined || /\s/u.test(previous)) &&
      (afterStopParsing === undefined || /\s/u.test(afterStopParsing))
    ) {
      interpreted += " ";
      index += 2;
      continue;
    }
    interpreted += character;
  }
  return interpreted;
}

function shellWords(source: string): string[] {
  return [...source.matchAll(/"[^"]*"|'[^']*'|[^\s]+/gu)].map((match) => {
    const value = match[0];
    return value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value;
  });
}

function gitConfigMutates(command: string): boolean {
  const writeOptions = new Set([
    "--add",
    "--edit",
    "-e",
    "--remove-section",
    "--rename-section",
    "--replace-all",
    "--unset",
    "--unset-all",
  ]);
  const readOptions = new Set([
    "--get",
    "--get-all",
    "--get-color",
    "--get-colorbool",
    "--get-regexp",
    "--get-urlmatch",
    "--list",
    "-l",
  ]);
  const valuelessModifiers = new Set([
    "--fixed-value",
    "--global",
    "--includes",
    "--local",
    "--name-only",
    "--no-includes",
    "--null",
    "--show-names",
    "--show-origin",
    "--show-scope",
    "--system",
    "--worktree",
    "-z",
  ]);
  const valuedModifiers = new Set(["--blob", "--default", "--file", "--type", "-f"]);
  const readSubcommands = new Set(["get", "get-all", "get-color", "get-colorbool", "get-regexp", "get-urlmatch", "list"]);
  const writeSubcommands = new Set(["edit", "remove-section", "rename-section", "set", "unset", "unset-all"]);

  for (const segment of shellSegments(command)) {
    const match = /^git\s+config\b(.*)$/iu.exec(segment);
    if (!match) continue;
    const args = shellWords(match[1] ?? "");
    const lower = args.map((argument) => argument.toLowerCase());
    if (lower.some((argument) => writeOptions.has(argument.split("=", 1)[0] ?? argument))) return true;
    if (lower.some((argument) => readOptions.has(argument.split("=", 1)[0] ?? argument))) continue;

    const positional: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const argument = lower[index];
      if (argument === undefined) continue;
      if (valuelessModifiers.has(argument) || argument.startsWith("--type=")) continue;
      if (valuedModifiers.has(argument)) {
        index += 1;
        continue;
      }
      if ([...valuedModifiers].some((option) => argument.startsWith(`${option}=`))) continue;
      if (argument.startsWith("-")) continue;
      positional.push(args[index] ?? "");
    }
    const subcommand = positional[0]?.toLowerCase();
    if (subcommand !== undefined && readSubcommands.has(subcommand)) continue;
    if (subcommand !== undefined && writeSubcommands.has(subcommand)) return true;
    if (positional.length >= 2) return true;
  }
  return false;
}

function cliApiMutates(command: string): boolean {
  for (const segment of shellSegments(command)) {
    const match = /^(?:gh|glab)\s+api\b(.*)$/iu.exec(segment);
    if (!match) continue;
    const argumentsSource = match[1] ?? "";
    const method = /(?:^|\s)(?:--method(?:=|\s+)|-x\s*)(get|head|post|put|patch|delete)(?:\s|$)/iu.exec(argumentsSource)?.[1]?.toLowerCase();
    if (method !== undefined) {
      if (!["get", "head"].includes(method)) return true;
      continue;
    }
    if (/(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:=|\s|$)/iu.test(argumentsSource)) return true;
  }
  return false;
}

function httpCommandMutates(command: string): boolean {
  for (const segment of shellSegments(command)) {
    if (/^curl\b/iu.test(segment)) {
      if (/(?:^|\s)(?:-K(?:[^\s]+|\s)|--config(?:=|\s))/u.test(segment)) return true;
      const method = /(?:^|\s)(?:-X(?:\s*|=)|--request(?:=|\s+))([a-z]+)(?:\s|$)/iu.exec(segment)?.[1]?.toLowerCase();
      if (method !== undefined && !["get", "head", "options"].includes(method)) return true;
      const usesGet = /(?:^|\s)-G(?:\s|$)/u.test(segment) || /(?:^|\s)--get(?:\s|$)/iu.test(segment);
      const sendsBody =
        /(?:^|\s)(?:-d(?:[^\s]+|\s)|-F(?:[^\s]+|\s)|-T(?:[^\s]+|\s))/u.test(segment) ||
        /(?:^|\s)(?:--data(?:-ascii|-binary|-raw|-urlencode)?|--form|--form-string|--json|--upload-file)(?:=|\s|$)/iu.test(segment);
      if (!usesGet && sendsBody) return true;
    }
    if (/^wget\b/iu.test(segment)) {
      const method = /(?:^|\s)--method(?:=|\s+)([a-z]+)(?:\s|$)/iu.exec(segment)?.[1]?.toLowerCase();
      if (method !== undefined && !["get", "head", "options"].includes(method)) return true;
      if (/(?:^|\s)(?:--post-data|--post-file|--body-data|--body-file)(?:=|\s)/iu.test(segment)) return true;
    }
    if (/^(?:invoke-webrequest|invoke-restmethod|iwr|irm)\b/iu.test(segment)) {
      const method = /(?:^|\s)-(?:me(?:t(?:h(?:o(?:d)?)?)?)?|custommethod)\s+["']?([a-z]+)["']?(?:\s|$)/iu.exec(segment)?.[1]?.toLowerCase();
      const explicitlyReads = method !== undefined && ["get", "head", "options"].includes(method);
      if (
        method !== undefined && !explicitlyReads ||
        (!explicitlyReads && /(?:^|\s)-(?:body|form|infile)(?:\s|:)/iu.test(segment))
      ) {
        return true;
      }
    }
  }
  return false;
}

function configuresGitAlias(command: string): boolean {
  return executableCommandWords(command).some((words) => {
    if (words[0]?.toLowerCase() !== "git") return false;
    return words.some((word, index) => {
      const lower = word.toLowerCase();
      if (lower === "-c") return words[index + 1]?.toLowerCase().startsWith("alias.") === true;
      if (lower.startsWith("-calias.")) return true;
      if (lower === "--config-env") return words[index + 1]?.toLowerCase().startsWith("alias.") === true;
      return lower.startsWith("--config-env=alias.");
    });
  });
}

function matchesAtCommandStart(pattern: RegExp, commands: readonly string[]): boolean {
  return commands.some((segment) => {
    pattern.lastIndex = 0;
    return pattern.exec(segment)?.index === 0;
  });
}

const DENIED_RULES: readonly { pattern: RegExp; reason: string; rule: string }[] = [
  {
    pattern: /(?:^|[;&|()"']\s*)git\s+push(?:\s|$)/iu,
    reason: "JustinStack never pushes Git changes.",
    rule: "git-push",
  },
  {
    pattern: /(?:^|[;&|()"']\s*)git\s+send-pack(?:\s|$)/iu,
    reason: "JustinStack never pushes Git changes through git send-pack.",
    rule: "git-push",
  },
  {
    pattern: /(?:^|[;&|()"']\s*)git\s+remote\s+(?:add|remove|rename|set-head|set-branches|set-url)(?:\s|$)/iu,
    reason: "JustinStack never changes Git remotes.",
    rule: "git-remote-mutation",
  },
  {
    pattern: /(?:^|[;&|()]\s*)(?:gh\s+pr|glab\s+mr)\s+(?:create|edit|update|comment|note|close|merge|reopen|review|approve|ready|revoke)(?:\s|$)/iu,
    reason: "JustinStack never creates or mutates pull or merge requests.",
    rule: "pull-request-mutation",
  },
  {
    pattern: /(?:^|[;&|()]\s*)(?:gh|glab)\s+(?:issue|api)\s+(?:create|edit|update|comment|note|close|reopen|delete|move|transfer|lock|unlock|pin|unpin|post|put|patch)(?:\s|$)/iu,
    reason: "JustinStack never mutates tickets or remote service data.",
    rule: "remote-service-mutation",
  },
  {
    pattern: /(?:^|[;&|()]\s*)(?:jira|jira-cli)\s+(?:(?:issue|project)\s+)?(?:create|edit|update|assign|comment|close|reopen|transition|delete|move)(?:\s|$)/iu,
    reason: "JustinStack never mutates Jira or another ticket service.",
    rule: "ticket-mutation",
  },
  {
    pattern: /(?:^|[;&|()]\s*)gh\s+(?:release\s+(?:create|delete|edit|upload)|repo\s+(?:archive|create|delete|edit|fork|rename|sync)|run\s+(?:cancel|delete|rerun)|workflow\s+(?:disable|enable|run)|(?:secret|variable)\s+(?:delete|set)|label\s+(?:clone|create|delete|edit))(?:\s|$)/iu,
    reason: "JustinStack never creates or mutates remote releases or repositories.",
    rule: "remote-service-mutation",
  },
  {
    pattern: /(?:^|[;&|()]\s*)glab\s+(?:release\s+(?:create|delete|upload)|repo\s+(?:archive|create|delete|fork|mirror)|ci\s+(?:cancel|retry|run)|variable\s+(?:delete|set|update))(?:\s|$)/iu,
    reason: "JustinStack never creates or mutates remote GitLab resources.",
    rule: "remote-service-mutation",
  },
  {
    pattern: /(?:^|[;&|()]\s*)gh\s+(?:gist\s+(?:create|delete|edit)|cache\s+delete|codespace\s+(?:create|delete|edit|rebuild|stop)|project\s+(?:close|copy|create|delete|edit|item-add|item-archive|item-create|item-delete|item-edit|link|unlink))(?:\s|$)/iu,
    reason: "JustinStack never creates or mutates remote GitHub resources.",
    rule: "remote-service-mutation",
  },
  {
    pattern: /(?:^|[;&|()]\s*)glab\s+snippet\s+(?:create|delete|update)(?:\s|$)/iu,
    reason: "JustinStack never creates or mutates remote GitLab resources.",
    rule: "remote-service-mutation",
  },
];

const EXPLICIT_REQUEST_RULES: readonly { pattern: RegExp; reason: string; rule: string }[] = [
  {
    pattern: /(?:^|[;&|()]\s*)git\s+(?:add|commit)(?:\s|$)/iu,
    reason: "Git staging and commits require an explicit request from the user in the current conversation.",
    rule: "git-write-requires-request",
  },
];

/**
 * Classifies a proposed command for defense-in-depth hooks. It never executes
 * the command; it applies bounded shell and native-argument interpretations.
 * Skill instructions remain authoritative because shell syntax and wrapper
 * programs cannot be classified perfectly without platform-specific enforcement.
 */
export function classifyCommand(command: string | readonly string[]): SafetyDecision {
  const source = typeof command === "string" ? command : command.join(" ");
  const interpretations = [...new Set([source, powerShellNativeInterpretation(source)])];
  if (interpretations.some((interpretation) => configuresGitAlias(normalizedCommand(interpretation, false)))) {
    return {
      disposition: "deny",
      reason: "JustinStack does not execute commands through temporary Git aliases because they can hide remote mutations.",
      rule: "git-alias",
    };
  }
  const normalizedCommands = interpretations.map((interpretation) => normalizedCommand(interpretation));
  if (normalizedCommands.every((normalized) => normalized.length === 0)) {
    return { disposition: "allow", reason: "No command was supplied.", rule: "empty-command" };
  }
  const executableCommands = normalizedCommands.flatMap((normalized) => shellSegments(normalized));
  if (executableCommands.some((candidate) => candidate === "__justinstack_uninspectable_wrapper__")) {
    return {
      disposition: "deny",
      reason: "JustinStack cannot safely inspect an encoded shell command.",
      rule: "uninspectable-wrapper",
    };
  }
  for (const candidate of DENIED_RULES) {
    if (matchesAtCommandStart(candidate.pattern, executableCommands)) {
      return { disposition: "deny", reason: candidate.reason, rule: candidate.rule };
    }
  }
  if (normalizedCommands.some((normalized) => cliApiMutates(normalized))) {
    return {
      disposition: "deny",
      reason: "JustinStack never sends mutating GitHub API requests.",
      rule: "remote-service-mutation",
    };
  }
  if (normalizedCommands.some((normalized) => httpCommandMutates(normalized))) {
    return {
      disposition: "deny",
      reason: "JustinStack never sends mutating HTTP requests to remote services.",
      rule: "http-mutation",
    };
  }
  if (normalizedCommands.some((normalized) => gitConfigMutates(normalized))) {
    return {
      disposition: "deny",
      reason: "JustinStack never changes Git configuration.",
      rule: "git-config-mutation",
    };
  }
  for (const candidate of EXPLICIT_REQUEST_RULES) {
    if (matchesAtCommandStart(candidate.pattern, executableCommands)) {
      return {
        disposition: "require-explicit-request",
        reason: candidate.reason,
        rule: candidate.rule,
      };
    }
  }
  return {
    disposition: "allow",
    reason: "No permanent JustinStack restriction matched. Normal user authorization still applies.",
    rule: "no-match",
  };
}
