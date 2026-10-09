/**
 * Policy enforcement for tool calls (DECISIONS D-045), the TypeScript side of the Python SDK's
 * `guard_tool`.
 *
 * `guardTool()` is called just before a tool runs. Allowed calls cost a local policy check. A
 * review asks a person in the office (fails closed, like every approval). A blocked or refused
 * call throws `PolicyDenied`, whose message is written for the model, so an agent can change
 * course. The rules themselves are the shared implementation in spec-types (bundled).
 */
import { evaluatePolicy, parsePolicy, type Policy, type PolicyDecision, type SourcedPolicy } from "../../spec-types/src/policy.js";
import { requestApproval, type ControlHost } from "./control.js";
import { hashArguments } from "./hash.js";
import { internalError, warnLimited } from "./log.js";
import { truncate } from "./util.js";

export type { Policy, PolicyDecision } from "../../spec-types/src/policy.js";
export type PolicyOutcome = "blocked" | "rejected" | "timeout";

const ALLOW: PolicyDecision = { action: "allow", rule: null, source: null, show_arguments: true, escalated: false, reason: null };

/** A tool call the policy blocked, or that a person didn't approve. */
export class PolicyDenied extends Error {
  override readonly name = "PolicyDenied";
  constructor(
    readonly tool: string,
    readonly outcome: PolicyOutcome,
    readonly decision: PolicyDecision,
    readonly comment?: string,
  ) {
    const rule = decision.rule ? ` (rule ${decision.rule})` : "";
    let text: string;
    if (outcome === "blocked") text = `${tool} is blocked by policy${rule}${decision.reason ? `: ${decision.reason}` : ""}`;
    else if (outcome === "rejected") text = `${tool} was rejected by an operator${comment ? `: ${comment}` : ""}`;
    else text = `${tool} wasn't approved in time`;
    super(`${/[.!?]$/.test(text) ? text : `${text}.`} Don't retry it; choose another way or report back.`);
  }
}

/** True for a `PolicyDenied` error. */
export function isPolicyDenied(err: unknown): err is PolicyDenied {
  return err instanceof PolicyDenied || (err instanceof Error && err.name === "PolicyDenied");
}

export interface GuardOptions {
  /** How long a review may wait for a person. Default 300 000 (5 minutes). */
  timeoutMs?: number;
  runId?: string;
  agentId?: string;
  teamId?: string | null;
}

/** What the policy code needs from the SDK client. */
export interface OversightHost extends ControlHost {
  readonly escalated: Set<string>;
  policies(): SourcedPolicy[];
  ensurePolicy(): Promise<void>;
  /** The team of an agent this process knows (the current agent's when none is given). */
  teamOf(agentId: string | undefined): string | null;
}

/** Validate a code policy. Anything wrong fails closed: every tool call then needs review. */
export function loadPolicy(raw: unknown): Policy {
  const parsed = parsePolicy(raw);
  if (!parsed.ok) {
    console.error(`[agentspace] invalid policy, so every tool call will need review: ${parsed.errors.map((e) => `${e.path || "(top)"} ${e.message}`).join("; ")}`);
    return { default: "review" };
  }
  if (parsed.policy.on_findings?.pause?.length) {
    warnLimited("policy-pause-in-code", "on_findings.pause only works in the collector's policy (AGENTSPACE_POLICY_FILE); it's ignored in code");
  }
  return parsed.policy;
}

/** What the policy says about this call, without asking anyone. Never throws. */
export async function decide(host: OversightHost | null, tool: string, opts: GuardOptions = {}): Promise<PolicyDecision> {
  if (!host || !host.enabled) return ALLOW;
  let policies = host.policies();
  try {
    await host.ensurePolicy();
    policies = host.policies();
    if (!policies.length) return ALLOW;
    const agent = opts.agentId ?? host.currentAgentId() ?? null;
    const runId = opts.runId ?? host.currentRunId();
    return evaluatePolicy(policies, { tool, agent, escalated: !!runId && host.escalated.has(runId) });
  } catch (err) {
    internalError("policy.decide", err);
    // Fails closed when there is a policy to honour.
    return policies.length ? { ...ALLOW, action: "review", reason: "the policy couldn't be checked" } : ALLOW;
  }
}

export async function guardTool(host: OversightHost | null, tool: string, args: unknown, opts: GuardOptions = {}): Promise<PolicyDecision> {
  const decision = await decide(host, tool, opts);
  if (decision.action === "allow" || !host) return decision;
  const who = {
    runId: opts.runId ?? host.currentRunId(),
    agentId: opts.agentId ?? host.currentAgentId(),
    teamId: opts.teamId !== undefined ? opts.teamId : host.teamOf(opts.agentId ?? host.currentAgentId()),
  };
  if (decision.action === "block") throw record(host, new PolicyDenied(tool, "blocked", decision), who);

  let payload: Record<string, unknown> = { tool };
  let policy: Record<string, unknown> = { tool: truncate(tool, 256), action: "review" };
  let reason = tool;
  try {
    if (decision.show_arguments) payload.arguments = host.redactValue("tool.arguments", args);
    policy = {
      ...policy,
      rule: decision.rule ?? undefined,
      source: decision.source ?? undefined,
      reason: decision.reason ?? undefined,
      escalated: decision.escalated || undefined,
      arguments_hash: hashArguments(args),
    };
    // Escalation travels in policy.escalated; the office says it next to the evidence.
    reason = `Run ${tool}?${decision.reason ? ` ${decision.reason}` : ""}`;
  } catch (err) {
    internalError("guardTool", err);
    payload = { tool };
  }
  const result = await requestApproval(host, reason, payload, { timeoutMs: opts.timeoutMs, runId: who.runId, agentId: who.agentId, teamId: who.teamId }, JSON.parse(JSON.stringify(policy)) as Record<string, unknown>);
  if (result.approved) return decision;
  throw record(host, new PolicyDenied(tool, result.decision === "timeout" ? "timeout" : "rejected", decision, result.comment ?? result.error), who);
}

/** Every denial is an `error` event (kind PolicyDenied), so it shows in the office. */
function record(host: OversightHost, denied: PolicyDenied, who: { runId?: string; agentId?: string; teamId?: string | null }): PolicyDenied {
  try {
    const fields: Record<string, unknown> = { summary: truncate(denied.message, 500) };
    if (who.runId) fields.runId = who.runId;
    if (who.agentId) {
      fields.agentId = who.agentId;
      fields.teamId = who.teamId ?? null;
    }
    host.emit("error", { message: truncate(denied.message, 2000), kind: "PolicyDenied" }, fields);
  } catch (err) {
    internalError("policy.record", err);
  }
  return denied;
}
