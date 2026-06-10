import { approvalHook, type ApprovalDecision } from "@/lib/workflow/hooks";
import {
  approvalBlocks,
  APPROVAL_ACTIONS,
  decodeApproval,
  escalatedBlocks,
  inputModalView,
  isSlackConfigured,
  resolvedBlocks,
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
  container?: { channel_id?: string; message_ts?: string };
  view?: {
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string }>> };
  };
};

function userName(u?: SlackUser): string {
  return u?.username ?? u?.name ?? u?.id ?? "slack";
}

async function resume(token: string, decision: ApprovalDecision) {
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

  // Button click: Approve / Deny / Provide input / Escalate
  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];

    // "View case details" is a URL button — Slack already opened the link, nothing to resume.
    if (action?.action_id === APPROVAL_ACTIONS.details) return new Response(null, { status: 200 });

    const { token, routing, details, detailsUrl, threadTs } = decodeApproval(action?.value);
    if (!token) return new Response(null, { status: 200 });

    // Provide input → open the free-text modal, keyed to the same durable token.
    if (action?.action_id === APPROVAL_ACTIONS.input) {
      if (isSlackConfigured() && payload.trigger_id) {
        await slack().views.open({ trigger_id: payload.trigger_id, view: inputModalView(token) });
      }
      return new Response(null, { status: 200 });
    }

    // Close case → end a live human handoff. Resume the suspended turn with a close signal; the
    // tool's resolve step updates this message to "Case closed".
    if (action?.action_id === APPROVAL_ACTIONS.close) {
      await resume(token, { approved: false, closed: true, by: userName(payload.user) });
      return new Response(null, { status: 200 });
    }

    // Escalate → re-post the SAME approval to the next tier and retire this message. The durable
    // run is untouched: it stays suspended on the same token — we only change who we're asking.
    if (action?.action_id === APPROVAL_ACTIONS.escalate && routing) {
      const channel = payload.container?.channel_id;
      const toLabel = routing.tiers[routing.tierIndex] ?? "next tier";
      if (isSlackConfigured() && channel) {
        // Keep the escalated message in the approval's thread (the clicked message IS the root when
        // no thread ts travelled in the button — i.e. the first message of the case).
        const root = threadTs ?? payload.container?.message_ts;
        await slack().chat.postMessage({
          channel,
          thread_ts: root,
          text: `Approval escalated to ${toLabel}`,
          blocks: approvalBlocks(details, token, { routing, detailsUrl, threadTs: root }),
        });
        if (payload.container?.message_ts) {
          await slack().chat.update({
            channel,
            ts: payload.container.message_ts,
            text: `Escalated to ${toLabel}`,
            blocks: escalatedBlocks(details, toLabel),
          });
        }
      }
      return new Response(null, { status: 200 });
    }

    // Approve / Deny → resume the durable hook, tagged with the deciding tier + escalation path.
    const approved = action?.action_id === APPROVAL_ACTIONS.approve;
    const decision: ApprovalDecision = {
      approved,
      by: userName(payload.user),
      tier: routing?.tiers[routing.tierIndex],
      escalatedFrom: routing && routing.from.length ? routing.from : undefined,
    };
    await resume(token, decision);

    // Reflect the verdict on the message that was clicked (the workflow also updates its own copy).
    if (isSlackConfigured() && payload.container?.channel_id && payload.container?.message_ts) {
      await slack().chat.update({
        channel: payload.container.channel_id,
        ts: payload.container.message_ts,
        text: approved ? "Approved" : "Denied",
        blocks: resolvedBlocks(details, decision),
      });
    }
    return new Response(null, { status: 200 });
  }

  // Modal submit: free-text input. This is NOT a decision — a reviewer asking the customer something
  // (or relaying a message in a live handoff) must never count as an approval. The agent treats
  // `needsInput` as "ask the customer, then come back for a real decision"; only the Approve button
  // resumes with approved: true. (A handoff reply just carries the note.)
  if (payload.type === "view_submission") {
    const token = payload.view?.private_metadata;
    const note = payload.view?.state?.values?.note_block?.note?.value ?? "";
    if (token) await resume(token, { approved: false, by: userName(payload.user), note, needsInput: true });
    return Response.json({ response_action: "clear" });
  }

  return new Response(null, { status: 200 });
}
