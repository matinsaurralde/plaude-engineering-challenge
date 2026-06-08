import { approvalHook } from "@/lib/workflow/hooks";
import {
  APPROVAL_ACTIONS,
  inputModalView,
  isSlackConfigured,
  slack,
  verifySlackSignature,
} from "@/lib/slack";

type SlackUser = { id?: string; username?: string; name?: string };
type SlackAction = { action_id?: string; value?: string };
type SlackPayload = {
  type?: string;
  user?: SlackUser;
  trigger_id?: string;
  actions?: SlackAction[];
  view?: {
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string }>> };
  };
};

function userName(u?: SlackUser): string {
  return u?.username ?? u?.name ?? u?.id ?? "slack";
}

async function resume(token: string, decision: { approved: boolean; by?: string; note?: string }) {
  try {
    await approvalHook.resume(token, decision);
  } catch {
    // hook already resolved (timed out, or decided elsewhere) — nothing to do
  }
}

/**
 * Slack interactivity webhook. Every request is HMAC-verified before we trust it — a forged
 * "Approve" is rejected with 401. Approve/Deny buttons and the input modal all resume the same
 * durable hook the workflow is suspended on.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
  const signature = req.headers.get("x-slack-signature") ?? "";

  if (!verifySlackSignature(raw, timestamp, signature)) {
    return new Response("invalid signature", { status: 401 });
  }

  const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}") as SlackPayload;

  // Button click: Approve / Deny / Provide input
  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    const token = action?.value;
    if (!token) return new Response(null, { status: 200 });

    if (action?.action_id === APPROVAL_ACTIONS.input) {
      if (isSlackConfigured() && payload.trigger_id) {
        await slack().views.open({ trigger_id: payload.trigger_id, view: inputModalView(token) });
      }
      return new Response(null, { status: 200 });
    }

    await resume(token, {
      approved: action?.action_id === APPROVAL_ACTIONS.approve,
      by: userName(payload.user),
    });
    return new Response(null, { status: 200 });
  }

  // Modal submit: free-text input (treated as approve-with-input)
  if (payload.type === "view_submission") {
    const token = payload.view?.private_metadata;
    const note = payload.view?.state?.values?.note_block?.note?.value ?? "";
    if (token) await resume(token, { approved: true, by: userName(payload.user), note });
    return Response.json({ response_action: "clear" });
  }

  return new Response(null, { status: 200 });
}
