import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import schema from "@agentspace/spec-types/schema.json" with { type: "json" };
import type { AgentSpaceEvent } from "@agentspace/spec-types";

// ajv-formats is CJS: depending on the loader, the plugin is the default export or its `.default`.
const formatsExport = addFormatsModule as unknown as FormatsPlugin & { default?: FormatsPlugin };
const addFormats: FormatsPlugin = formatsExport.default ?? formatsExport;

const ajv = new Ajv2020({ allErrors: false, strict: false });
addFormats(ajv);
const validateFn = ajv.compile<AgentSpaceEvent>(schema);

export function validateEvent(ev: unknown): { ok: true; event: AgentSpaceEvent } | { ok: false; message: string } {
  if (validateFn(ev)) return { ok: true, event: ev };
  const e = validateFn.errors?.[0];
  // oneOf errors are noisy; report the most specific one.
  const specific = validateFn.errors?.find((x) => x.keyword !== "oneOf" && x.keyword !== "const") ?? e;
  return { ok: false, message: specific ? `${specific.instancePath || "/"} ${specific.message}` : "invalid event" };
}
