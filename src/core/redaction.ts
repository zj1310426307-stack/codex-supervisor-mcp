const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret)(?:$|[_-])/i;
const VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bBasic\s+[A-Za-z0-9+/=]+/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*([^\s,;]+)/gi,
  /"(?:authorization|cookie|password|secret|token|api[_-]?key|private[_-]?key)"\s*:\s*"[^"]*"/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
  /(?:^|\s)--(?:password|token|api-key|secret)(?:=|\s+)\S+/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /(?:^|\n)([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)\s*=\s*[^\r\n]*/g
];

/** Redact credential-shaped fragments from free text before logging or persistence. */
export function redactText(value: string): string {
  let output = value;
  for (const pattern of VALUE_PATTERNS) {
    output = output.replace(pattern, (match, prefix: string | undefined) => {
      if (pattern.source.includes("[A-Z][A-Z0-9_]*")) return `${match.startsWith("\n") ? "\n" : ""}${prefix}=${REDACTED}`;
      if (match.startsWith('"')) return match.replace(/:\s*"[^"]*"$/, `: "${REDACTED}"`);
      if (/^(?:gh[pousr]_|sk-)/.test(match)) return REDACTED;
      return match
        .replace(/(:=|=|\s+)([^\s,;]+)$/u, `$1${REDACTED}`)
        .replace(/Bearer\s+.*/i, `Bearer ${REDACTED}`)
        .replace(/Basic\s+.*/i, `Basic ${REDACTED}`);
    });
  }
  return output;
}

/** Recursively redact sensitive keys and strings, including cyclic structures. */
export function redact<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (entry: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key)) return REDACTED;
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

/** Produce bounded redacted output without splitting surrogate pairs intentionally. */
export function redactAndTruncate(value: string, maxChars: number): { text: string; truncated: boolean } {
  const safe = redactText(value);
  if (safe.length <= maxChars) return { text: safe, truncated: false };
  if (maxChars <= 0) return { text: "", truncated: true };
  const marker = "\n... [truncated]";
  if (maxChars <= marker.length) return { text: marker.slice(0, maxChars), truncated: true };
  return { text: `${safe.slice(0, maxChars - marker.length)}${marker}`, truncated: true };
}
