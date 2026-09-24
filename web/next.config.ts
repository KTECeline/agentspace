import path from "node:path";
import type { NextConfig } from "next";

/** Public demo (see lib/publicDemo.ts): the browser may only talk to this origin, so it can't reach a collector. */
const PUBLIC_DEMO_HEADERS = [
  { key: "Content-Security-Policy", value: "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'; object-src 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Monorepo: trace files from the repo root so the standalone build includes workspace packages.
  outputFileTracingRoot: path.join(__dirname, ".."),
  transpilePackages: ["@agentspace/spec-types"],
  // No next/image in the app: skipping the optimizer keeps sharp and libvips out of the image.
  images: { unoptimized: true },
  async headers() {
    return process.env.AGENTSPACE_PUBLIC_DEMO === "1" ? [{ source: "/:path*", headers: PUBLIC_DEMO_HEADERS }] : [];
  },
};

export default nextConfig;
