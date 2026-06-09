import {
  approvalBlocks,
  isSlackConfigured,
  resolvedBlocks,
  securityAlertBlocks,
  slack,
  type ApprovalDetails,
  type ApprovalRouting,
} from "@/lib/slack";

export type SlackRef = { channel: string; ts: string };

/** Deep link to the Engineering view (timeline) for a case. */
function engineeringUrl(caseId?: string): string {
  const base = process.env.APP_BASE_URL || "http://localhost:3001";
  const params = new URLSearchParams({ tab: "engineering" });
  if (caseId) params.set("case", caseId);
  return `${base}/?${params.toString()}`;
}

/**
 * Post the approval request to Slack. Marked `"use step"` so it runs exactly once and is NOT
 * replayed when the workflow resumes after the human responds (otherwise every resume would
 * post a duplicate message).
 */
export async function postApprovalToSlack(
  details: ApprovalDetails,
  token: string,
  caseId?: string,
  routing?: ApprovalRouting,
): Promise<SlackRef | null> {
  "use step";
  if (!isSlackConfigured()) return null;
  const channel = process.env.SLACK_APPROVAL_CHANNEL_ID as string;
  try {
    const res = await slack().chat.postMessage({
      channel,
      text: `Approval required: ${details.action ?? details.summary ?? "action"}`,
      blocks: approvalBlocks(details, token, { detailsUrl: engineeringUrl(caseId), routing }),
    });
    return typeof res.ts === "string" ? { channel, ts: res.ts } : null;
  } catch (err) {
    // Don't let a Slack misconfig break the run — fall back to in-app approval.
    console.error("[slack] postMessage failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Post a security alert (best-effort) when the agent flags a manipulation attempt. */
export async function postSecurityAlertToSlack(
  detail: { type: string; reason?: string; quarantined?: boolean },
  caseId?: string,
): Promise<void> {
  "use step";
  if (!isSlackConfigured()) return;
  const channel = process.env.SLACK_APPROVAL_CHANNEL_ID as string;
  try {
    await slack().chat.postMessage({
      channel,
      text: `Security alert: possible ${detail.type}`,
      blocks: securityAlertBlocks(detail, engineeringUrl(caseId)),
    });
  } catch (err) {
    console.error("[slack] security alert failed:", err instanceof Error ? err.message : err);
  }
}

/** Edit the original Slack message to show the final decision (also durable). */
export async function resolveSlackMessage(
  ref: SlackRef | null,
  details: ApprovalDetails,
  decision: { approved: boolean; by?: string; note?: string; tier?: string; escalatedFrom?: string[] },
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
