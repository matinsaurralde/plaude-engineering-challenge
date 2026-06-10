import {
  approvalBlocks,
  humanAgentBlocks,
  humanAgentResolvedBlocks,
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

/**
 * Post a live-handoff turn to Slack. The first turn (no threadTs) creates the root message and its
 * ts becomes the thread; later turns post as replies in that same thread. Returns the message ref
 * plus the thread root ts so the caller can keep threading. Same once-only step discipline.
 */
export async function postHumanAgentToSlack(
  detail: { reason?: string; account?: string },
  token: string,
  caseId?: string,
  threadTs?: string,
): Promise<{ ref: SlackRef | null; threadTs?: string }> {
  "use step";
  if (!isSlackConfigured()) return { ref: null, threadTs };
  const channel = process.env.SLACK_APPROVAL_CHANNEL_ID as string;
  try {
    const res = await slack().chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Customer: ${detail.reason ?? "message"}`,
      blocks: humanAgentBlocks(detail, token, { detailsUrl: engineeringUrl(caseId), root: !threadTs }),
    });
    const ts = typeof res.ts === "string" ? res.ts : undefined;
    return { ref: ts ? { channel, ts } : null, threadTs: threadTs ?? ts };
  } catch (err) {
    console.error("[slack] human-agent post failed:", err instanceof Error ? err.message : err);
    return { ref: null, threadTs };
  }
}

/** Edit a live-handoff turn once the human replied or closed the case. Durable. */
export async function resolveHumanAgentMessage(
  ref: SlackRef | null,
  detail: { reason?: string },
  r: { reply?: string; by?: string; closed?: boolean },
): Promise<void> {
  "use step";
  if (!ref || !isSlackConfigured()) return;
  try {
    await slack().chat.update({
      channel: ref.channel,
      ts: ref.ts,
      text: r.closed ? "Case closed" : "Replied",
      blocks: humanAgentResolvedBlocks(detail, r),
    });
  } catch (err) {
    console.error("[slack] human-agent update failed:", err instanceof Error ? err.message : err);
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
