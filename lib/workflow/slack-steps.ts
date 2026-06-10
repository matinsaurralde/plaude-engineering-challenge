import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
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
 * Normalise reviewer-facing text to English, deterministically. The agent is *asked* to write
 * Slack-bound fields in English, but that instruction is probabilistic — this is the guarantee:
 * whatever language the customer used, what reaches the reviewers in Slack is English. Best-effort —
 * on any failure we fall back to the original so a translation hiccup never blocks an approval. A
 * small Haiku call; it runs inside a "use step", so it's memoized and not re-run on replay.
 */
async function toEnglish(text?: string): Promise<string | undefined> {
  const t = text?.trim();
  if (!t) return text;
  try {
    const { text: out } = await generateText({
      model: anthropic("claude-haiku-4-5"),
      prompt:
        "Translate the support message below into English for an internal reviewer. If it is already " +
        "in English, return it unchanged. Keep names, amounts, currencies, account ids and order ids " +
        "exactly as written. Output only the translation, with no preamble or quotes.\n\n" + t,
    });
    return out.trim() || t;
  } catch (err) {
    console.error("[translate] toEnglish failed:", err instanceof Error ? err.message : err);
    return t;
  }
}

/**
 * Post the approval request to Slack. Marked `"use step"` so it runs exactly once and is NOT
 * replayed when the workflow resumes after the human responds (otherwise every resume would
 * post a duplicate message).
 *
 * The first approval of a case creates the thread root; every later approval round (e.g. after the
 * reviewer asked the customer something) posts as a reply in that same thread, so one case never
 * spreads across the channel. Returns the thread root ts so the caller can keep threading.
 */
export async function postApprovalToSlack(
  details: ApprovalDetails,
  token: string,
  caseId?: string,
  routing?: ApprovalRouting,
  threadTs?: string,
): Promise<{ ref: SlackRef | null; threadTs?: string; details: ApprovalDetails }> {
  "use step";
  if (!isSlackConfigured()) return { ref: null, threadTs, details };
  const channel = process.env.SLACK_APPROVAL_CHANNEL_ID as string;
  // Guarantee the reviewer reads English, whatever language the customer used.
  const [summary, action] = await Promise.all([toEnglish(details.summary), toEnglish(details.action)]);
  const en: ApprovalDetails = { summary, action, riskLevel: details.riskLevel };
  try {
    const res = await slack().chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Approval required: ${en.action ?? en.summary ?? "action"}`,
      blocks: approvalBlocks(en, token, { detailsUrl: engineeringUrl(caseId), routing, threadTs }),
    });
    const ts = typeof res.ts === "string" ? res.ts : undefined;
    return { ref: ts ? { channel, ts } : null, threadTs: threadTs ?? ts, details: en };
  } catch (err) {
    // Don't let a Slack misconfig break the run — fall back to in-app approval.
    console.error("[slack] postMessage failed:", err instanceof Error ? err.message : err);
    return { ref: null, threadTs, details: en };
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
  const reason = await toEnglish(detail.reason);
  try {
    await slack().chat.postMessage({
      channel,
      text: `Security alert: possible ${detail.type}`,
      blocks: securityAlertBlocks({ ...detail, reason }, engineeringUrl(caseId)),
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
): Promise<{ ref: SlackRef | null; threadTs?: string; detail: { reason?: string; account?: string } }> {
  "use step";
  if (!isSlackConfigured()) return { ref: null, threadTs, detail };
  const channel = process.env.SLACK_APPROVAL_CHANNEL_ID as string;
  // The relayed customer message reaches the human in English, whatever language they wrote in.
  const en = { reason: await toEnglish(detail.reason), account: detail.account };
  try {
    const res = await slack().chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Customer: ${en.reason ?? "message"}`,
      blocks: humanAgentBlocks(en, token, { detailsUrl: engineeringUrl(caseId), root: !threadTs }),
    });
    const ts = typeof res.ts === "string" ? res.ts : undefined;
    return { ref: ts ? { channel, ts } : null, threadTs: threadTs ?? ts, detail: en };
  } catch (err) {
    console.error("[slack] human-agent post failed:", err instanceof Error ? err.message : err);
    return { ref: null, threadTs, detail: en };
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
  decision: {
    approved: boolean;
    by?: string;
    note?: string;
    tier?: string;
    escalatedFrom?: string[];
    needsInput?: boolean;
  },
): Promise<void> {
  "use step";
  if (!ref || !isSlackConfigured()) return;
  try {
    await slack().chat.update({
      channel: ref.channel,
      ts: ref.ts,
      text: decision.needsInput ? "Asked the customer" : decision.approved ? "Approved" : "Denied",
      blocks: resolvedBlocks(details, decision),
    });
  } catch (err) {
    console.error("[slack] chat.update failed:", err instanceof Error ? err.message : err);
  }
}
