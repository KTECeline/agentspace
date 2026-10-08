import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { evaluatePolicy, globMatch, parsePolicy, shouldPause, type FindingSeverity, type PolicyInput, type SourcedPolicy } from "@agentspace/spec-types";

/** The shared cases (D-045): the Python SDK runs the same file (tests/test_policy.py). */
const cases = JSON.parse(readFileSync(fileURLToPath(new URL("../../spec/v0.1/examples/policy.cases.json", import.meta.url)), "utf8")) as {
  evaluate: { name: string; policies: SourcedPolicy[]; input: PolicyInput; expect: unknown }[];
  pause: { name: string; policies: SourcedPolicy[]; finding: { detector: string; severity: FindingSeverity }; expect: boolean }[];
  invalid: { name: string; policy: unknown; path: string }[];
  valid: unknown[];
};
const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../../spec/v0.1/policy.schema.json", import.meta.url)), "utf8")) as object;

describe("policy conformance (spec/v0.1/examples/policy.cases.json)", () => {
  it.each(cases.evaluate.map((c) => [c.name, c] as const))("evaluate: %s", (_n, c) => {
    expect(evaluatePolicy(c.policies, c.input)).toEqual(c.expect);
  });
  it.each(cases.pause.map((c) => [c.name, c] as const))("pause: %s", (_n, c) => {
    expect(shouldPause(c.policies, c.finding)).toBe(c.expect);
  });
  it.each(cases.invalid.map((c) => [c.name, c] as const))("invalid: %s", (_n, c) => {
    const out = parsePolicy(c.policy);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.map((e) => e.path)).toContain(c.path);
  });
  it("accepts the valid examples and every policy used in the cases", () => {
    for (const p of [...cases.valid, ...cases.evaluate.flatMap((c) => c.policies.map((s) => s.policy))]) expect(parsePolicy(p)).toEqual({ ok: true, policy: p });
  });
  it("agrees with policy.schema.json on every valid and invalid document", () => {
    const validate = new Ajv2020({ strict: false }).compile(schema);
    for (const p of cases.valid) expect(validate(p), JSON.stringify(p)).toBe(true);
    for (const c of cases.invalid) expect(validate(c.policy), c.name).toBe(false);
  });
  it("globs: * spans anything, ? one character, nothing else is special", () => {
    expect(globMatch("*", "")).toBe(true);
    expect(globMatch("a*b*c", "aXXbYYc")).toBe(true);
    expect(globMatch("a*b*c", "aXXbYY")).toBe(false);
    expect(globMatch("**x", "abx")).toBe(true);
    expect(globMatch("[ab]", "a")).toBe(false);
  });
});
