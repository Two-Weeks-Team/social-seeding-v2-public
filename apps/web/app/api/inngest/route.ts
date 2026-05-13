import { serve } from "inngest/next";
import { inngest, functions } from "@ss/workflows";

/**
 * Single endpoint Inngest calls to run/replay every workflow function.
 * In dev, the Inngest Dev Server (`npx inngest-cli dev`) discovers this route.
 * In prod (Vercel), Inngest Cloud invokes it. If the execution model ever
 * outgrows serverless, the same `functions` array moves into a standalone
 * `apps/worker` with zero workflow-code changes.
 */
export const { GET, POST, PUT } = serve({ client: inngest, functions });
