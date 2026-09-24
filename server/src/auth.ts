import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";

/**
 * Who may do what.
 *
 * - Workspace API keys (AGENTSPACE_API_KEYS="ws:key,other:key2,*:adminkey") let SDKs ingest
 *   events and read their own workspace (e.g. to wait for an approval).
 * - The operator token (AGENTSPACE_OPERATOR_TOKEN) lets a person approve, reject, pause and
 *   cancel, and read everything. A workspace key may operate its own workspace too.
 * - Nothing configured = everything open (local development, the default).
 * - Public read-only mode (AGENTSPACE_PUBLIC_READONLY=true): anyone can read, approval payloads
 *   are hidden, and operator actions are refused, even with a token.
 */
export class Auth {
  private keys = new Map<string, Set<string>>(); // key -> workspaces ("*" = all)
  private operator: Buffer | null;
  readonly publicReadonly: boolean;

  constructor(config: Pick<Config, "apiKeys" | "operatorToken" | "publicReadonly">) {
    for (const entry of config.apiKeys.split(",").map((s) => s.trim()).filter(Boolean)) {
      const i = entry.indexOf(":");
      if (i <= 0 || i === entry.length - 1) throw new Error(`AGENTSPACE_API_KEYS entry must be workspace:key, got "${entry.slice(0, i > 0 ? i : 8)}…"`);
      const ws = entry.slice(0, i);
      const key = entry.slice(i + 1);
      const set = this.keys.get(key) ?? new Set<string>();
      set.add(ws);
      this.keys.set(key, set);
    }
    this.operator = config.operatorToken ? Buffer.from(config.operatorToken) : null;
    this.publicReadonly = config.publicReadonly;
  }

  /** Anything configured at all? */
  get enabled(): boolean {
    return this.keys.size > 0 || this.operator !== null;
  }

  /** Reads need a token (false in public mode or when nothing is configured). */
  get readRequiresAuth(): boolean {
    return this.enabled && !this.publicReadonly;
  }

  get operatorEnabled(): boolean {
    return !this.publicReadonly;
  }

  private isOperator(token: string | undefined): boolean {
    if (!token || !this.operator) return false;
    const t = Buffer.from(token);
    return t.length === this.operator.length && timingSafeEqual(t, this.operator);
  }

  private keyWorkspaces(token: string | undefined): Set<string> | undefined {
    if (!token) return undefined;
    // Constant-time comparison against every configured key.
    let found: Set<string> | undefined;
    const t = Buffer.from(token);
    for (const [key, ws] of this.keys) {
      const k = Buffer.from(key);
      if (k.length === t.length && timingSafeEqual(k, t)) found = ws;
    }
    return found;
  }

  private keyAllows(token: string | undefined, workspace: string): boolean {
    const ws = this.keyWorkspaces(token);
    return !!ws && (ws.has("*") || ws.has(workspace));
  }

  canIngest(token: string | undefined, workspace: string): boolean {
    if (this.keys.size === 0) return true;
    return this.keyAllows(token, workspace);
  }

  canRead(token: string | undefined, workspace: string): boolean {
    if (!this.readRequiresAuth) return true;
    return this.isOperator(token) || this.keyAllows(token, workspace);
  }

  /** Can list every workspace (not just the ones a key covers). */
  canReadAll(token: string | undefined): boolean {
    if (!this.readRequiresAuth) return true;
    return this.isOperator(token) || !!this.keyWorkspaces(token)?.has("*");
  }

  canOperate(token: string | undefined, workspace: string): boolean {
    if (this.publicReadonly) return false;
    if (!this.enabled) return true;
    return this.isOperator(token) || this.keyAllows(token, workspace);
  }
}

export function bearer(header: string | string[] | undefined): string | undefined {
  const h = Array.isArray(header) ? header[0] : header;
  const m = h?.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || undefined;
}
