import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * `tool.call.data.arguments_hash` for OTLP spans, the same scheme as the SDKs (D-044): HMAC-SHA256
 * with a random key per collector process over sorted-key JSON, first 16 hex characters. OTLP
 * spans carry the arguments only when the app records them; the hash is taken before content is
 * dropped, so repeats are detectable without storing anything.
 */
const KEY = randomBytes(32);

export function hashArguments(value: unknown): string | undefined {
  try {
    const text = canonical(value, (str) => createHash("sha256").update(str).digest("hex"));
    return createHmac("sha256", KEY).update(text).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

/** Long strings become a digest of their first MAX_STRING_CHARS characters; nested structures are
 * read up to MAX_NODES values. Arguments that differ only beyond those limits hash the same. */
const MAX_STRING_CHARS = 262_144;
const MAX_NODES = 500;
const SHORT = 256;
const MAX_DEPTH = 32;

function canonical(value: unknown, digest: (s: string) => string): string {
  let v = value;
  if (typeof v === "string") {
    const s = v.trim();
    if ((s.startsWith("{") || s.startsWith("[")) && s.length <= MAX_STRING_CHARS) {
      try {
        v = JSON.parse(s);
      } catch {
        // not JSON: hash the string itself
      }
    }
  }
  const out: string[] = [];
  const budget = { left: MAX_NODES };
  write(v, 0, out, budget, digest);
  return out.join("");
}

/** Sorted-key compact JSON; long strings become `#<length>:<digest>`. */
function write(v: unknown, depth: number, out: string[], budget: { left: number }, digest: (s: string) => string): void {
  if (--budget.left < 0) return;
  if (v === undefined || v === null) out.push("null");
  else if (typeof v === "string") out.push(v.length <= SHORT ? JSON.stringify(v) : `#${v.length}:${digest(v.slice(0, MAX_STRING_CHARS))}`);
  else if (typeof v === "number" || typeof v === "boolean") out.push(JSON.stringify(v));
  else if (typeof v !== "object" || depth >= MAX_DEPTH) write(String(v), depth, out, budget, digest);
  else if (Array.isArray(v)) {
    out.push("[");
    for (let i = 0; i < v.length && budget.left >= 0; i++) {
      if (i) out.push(",");
      write(v[i], depth + 1, out, budget, digest);
    }
    out.push("]");
  } else {
    const o = v as Record<string, unknown>;
    const all = Object.keys(o).filter((k) => o[k] !== undefined);
    // Sorting a huge object would cost more than the budget lets us read; keep its order then.
    const keys = all.length <= MAX_NODES ? all.sort() : all.slice(0, MAX_NODES);
    out.push("{");
    keys.forEach((k, i) => {
      if (budget.left < 0) return;
      out.push(`${i ? "," : ""}${JSON.stringify(k)}:`);
      write(o[k], depth + 1, out, budget, digest);
    });
    out.push("}");
  }
}
