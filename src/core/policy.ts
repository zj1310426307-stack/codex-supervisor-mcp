import path from "node:path";

export type ApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval";

const COMMAND_APPROVAL_FIELDS = new Set([
  "itemId",
  "threadId",
  "turnId",
  "reason",
  "command",
  "cwd",
  "commandActions",
  "proposedExecpolicyAmendment",
  "networkApprovalContext",
  "availableDecisions",
  "additionalPermissions"
]);

const FILE_APPROVAL_FIELDS = new Set(["itemId", "threadId", "turnId", "reason", "grantRoot"]);

const BLOCKED_COMMAND_PATTERNS: Array<[RegExp, string]> = [
  [/\bsudo\b/i, "privilege escalation"],
  [/\bgit(?:\.exe)?\b[^\r\n]*\b(?:commit|push|merge|rebase)\b/i, "repository publication/history operation"],
  [/\bgit(?:\.exe)?\b[^\r\n]*\breset\b[^\r\n]*--hard\b/i, "destructive git reset"],
  [/\bgit(?:\.exe)?\b[^\r\n]*\bclean\b[^\r\n]*-[^\s]*[fdx][^\s]*/i, "destructive git clean"],
  [/\bgit(?:\.exe)?\b[^\r\n]*\bcheckout\b[^\r\n]*--/i, "destructive working tree replacement"],
  [/\bgit(?:\.exe)?\b[^\r\n]*\brestore\b[^\r\n]*(?:--source\s+\S+\s+)?\.\s*$/i, "destructive working tree replacement"],
  [/\bgit(?:\.exe)?\b[^\r\n]*\bworktree\s+remove\b[^\r\n]*--force/i, "forced worktree removal"],
  [/\brm\s+-[^\s]*r[^\s]*f[^\s]*\s+\/(?:\s|$)/i, "recursive deletion of filesystem root"],
  [/\bmkfs(?:\.|\s)/i, "filesystem formatting"],
  [/\bdd\s+if=/i, "raw block copy"],
  [/\bshutdown\b|\breboot\b/i, "host shutdown/reboot"],
  [/(?:curl|wget)[^\n|]*\|\s*(?:sh|bash|zsh|powershell)\b/i, "pipe remote content into a shell"],
  [/\bInvoke-Expression\b|\biex\s*(?:\(|\s)/i, "PowerShell dynamic execution"],
  [/\bRemove-Item\b(?=[^\n]*-Recurse)(?=[^\n]*-Force)/i, "recursive forced deletion"],
  [/\b(?:rmdir|rd)\b(?=[^\n]*\/s)(?=[^\n]*\/q)/i, "recursive forced deletion"],
  [/\brm\s+-[^\s]*r[^\s]*f[^\s]*\s+(?:[A-Za-z]:[\\/]?|~|\$HOME)(?:\s|$)/i, "recursive deletion of broad user or drive root"],
  [/\b(?:chmod|chown)\b[^\n]*\s-R\b/i, "recursive permission or ownership change"]
];

export interface RiskResult {
  risk: "normal" | "blocked";
  reasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyFields(params: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(params).every((key) => allowed.has(key));
}

function validCommonContext(params: Record<string, unknown>): boolean {
  return ["itemId", "threadId", "turnId"].every((key) => isNonEmptyString(params[key])) &&
    (params.reason === undefined || typeof params.reason === "string");
}

function isInsideWorkspace(workspace: string, candidate: string): boolean {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function commandText(value: unknown): string | undefined {
  if (isNonEmptyString(value)) return value;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === "string" && part.length > 0)
  ) {
    return value.join(" ");
  }
  return undefined;
}

function commandActionsAreStructured(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((action) => typeof action === "string" || isRecord(action));
}

function collectNestedPathFields(value: unknown, out: string[], key = ""): void {
  if (typeof value === "string") {
    if (/(?:^|_)(?:path|cwd|root|source|destination|target|directory|dir)$/i.test(key)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectNestedPathFields(entry, out, key);
    return;
  }
  if (isRecord(value)) {
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      collectNestedPathFields(nestedValue, out, nestedKey);
    }
  }
}

function collectNestedCommandFields(value: unknown, out: string[], key = ""): void {
  if (typeof value === "string") {
    if (/^(?:command|cmd|argv|shellCommand)$/i.test(key)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    if (/^(?:command|cmd|argv|shellCommand)$/i.test(key) && value.every((entry) => typeof entry === "string")) {
      out.push(value.join(" "));
      return;
    }
    for (const entry of value) collectNestedCommandFields(entry, out, key);
    return;
  }
  if (isRecord(value)) {
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      collectNestedCommandFields(nestedValue, out, nestedKey);
    }
  }
}

function commandTraversalCandidates(command: string): string[] {
  const candidates: string[] = [];
  // A bare `..` is just as capable of escaping the owned worktree as
  // `../path`.  Include common shell separators so constructs such as
  // `cd .. && ...` cannot evade the workspace boundary check.
  const traversal = /(?:^|[\s"'=(:,;&|])(\.\.(?:[\\/][^\s"';&|)]*)?)(?=$|[\s"'),;:&|])/g;
  for (const match of command.matchAll(traversal)) candidates.push(match[1]);
  return candidates;
}

function commandAbsolutePathCandidates(command: string): string[] {
  const tokens: string[] = [];
  const tokenPattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  for (const match of command.matchAll(tokenPattern)) {
    const token = (match[1] ?? match[2] ?? match[3] ?? "")
      .replace(/^[<>(),;|&]+/, "")
      .replace(/[),;|&]+$/, "");
    if (token.includes(" ")) {
      tokens.push(...commandAbsolutePathCandidates(token));
    }
    if (token) tokens.push(token.includes("=") ? token.slice(token.indexOf("=") + 1) : token);
  }
  return tokens.slice(1).filter((token) => {
    if (/^\/[A-Za-z?]+$/.test(token)) return false; // cmd.exe-style switch, not a path
    return /^[A-Za-z]:[\\/]/.test(token) || /^\\\\/.test(token) || token.startsWith("/");
  });
}

function blocked(reasons: string[]): RiskResult {
  return { risk: "blocked", reasons: [...new Set(reasons)] };
}

function classifyCommandApproval(params: Record<string, unknown>, workspace: string): RiskResult {
  const reasons: string[] = [];
  if (!hasOnlyFields(params, COMMAND_APPROVAL_FIELDS)) reasons.push("command approval contains unknown fields");
  if (!validCommonContext(params)) reasons.push("command approval is missing exact item/thread/turn identity");

  const command = commandText(params.command);
  if (!command) reasons.push("command approval has an invalid command");
  if (params.cwd !== undefined && !isNonEmptyString(params.cwd)) reasons.push("command approval has an invalid cwd");
  if (params.cwd === undefined) reasons.push("command approval has no workspace-bound cwd");
  if (params.commandActions !== undefined && !commandActionsAreStructured(params.commandActions)) {
    reasons.push("command approval has malformed commandActions");
  }
  if (
    params.availableDecisions !== undefined &&
    (!Array.isArray(params.availableDecisions) || !params.availableDecisions.every((entry) => typeof entry === "string"))
  ) {
    reasons.push("command approval has malformed availableDecisions");
  }
  if (Object.hasOwn(params, "proposedExecpolicyAmendment")) {
    reasons.push("local supervisor does not authorize exec policy amendments");
  }
  if (Object.hasOwn(params, "networkApprovalContext")) {
    reasons.push("local supervisor does not authorize network access");
  }
  if (Object.hasOwn(params, "additionalPermissions")) {
    reasons.push("local supervisor does not authorize additional permissions");
  }

  const commands = command ? [command] : [];
  if (params.commandActions !== undefined) collectNestedCommandFields(params.commandActions, commands);
  for (const candidateCommand of commands) {
    for (const [pattern, reason] of BLOCKED_COMMAND_PATTERNS) {
      if (pattern.test(candidateCommand)) reasons.push(reason);
    }
    if (commandTraversalCandidates(candidateCommand).some((candidate) => !isInsideWorkspace(workspace, candidate))) {
      reasons.push("command references a path outside the supervised workspace");
    }
    if (commandAbsolutePathCandidates(candidateCommand).some((candidate) => !isInsideWorkspace(workspace, candidate))) {
      reasons.push("command references an absolute path outside the supervised workspace");
    }
  }

  const paths: string[] = [];
  if (typeof params.cwd === "string") paths.push(params.cwd);
  if (params.commandActions !== undefined) collectNestedPathFields(params.commandActions, paths);
  if (paths.some((candidate) => !isInsideWorkspace(workspace, candidate))) {
    reasons.push("command approval references a path outside the supervised workspace");
  }

  return reasons.length > 0 ? blocked(reasons) : { risk: "normal", reasons: [] };
}

function classifyFileApproval(params: Record<string, unknown>, workspace: string): RiskResult {
  const reasons: string[] = [];
  if (!hasOnlyFields(params, FILE_APPROVAL_FIELDS)) reasons.push("file approval contains unknown fields");
  if (!validCommonContext(params)) reasons.push("file approval is missing exact item/thread/turn identity");
  if (params.grantRoot !== undefined && !isNonEmptyString(params.grantRoot)) {
    reasons.push("file approval has an invalid grantRoot");
  }
  if (typeof params.grantRoot === "string" && !isInsideWorkspace(workspace, params.grantRoot)) {
    reasons.push("file approval grantRoot is outside the supervised workspace");
  }
  return reasons.length > 0 ? blocked(reasons) : { risk: "normal", reasons: [] };
}

export function classifyApproval(
  method: string,
  params: Record<string, unknown>,
  workspace: string
): RiskResult {
  if (!isRecord(params)) return blocked(["approval params must be a structured object"]);
  if (method === "item/commandExecution/requestApproval") return classifyCommandApproval(params, workspace);
  if (method === "item/fileChange/requestApproval") return classifyFileApproval(params, workspace);
  return blocked([`unsupported approval method: ${method}`]);
}
