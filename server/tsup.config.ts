import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  // Bundle the workspace types package (it ships TypeScript source + the JSON schema).
  noExternal: ["@agentspace/spec-types"],
});
