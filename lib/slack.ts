import crypto from "node:crypto";
import { WebClient, type KnownBlock, type ModalView } from "@slack/web-api";

export type ApprovalDetails = {
  summary?: string;
  action?: string;
  riskLevel?: string;
};

export const APPROVAL_ACTIONS = {
  approve: "approval_approve",
  deny: "approval_deny",
  input: "approval_input",
  details: "approval_details", // URL button — opens the Engineering view, no decision
} as const;

export const INPUT_MODAL_CALLBACK = "approval_input_modal";

/** Slack is optional — without it the in-app approval card still drives the same hook. */
export function isSlackConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APPROVAL_CHANNEL_ID);
}

let client: WebClient | null = null;
export function slack(): WebClient {
  if (!client) client = new WebClient(process.env.SLACK_BOT_TOKEN);
  return client;
}

/**
 * Verify the Slack request signature (HMAC-SHA256 over `v0:timestamp:body`).
 * This is what stops anyone from forging an "Approve" event — done correctly, with a
 * timestamp window and a constant-time compare.
 */
export function verifySlackSignature(rawBody: string, timestamp: string, signature: string): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret || !timestamp || !signature) return false;

  // Reject stale requests (replay protection).
  const fiveMinutes = 60 * 5;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > fiveMinutes) return false;

  const expected = "v0=" + crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false; // length mismatch / malformed signature
  }
}

const RISK_EMOJI: Record<string, string> = { high: "🔴", medium: "🟠", low: "🟢" };

export function approvalBlocks(d: ApprovalDetails, token: string, detailsUrl?: string): KnownBlock[] {
  const risk = d.riskLevel ?? "medium";
  return [
    { type: "header", text: { type: "plain_text", text: "🔒 Approval required", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*${d.summary ?? d.action ?? "Action needs sign-off"}*` } },
    ...(d.action
      ? [{ type: "section" as const, text: { type: "mrkdwn" as const, text: `Action: ${d.action}` } }]
      : []),
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `${RISK_EMOJI[risk] ?? "⚪"} Risk: *${risk}*` }],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: APPROVAL_ACTIONS.approve,
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          value: token,
        },
        {
          type: "button",
          action_id: APPROVAL_ACTIONS.deny,
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          value: token,
        },
        {
          type: "button",
          action_id: APPROVAL_ACTIONS.input,
          text: { type: "plain_text", text: "Provide input" },
          value: token,
        },
        ...(detailsUrl
          ? [
              {
                type: "button" as const,
                action_id: APPROVAL_ACTIONS.details,
                text: { type: "plain_text" as const, text: "View case details" },
                url: detailsUrl,
              },
            ]
          : []),
      ],
    },
  ];
}

export function resolvedBlocks(
  d: ApprovalDetails,
  decision: { approved: boolean; by?: string; note?: string },
): KnownBlock[] {
  const verdict = decision.approved ? "✅ Approved" : "❌ Denied";
  const by = decision.by ? ` by *${decision.by}*` : "";
  const note = decision.note ? `\n> ${decision.note}` : "";
  return [
    { type: "section", text: { type: "mrkdwn", text: `*${d.summary ?? d.action ?? "Approval"}*` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `${verdict}${by}${note}` }] },
  ];
}

export function inputModalView(token: string): ModalView {
  return {
    type: "modal",
    callback_id: INPUT_MODAL_CALLBACK,
    private_metadata: token,
    title: { type: "plain_text", text: "Provide input" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "note_block",
        label: { type: "plain_text", text: "Input / note for the agent" },
        element: { type: "plain_text_input", action_id: "note", multiline: true },
      },
    ],
  };
}
