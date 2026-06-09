import {
  approvalBlocks,
  isSlackConfigured,
  resolvedBlocks,
  slack,
  type ApprovalDetails,
} from "@/lib/slack";

export type SlackRef = { channel: string; ts: string };

/**
 * Post the approval request to Slack. Marked `"use step"` so it runs exactly once and is NOT
 * replayed when the workflow resumes after the human responds (otherwise every resume would
 * post a duplicate message).
 */
export async function postApprovalToSlack(
  details: ApprovalDetails,
  token: string,
): Promise<SlackRef | null> {
  "use step";
  if (!isSlackConfigured()) return null;
  const channel = process.env.SLACK_APPROVAL_CHANNEL_ID as string;
  try {
    const res = await slack().chat.postMessage({
      channel,
      text: `Approval required: ${details.action ?? details.summary ?? "action"}`,
      blocks: approvalBlocks(details, token),
    });
    return typeof res.ts === "string" ? { channel, ts: res.ts } : null;
  } catch (err) {
    // Don't let a Slack misconfig break the run — fall back to in-app approval.
    console.error("[slack] postMessage failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Edit the original Slack message to show the final decision (also durable). */
export async function resolveSlackMessage(
  ref: SlackRef | null,
  details: ApprovalDetails,
  decision: { approved: boolean; by?: string; note?: string },
): Promise<void> {
  "use step";
  if (!ref || !isSlackConfigured()) return;
  try {
    await slack().chat.update({
      channel: ref.channel,
      ts: ref.ts,
      text: decision.approved ? "Approved" : "Denied",
      blocks: resolvedBlocks(details, decision),
    });
  } catch (err) {
    console.error("[slack] chat.update failed:", err instanceof Error ? err.message : err);
  }
}
