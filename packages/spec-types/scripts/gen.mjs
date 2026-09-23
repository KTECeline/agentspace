// Generates src/generated.ts and src/schema.json from spec/v0.1/event.schema.json.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const root = new URL("../../../", import.meta.url);
const schemaPath = fileURLToPath(new URL("spec/v0.1/event.schema.json", root));
const outDir = new URL("../src/", import.meta.url);

const raw = await readFile(schemaPath, "utf8");
const schema = JSON.parse(raw);

const ts = await compile(structuredClone(schema), "AgentSpaceEvent", {
  bannerComment:
    "/* eslint-disable */\n/** GENERATED from spec/v0.1/event.schema.json by scripts/gen.mjs. Do not edit. */",
  unreachableDefinitions: true,
  additionalProperties: false,
  style: { singleQuote: false },
});

await writeFile(new URL("generated.ts", outDir), ts);
await writeFile(new URL("schema.json", outDir), JSON.stringify(schema, null, 2) + "\n");
console.log("spec-types: wrote src/generated.ts and src/schema.json");
