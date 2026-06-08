import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  /* config options here */
};

// withWorkflow installs the SWC transform that turns "use workflow" / "use step"
// functions into durable steps, and wires the local workflow runtime into Next.
export default withWorkflow(nextConfig);
