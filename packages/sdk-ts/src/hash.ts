import { internalError } from "./log.js";

/**
 * Keyed hashes of tool arguments (spec: `tool.call.data.arguments_hash`, DECISIONS D-044), the
 * same scheme as the Python SDK. The key is random per process, so the hash can't be reversed by
 * guessing small values, and equal hashes only mean something within one process (one run).
 * Needs `node:crypto`; elsewhere `hashArguments` returns undefined.
 */

/** Only this much of the serialized arguments is hashed, so a huge argument costs a bounded amount. */
export const MAX_HASHED_CHARS = 65_536;

interface Crypto {
  randomBytes(n: number): Uint8Array;
  createHmac(alg: string, key: Uint8Array): { update(data: string): { digest(enc: "hex"): string } };
}

let crypto: Crypto | null | undefined;
let key: Uint8Array | null = null;

function load(): Crypto | null {
  if (crypto !== undefined) return crypto;
  try {
    const g = globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } };
    crypto = (g.process?.getBuiltinModule?.("node:crypto") as Crypto | undefined) ?? null;
    if (crypto) key = crypto.randomBytes(32);
  } catch {
    crypto = null;
  }
  return crypto;
}

/**
 * The 16-hex-character keyed hash of a tool call's arguments, or undefined. Object keys are
 * sorted, and a string holding a JSON object or array is parsed first, so key order and
 * pre-serialized arguments don't matter. Never throws.
 */
export function hashArguments(value: unknown): string | undefined {
  try {
    const c = load();
    if (!c || !key) return undefined;
    return c.createHmac("sha256", key).update(canonical(value).slice(0, MAX_HASHED_CHARS)).digest("hex").slice(0, 16);
  } catch (err) {
    internalError("hashArguments", err);
    return undefined;
  }
}

function canonical(value: unknown): string {
  if (typeof value === "string") {
    const s = value.trim();
    if ((s.startsWith("{") || s.startsWith("[")) && s.length <= MAX_HASHED_CHARS) {
      try {
        return stable(JSON.parse(s));
      } catch {
        return value;
      }
    }
    return value;
  }
  return stable(value);
}

/** JSON with sorted object keys (matches Python's `json.dumps(sort_keys=True, separators=(",", ":"))` for plain data). */
function stable(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}
