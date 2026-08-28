import path from "node:path";

export type ApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval";

const COMMAND_APPROVAL_FIELDS = new Set([
  "approvalId",
  "itemId",
  "threadId",
  "turnId",
  "startedAtMs",
  "reason",
  "command",
  "cwd",
  "commandActions",
  "environmentId",
  "kind",
  "proposedExecpolicyAmendment",
  "proposedNetworkPolicyAmendments",
  "networkApprovalContext",
  "availableDecisions",
  "additionalPermissions"
]);

const FILE_APPROVAL_FIELDS = new Set(["itemId", "threadId", "turnId", "startedAtMs", "reason", "grantRoot"]);

const COMMAND_APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);

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
    (params.reason === undefined || params.reason === null || typeof params.reason === "string") &&
    (
      params.startedAtMs === undefined ||
      (Number.isSafeInteger(params.startedAtMs) && Number(params.startedAtMs) >= 0)
    );
}

function isInsideWorkspace(workspace: string, candidate: string): boolean {
  const windowsWorkspace = /^[A-Za-z]:[\\/]/.test(workspace) || /^\\\\/.test(workspace);
  const pathApi = windowsWorkspace ? path.win32 : workspace.startsWith("/") ? path.posix : path;

  // Evaluate paths with the workspace's syntax, not the current host's. This
  // keeps Windows worktrees fail-closed when the supervisor is tested or run
  // from a non-Windows host.
  const root = pathApi.resolve(workspace);
  const resolved = pathApi.resolve(root, candidate);
  const relative = pathApi.relative(root, resolved);
  return relative === "" || (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative));
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

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => isNonEmptyString(entry));
}

function networkPolicyAmendmentIsStructured(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyFields(value, new Set(["action", "host"])) &&
    (value.action === "allow" || value.action === "deny") &&
    isNonEmptyString(value.host);
}

function availableDecisionIsStructured(value: unknown): boolean {
  if (typeof value === "string") return COMMAND_APPROVAL_DECISIONS.has(value);
  if (!isRecord(value)) return false;
  if (hasOnlyFields(value, new Set(["acceptWithExecpolicyAmendment"]))) {
    const proposal = value.acceptWithExecpolicyAmendment;
    return isRecord(proposal) &&
      hasOnlyFields(proposal, new Set(["execpolicy_amendment"])) &&
      stringArray(proposal.execpolicy_amendment);
  }
  if (hasOnlyFields(value, new Set(["applyNetworkPolicyAmendment"]))) {
    const proposal = value.applyNetworkPolicyAmendment;
    return isRecord(proposal) &&
      hasOnlyFields(proposal, new Set(["network_policy_amendment"])) &&
      networkPolicyAmendmentIsStructured(proposal.network_policy_amendment);
  }
  return false;
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
  if (!isNonEmptyString(params.cwd)) reasons.push("command approval has no workspace-bound cwd");
  if (params.commandActions !== undefined && params.commandActions !== null && !commandActionsAreStructured(params.commandActions)) {
    reasons.push("command approval has malformed commandActions");
  }
  if (
    params.approvalId !== undefined &&
    params.approvalId !== null &&
    !isNonEmptyString(params.approvalId)
  ) {
    reasons.push("command approval has malformed approvalId");
  }
  if (
    params.environmentId !== undefined &&
    params.environmentId !== null &&
    !isNonEmptyString(params.environmentId)
  ) {
    reasons.push("command approval has malformed environmentId");
  }
  if (params.kind !== undefined && params.kind !== "command" && params.kind !== "writeStdin") {
    reasons.push("command approval has an unknown kind");
  }
  if (params.kind === "writeStdin") {
    reasons.push("local supervisor does not authorize writeStdin approvals");
  }
  if (
    params.availableDecisions !== undefined &&
    params.availableDecisions !== null &&
    (
      !Array.isArray(params.availableDecisions) ||
      !params.availableDecisions.every(availableDecisionIsStructured)
    )
  ) {
    reasons.push("command approval has malformed availableDecisions");
  }
  if (
    params.proposedExecpolicyAmendment !== undefined &&
    params.proposedExecpolicyAmendment !== null &&
    !stringArray(params.proposedExecpolicyAmendment)
  ) {
    reasons.push("command approval has malformed proposedExecpolicyAmendment");
  }
  if (
    params.proposedNetworkPolicyAmendments !== undefined &&
    params.proposedNetworkPolicyAmendments !== null &&
    (
      !Array.isArray(params.proposedNetworkPolicyAmendments) ||
      !params.proposedNetworkPolicyAmendments.every(networkPolicyAmendmentIsStructured)
    )
  ) {
    reasons.push("command approval has malformed proposedNetworkPolicyAmendments");
  }
  if (params.networkApprovalContext !== undefined && params.networkApprovalContext !== null) {
    reasons.push("local supervisor does not authorize network access");
  }
  if (params.additionalPermissions !== undefined && params.additionalPermissions !== null) {
    reasons.push("local supervisor does not authorize additional permissions");
  }

  const commands = command ? [command] : [];
  if (params.commandActions !== undefined && params.commandActions !== null) {
    collectNestedCommandFields(params.commandActions, commands);
  }
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
  if (params.commandActions !== undefined && params.commandActions !== null) {
    collectNestedPathFields(params.commandActions, paths);
  }
  if (paths.some((candidate) => !isInsideWorkspace(workspace, candidate))) {
    reasons.push("command approval references a path outside the supervised workspace");
  }

  return reasons.length > 0 ? blocked(reasons) : { risk: "normal", reasons: [] };
}

function classifyFileApproval(params: Record<string, unknown>, workspace: string): RiskResult {
  const reasons: string[] = [];
  if (!hasOnlyFields(params, FILE_APPROVAL_FIELDS)) reasons.push("file approval contains unknown fields");
  if (!validCommonContext(params)) reasons.push("file approval is missing exact item/thread/turn identity");
  if (params.grantRoot !== undefined && params.grantRoot !== null && !isNonEmptyString(params.grantRoot)) {
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
