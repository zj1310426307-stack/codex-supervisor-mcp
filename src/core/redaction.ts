export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_FRAGMENTS = [
  "authorization",
  "cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "clientsecret"
] as const;

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function redactAssignment(match: string, prefix: string): string {
  const leadingNewline = match.startsWith("\n") ? "\n" : "";
  return `${leadingNewline}${prefix}${REDACTED}`;
}

/** Redact credential-shaped fragments from free text before logging or persistence. */
export function redactText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      REDACTED
    )
    .replace(
      /\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi,
      (_match, prefix: string) => `${prefix}${REDACTED}`
    )
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, REDACTED)
    .replace(
      /"([^"\\]*(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret)[^"\\]*)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
      (_match, key: string) => `"${key}": "${REDACTED}"`
    )
    .replace(
      /\b(cookie\s*[:=]\s*)[^\r\n]+/gi,
      (_match, prefix: string) => `${prefix}${REDACTED}`
    )
    .replace(
      /\b((?:password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;]+)/gi,
      (_match, prefix: string) => `${prefix}${REDACTED}`
    )
    .replace(
      /(^|\s)(--(?:password|passwd|token|api-key|api_key|secret|client-secret|private-key)(?:=|\s+))\S+/gi,
      (_match, whitespace: string, prefix: string) => `${whitespace}${prefix}${REDACTED}`
    )
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{8,}|gh[opusr]_[A-Za-z0-9]{8,})\b/g, REDACTED)
    .replace(
      /(?:^|\n)(\s*[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CLIENT_SECRET)[A-Za-z0-9_]*\s*=\s*)[^\r\n]*/g,
      redactAssignment
    );
}

/** Recursively redact sensitive keys and strings, including cyclic structures. */
export function redact<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (entry: unknown, key?: string): unknown => {
    if (key && isSensitiveKey(key)) return REDACTED;
    if (typeof entry === "string") return redactText(entry);
    if (!entry || typeof entry !== "object") return entry;
    if (entry instanceof Date) return entry.toISOString();
    if (seen.has(entry)) return "[CIRCULAR]";
    seen.add(entry);
    if (Array.isArray(entry)) return entry.map((item) => visit(item));
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(entry as Record<string, unknown>)) {
      output[childKey] = visit(child, childKey);
    }
    return output;
  };
  return visit(value) as T;
}

function unicodeSafePrefix(value: string, length: number): string {
  let end = Math.max(0, length);
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** Redact first, then produce bounded output without splitting a surrogate pair. */
export function redactAndTruncate(value: string, maxChars: number): { text: string; truncated: boolean } {
  const safe = redactText(value);
  if (safe.length <= maxChars) return { text: safe, truncated: false };
  if (maxChars <= 0) return { text: "", truncated: true };
  const marker = "\n... [truncated]";
  if (maxChars <= marker.length) return { text: unicodeSafePrefix(marker, maxChars), truncated: true };
  return {
    text: `${unicodeSafePrefix(safe, maxChars - marker.length)}${marker}`,
    truncated: true
  };
}
