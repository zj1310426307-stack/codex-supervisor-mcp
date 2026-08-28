import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Config } from "../config.js";

export type RequestSecurityDecision =
  | { allowed: true }
  | { allowed: false; status: 400 | 401 | 403; reason: "invalid_host" | "host_forbidden" | "origin_forbidden" | "unauthorized" };

function equalSecret(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

export function parseHostHeader(header: string | undefined): string | undefined {
  if (!header || /[\s/@\\]/.test(header)) return undefined;
  if (header.startsWith("[")) {
    const end = header.indexOf("]");
    if (end < 2 || (header.length > end + 1 && !/^:\d+$/.test(header.slice(end + 1)))) return undefined;
    return header.slice(1, end).toLowerCase();
  }
  const colonCount = [...header].filter((char) => char === ":").length;
  if (colonCount > 1) return undefined;
  const host = colonCount === 1 ? header.slice(0, header.lastIndexOf(":")) : header;
  const port = colonCount === 1 ? header.slice(header.lastIndexOf(":") + 1) : undefined;
  if (!host || (port !== undefined && (!/^\d+$/.test(port) || Number(port) > 65_535))) return undefined;
  return host.toLowerCase().replace(/\.$/, "");
}

function normalizeAllowedHost(candidate: string): string | undefined {
  const parsed = parseHostHeader(candidate);
  if (parsed) return parsed;
  const bare = candidate.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return bare.includes(":") && !/[\s/@\\]/.test(bare) ? bare : undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer ([^\s,]+)$/i.exec(header);
  return match?.[1];
}

export function evaluateRequestSecurity(
  request: Pick<IncomingMessage, "headers">,
  config: Pick<Config, "allowedHosts" | "allowedOrigins" | "bearerToken">,
  requireAuthentication: boolean
): RequestSecurityDecision {
  const host = parseHostHeader(request.headers.host);
  if (!host) return { allowed: false, status: 400, reason: "invalid_host" };
  if (config.allowedHosts.length > 0) {
    const allow = config.allowedHosts.some((candidate) => normalizeAllowedHost(candidate) === host);
    if (!allow) return { allowed: false, status: 403, reason: "host_forbidden" };
  }

  const origin = request.headers.origin;
  if (origin && (origin === "null" || config.allowedOrigins.length === 0 || !config.allowedOrigins.includes(origin))) {
    return { allowed: false, status: 403, reason: "origin_forbidden" };
  }

  if (!requireAuthentication || !config.bearerToken) return { allowed: true };
  const actual = bearerToken(request.headers.authorization);
  if (!actual || !equalSecret(config.bearerToken, actual)) {
    return { allowed: false, status: 401, reason: "unauthorized" };
  }
  return { allowed: true };
}

interface RateBucket {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private operations = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("rate limit must be a positive integer");
    if (!Number.isInteger(windowMs) || windowMs <= 0) throw new Error("rate window must be a positive integer");
  }

  take(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    const current = this.buckets.get(key);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + this.windowMs }
      : current;
    bucket.count += 1;
    this.buckets.set(key, bucket);
    this.operations += 1;
    if (this.operations % 256 === 0) this.prune(now);
    return {
      allowed: bucket.count <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000))
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }
}
