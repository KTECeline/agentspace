import { redirect } from "next/navigation";

/**
 * Public demo mode (the hosted site): only /demo (recordings) and /docs are served. Pages that
 * talk to a collector redirect to /demo. On Vercel, web/vercel.json does the same at the edge and
 * adds a CSP (connect-src 'self') so the browser can't reach any collector. See D-041.
 */
export const isPublicDemo = () => process.env.AGENTSPACE_PUBLIC_DEMO === "1";

/** Call first in a page that needs a collector. */
export function collectorPagesAllowed(): void {
  if (isPublicDemo()) redirect("/demo");
}
