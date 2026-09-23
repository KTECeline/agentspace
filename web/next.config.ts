import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Monorepo: trace files from the repo root so the standalone build includes workspace packages.
  outputFileTracingRoot: path.join(__dirname, ".."),
  transpilePackages: ["@agentspace/spec-types"],
};

export default nextConfig;
