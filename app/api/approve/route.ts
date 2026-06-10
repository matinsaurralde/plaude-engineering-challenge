import { approvalHook } from "@/lib/workflow/hooks";

/**
 * Resume a suspended approval. The token is the tool call id of the pending
 * `requestHumanApproval` call. In Phase 2 this is driven by the in-app Approve/Deny
 * buttons; in Phase 3 the Slack webhook resumes the very same hook.
 */
export async function POST(req: Request) {
  const { token, approved, note, by, closed } = (await req.json()) as {
    token?: string;
    approved?: boolean;
    note?: string;
    by?: string;
    closed?: boolean;
  };

  if (!token || typeof approved !== "boolean") {
    return Response.json({ error: "token and approved are required" }, { status: 400 });
  }

  await approvalHook.resume(token, { approved, note, by: by ?? "in-app", closed: closed || undefined });
  return Response.json({ ok: true });
}
