import path from "node:path";

const BLOCKED_PATTERNS: Array<[RegExp, string]> = [
  [/\bsudo\b/i, "privilege escalation"],
  [/git\s+push\s+.*(?:--force|-f)\b/i, "force push"],
  [/git\s+reset\s+--hard\b/i, "destructive git reset"],
  [/git\s+clean\s+.*-[^\s]*[fdx][^\s]*/i, "destructive git clean"],
  [/\brm\s+-[^\s]*r[^\s]*f[^\s]*\s+\/(?:\s|$)/i, "recursive deletion of filesystem root"],
  [/\bmkfs(?:\.|\s)/i, "filesystem formatting"],
  [/\bdd\s+if=/i, "raw block copy"],
  [/\bshutdown\b|\breboot\b/i, "host shutdown/reboot"],
  [/(?:curl|wget)[^\n|]*\|\s*(?:sh|bash|zsh|powershell)\b/i, "pipe remote content into a shell"],
  [/\bInvoke-Expression\b|\biex\s*\(/i, "PowerShell dynamic execution"]
];

export interface RiskResult {
  risk: "normal" | "blocked";
  reasons: string[];
}

function collectPathLikeValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectPathLikeValues(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectPathLikeValues(v, out);
  }
}

export function classifyApproval(params: Record<string, unknown>, workspace: string): RiskResult {
  const text = JSON.stringify(params);
  const reasons = BLOCKED_PATTERNS.filter(([re]) => re.test(text)).map(([, reason]) => reason);

  const candidates: string[] = [];
  collectPathLikeValues(params, candidates);
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (normalized !== workspace && !normalized.startsWith(workspace + path.sep)) {
      // Only treat paths as hard blockers when the approval looks like a write/change request.
      if (/fileChange|write|delete|remove|patch|grantRoot/i.test(text)) {
        reasons.push(`write-capable approval references path outside workspace: ${candidate}`);
      }
    }
  }

  return { risk: reasons.length ? "blocked" : "normal", reasons: [...new Set(reasons)] };
}
