/**
 * Oversight policy semantics (spec/v0.1/policy.schema.json, DECISIONS D-045).
 *
 * The one TypeScript implementation, used by the collector, the web app and the TS SDK (which
 * bundles it). The Python SDK has its own (agentspace/_policy.py). Both must pass
 * spec/v0.1/examples/policy.cases.json, so change the cases first and then both sides.
 *
 * Rules:
 * - A rule matches when its glob matches the whole tool name (case-sensitive; `*` any run of
 *   characters, `?` one character) and, if it lists agents, the calling agent is one of them.
 * - A rule's action is its `action`, or its `on_findings` when the run has findings and that is
 *   stricter. Findings never relax anything.
 * - Within one policy: the strictest matching rule; the default (allow) only when none matches.
 * - Across policies (code, collector): the strictest. Ties go to the first policy, then the
 *   first rule, so the reported rule is predictable.
 * - A finding pauses the run when any policy lists its detector (or "*") in on_findings.pause
 *   and it is at least on_findings.min_severity (default warning).
 */

export type PolicyAction = "allow" | "review" | "block";
export type FindingSeverity = "info" | "warning" | "critical";
export type PolicySource = "code" | "collector";

export interface ToolRule {
  match: string;
  agents?: string[];
  action: PolicyAction;
  on_findings?: PolicyAction;
  show_arguments?: boolean;
  reason?: string;
}

export interface Policy {
  version?: 1;
  default?: PolicyAction;
  tools?: ToolRule[];
  on_findings?: { pause?: string[]; min_severity?: FindingSeverity };
}

export interface SourcedPolicy {
  source: PolicySource;
  policy: Policy;
}

export interface PolicyInput {
  tool: string;
  agent: string | null;
  /** The run has at least one detector finding. */
  escalated: boolean;
}

export interface PolicyDecision {
  action: PolicyAction;
  /** The deciding rule's `match`, or null when a default decided (or there are no policies). */
  rule: string | null;
  source: PolicySource | null;
  show_arguments: boolean;
  /** The action is stricter than the rule's own because the run has findings. */
  escalated: boolean;
  reason: string | null;
}

const RANK: Record<PolicyAction, number> = { allow: 0, review: 1, block: 2 };
const SEVERITY: Record<FindingSeverity, number> = { info: 0, warning: 1, critical: 2 };
const ACTIONS = ["allow", "review", "block"];
const SEVERITIES = ["info", "warning", "critical"];

export function evaluatePolicy(policies: SourcedPolicy[], input: PolicyInput): PolicyDecision {
  let best: PolicyDecision = { action: "allow", rule: null, source: null, show_arguments: true, escalated: false, reason: null };
  let bestRank = -1;
  for (const { source, policy } of policies) {
    let local: PolicyDecision | null = null;
    let localRank = -1;
    for (const rule of policy.tools ?? []) {
      if (!globMatch(rule.match, input.tool)) continue;
      if (rule.agents && (input.agent === null || !rule.agents.includes(input.agent))) continue;
      let action = rule.action;
      let escalated = false;
      if (input.escalated && rule.on_findings && RANK[rule.on_findings] > RANK[action]) {
        action = rule.on_findings;
        escalated = true;
      }
      if (RANK[action] > localRank) {
        localRank = RANK[action];
        local = { action, rule: rule.match, source, show_arguments: rule.show_arguments ?? true, escalated, reason: rule.reason ?? null };
      }
    }
    if (!local) {
      const action = policy.default ?? "allow";
      localRank = RANK[action];
      local = { action, rule: null, source, show_arguments: true, escalated: false, reason: null };
    }
    if (localRank > bestRank) {
      bestRank = localRank;
      best = local;
    }
  }
  return best;
}

export function shouldPause(policies: SourcedPolicy[], finding: { detector: string; severity: FindingSeverity }): boolean {
  return policies.some(({ policy }) => {
    const p = policy.on_findings;
    if (!p?.pause?.length) return false;
    if (SEVERITY[finding.severity] < SEVERITY[p.min_severity ?? "warning"]) return false;
    return p.pause.includes("*") || p.pause.includes(finding.detector);
  });
}

/** Whole-string glob: `*` any run of characters (including none), `?` exactly one. */
export function globMatch(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p++;
      n++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = n;
    } else if (star !== -1) {
      p = star + 1;
      n = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

export type ParsedPolicy = { ok: true; policy: Policy } | { ok: false; errors: { path: string; message: string }[] };

/** Validate a policy document (same rules as policy.schema.json). Errors carry a path like `tools[0].action`. */
export function parsePolicy(raw: unknown): ParsedPolicy {
  const errors: { path: string; message: string }[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const str = (v: unknown, min: number, max: number) => typeof v === "string" && v.length >= min && v.length <= max;
  const known = (o: Record<string, unknown>, keys: string[], at: string) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) err(at ? `${at}.${k}` : k, "is not a known setting");
  };

  if (!isObj(raw)) {
    err("", "a policy must be a JSON object");
    return { ok: false, errors };
  }
  known(raw, ["version", "default", "tools", "on_findings"], "");
  if (raw.version !== undefined && raw.version !== 1) err("version", "must be 1");
  if (raw.default !== undefined && !ACTIONS.includes(raw.default as string)) err("default", "must be allow, review or block");
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools) || raw.tools.length > 500) err("tools", "must be a list of at most 500 rules");
    else
      raw.tools.forEach((rule: unknown, i: number) => {
        const at = `tools[${i}]`;
        if (!isObj(rule)) return err(at, "must be an object");
        known(rule, ["match", "agents", "action", "on_findings", "show_arguments", "reason"], at);
        if (!str(rule.match, 1, 256)) err(`${at}.match`, "must be a tool name or glob (1 to 256 characters)");
        if (!ACTIONS.includes(rule.action as string)) err(`${at}.action`, "must be allow, review or block");
        if (rule.agents !== undefined && (!Array.isArray(rule.agents) || rule.agents.length < 1 || rule.agents.length > 100 || !rule.agents.every((a) => str(a, 1, 128)))) {
          err(`${at}.agents`, "must be a non-empty list of agent ids");
        }
        if (rule.on_findings !== undefined && !ACTIONS.includes(rule.on_findings as string)) err(`${at}.on_findings`, "must be allow, review or block");
        if (rule.show_arguments !== undefined && typeof rule.show_arguments !== "boolean") err(`${at}.show_arguments`, "must be true or false");
        if (rule.reason !== undefined && !str(rule.reason, 0, 500)) err(`${at}.reason`, "must be text (at most 500 characters)");
      });
  }
  if (raw.on_findings !== undefined) {
    const o = raw.on_findings;
    if (!isObj(o)) err("on_findings", "must be an object");
    else {
      known(o, ["pause", "min_severity"], "on_findings");
      if (o.pause !== undefined && (!Array.isArray(o.pause) || o.pause.length > 50 || !o.pause.every((d) => str(d, 1, 64)))) {
        err("on_findings.pause", 'must be a list of detector ids (or "*")');
      }
      if (o.min_severity !== undefined && !SEVERITIES.includes(o.min_severity as string)) err("on_findings.min_severity", "must be info, warning or critical");
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, policy: raw as Policy };
}
