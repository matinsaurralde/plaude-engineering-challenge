import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // The Slack SDK uses dynamic requires; keep it external so the workflow/step bundler
  // doesn't try to inline it.
  serverExternalPackages: ["@slack/web-api"],
};

// withWorkflow installs the SWC transform that turns "use workflow" / "use step"
// functions into durable steps, and wires the local workflow runtime into Next.
export default withWorkflow(nextConfig);
