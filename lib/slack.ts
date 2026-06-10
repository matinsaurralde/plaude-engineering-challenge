import crypto from "node:crypto";
import { WebClient, type KnownBlock, type ModalView } from "@slack/web-api";

export type ApprovalDetails = {
  summary?: string;
  action?: string;
  riskLevel?: string;
};

/** Where an approval currently sits in the escalation ladder. Travels inside the Slack button value. */
export type ApprovalRouting = {
  tiers: string[]; // ordered ladder, low → high
  tierIndex: number; // current tier (0-based)
  from: string[]; // tier labels it was escalated through to reach here
};

type BtnPayload = {
  t: string;
  x: string[];
  i: number;
  f: string[];
  s?: string;
  a?: string;
  r?: string;
  u?: string;
  h?: string; // Slack thread root ts — keeps escalations in the same thread as the approval
};

function encodeBtn(p: BtnPayload): string {
  // Slack action `value` is capped at 2000 chars — clip the free-text fields defensively.
  return JSON.stringify({ ...p, s: p.s?.slice(0, 220), a: p.a?.slice(0, 160) });
}

/** Decode a Slack action `value`. Tolerates a bare token (older / simple buttons). */
export function decodeApproval(value?: string): {
  token?: string;
  routing?: ApprovalRouting;
  details: ApprovalDetails;
  detailsUrl?: string;
  threadTs?: string;
} {
  if (value) {
    try {
      const o = JSON.parse(value) as Partial<BtnPayload>;
      if (o && typeof o.t === "string") {
        return {
          token: o.t,
          routing: {
            tiers: Array.isArray(o.x) ? o.x : [],
            tierIndex: typeof o.i === "number" ? o.i : 0,
            from: Array.isArray(o.f) ? o.f : [],
          },
          details: { summary: o.s, action: o.a, riskLevel: o.r },
          detailsUrl: typeof o.u === "string" ? o.u : undefined,
          threadTs: typeof o.h === "string" ? o.h : undefined,
        };
      }
    } catch {
      // not JSON — treat as a bare token
    }
  }
  return { token: value, details: {} };
}

export const APPROVAL_ACTIONS = {
  approve: "approval_approve",
  deny: "approval_deny",
  input: "approval_input",
  escalate: "approval_escalate", // re-route the same approval up a tier (from Slack)
  close: "approval_close", // end a live human handoff session
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

export function approvalBlocks(
  d: ApprovalDetails,
  token: string,
  opts: { detailsUrl?: string; routing?: ApprovalRouting; threadTs?: string } = {},
): KnownBlock[] {
  const risk = d.riskLevel ?? "medium";
  const routing = opts.routing;
  const cur = Math.min(routing?.tierIndex ?? 0, Math.max((routing?.tiers.length ?? 1) - 1, 0));
  const tierLabel = routing && routing.tiers.length ? routing.tiers[cur] : undefined;
  const canEscalate = !!routing && cur < routing.tiers.length - 1;

  const base: BtnPayload = {
    t: token,
    x: routing?.tiers ?? [],
    i: cur,
    f: routing?.from ?? [],
    s: d.summary,
    a: d.action,
    r: d.riskLevel,
    u: opts.detailsUrl,
    h: opts.threadTs,
  };
  const value = routing ? encodeBtn(base) : token;
  const escalateValue =
    canEscalate && routing && tierLabel
      ? encodeBtn({ ...base, i: cur + 1, f: [...routing.from, tierLabel] })
      : undefined;

  const context: { type: "mrkdwn"; text: string }[] = [
    { type: "mrkdwn", text: `${RISK_EMOJI[risk] ?? "⚪"} Risk: *${risk}*` },
  ];
  if (tierLabel) context.push({ type: "mrkdwn", text: `👤 Approver: *Tier ${cur + 1} · ${tierLabel}*` });
  if (routing && routing.from.length)
    context.push({ type: "mrkdwn", text: `⤴ Escalated from ${routing.from.join(" → ")}` });

  return [
    { type: "header", text: { type: "plain_text", text: "🔒 Approval required", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*${d.summary ?? d.action ?? "Action needs sign-off"}*` } },
    ...(d.action
      ? [{ type: "section" as const, text: { type: "mrkdwn" as const, text: `Action: ${d.action}` } }]
      : []),
    { type: "context", elements: context },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: APPROVAL_ACTIONS.approve, style: "primary", text: { type: "plain_text", text: "Approve" }, value },
        { type: "button", action_id: APPROVAL_ACTIONS.deny, style: "danger", text: { type: "plain_text", text: "Deny" }, value },
        { type: "button", action_id: APPROVAL_ACTIONS.input, text: { type: "plain_text", text: "Ask the customer" }, value },
        ...(escalateValue
          ? [
              {
                type: "button" as const,
                action_id: APPROVAL_ACTIONS.escalate,
                text: { type: "plain_text" as const, text: `Escalate ⤴ ${routing!.tiers[cur + 1]}` },
                value: escalateValue,
              },
            ]
          : []),
        ...(opts.detailsUrl
          ? [
              {
                type: "button" as const,
                action_id: APPROVAL_ACTIONS.details,
                text: { type: "plain_text" as const, text: "View case details" },
                url: opts.detailsUrl,
              },
            ]
          : []),
      ],
    },
  ];
}

export function resolvedBlocks(
  d: ApprovalDetails,
  decision: {
    approved: boolean;
    by?: string;
    note?: string;
    tier?: string;
    escalatedFrom?: string[];
    needsInput?: boolean;
  },
): KnownBlock[] {
  // `needsInput` means the reviewer asked the customer something — it's NOT a decision, so never
  // render it as an approval. The agent relays the question and comes back for a real decision.
  const verdict = decision.needsInput
    ? "💬 Asked the customer"
    : decision.approved
      ? "✅ Approved"
      : "❌ Denied";
  const by = decision.by ? ` by *${decision.by}*` : "";
  const tier = decision.tier ? ` · Tier: *${decision.tier}*` : "";
  const esc = decision.escalatedFrom?.length ? `\n⤴ Escalated from ${decision.escalatedFrom.join(" → ")}` : "";
  const note = decision.note ? `\n> ${decision.note}` : "";
  return [
    { type: "section", text: { type: "mrkdwn", text: `*${d.summary ?? d.action ?? "Approval"}*` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `${verdict}${by}${tier}${esc}${note}` }] },
  ];
}

/** A security alert posted when the agent detects (and refuses) a manipulation attempt. */
export function securityAlertBlocks(
  d: { type: string; reason?: string; quarantined?: boolean },
  detailsUrl?: string,
): KnownBlock[] {
  const kind = d.type.replace(/_/g, " ");
  return [
    { type: "header", text: { type: "plain_text", text: "🚨 Security alert", emoji: true } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: d.quarantined
          ? `Repeated suspicious activity — session *restricted*. Last signal: *${kind}*.`
          : `Possible *${kind}* detected and refused.`,
      },
    },
    ...(d.reason ? [{ type: "context" as const, elements: [{ type: "mrkdwn" as const, text: d.reason }] }] : []),
    ...(detailsUrl
      ? [
          {
            type: "actions" as const,
            elements: [
              {
                type: "button" as const,
                action_id: APPROVAL_ACTIONS.details,
                text: { type: "plain_text" as const, text: "View case" },
                url: detailsUrl,
              },
            ],
          },
        ]
      : []),
  ];
}

/** The original message becomes a non-actionable note once it's been escalated up a tier. */
export function escalatedBlocks(d: ApprovalDetails, toLabel: string): KnownBlock[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `*${d.summary ?? d.action ?? "Approval"}*` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `⤴ Escalated to *${toLabel}* — awaiting their decision` }] },
  ];
}

/**
 * A live "talk to a human" turn posted to Slack. Once a customer is handed off, the assistant only
 * relays: every customer message is posted in ONE thread, the human hits Reply (reuses the input
 * modal + hook), and they end it with Close case. The root message starts the thread; later turns
 * are thread replies — keeps the channel clean.
 */
export function humanAgentBlocks(
  d: { reason?: string; account?: string },
  token: string,
  opts: { detailsUrl?: string; root?: boolean } = {},
): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  if (opts.root) {
    blocks.push({ type: "header", text: { type: "plain_text", text: "🙋 Live chat with customer", emoji: true } });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${d.account ? `Account *${d.account}* · ` : ""}Reply in this thread; the assistant relays it. Close the case when you're done.`,
        },
      ],
    });
  }
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `💬 *Customer:* ${d.reason ?? "(no message)"}` } });
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: APPROVAL_ACTIONS.input,
        style: "primary",
        text: { type: "plain_text", text: "Reply" },
        value: token,
      },
      {
        type: "button",
        action_id: APPROVAL_ACTIONS.close,
        style: "danger",
        text: { type: "plain_text", text: "Close case" },
        value: token,
      },
      ...(opts.detailsUrl && opts.root
        ? [
            {
              type: "button" as const,
              action_id: APPROVAL_ACTIONS.details,
              text: { type: "plain_text" as const, text: "View case" },
              url: opts.detailsUrl,
            },
          ]
        : []),
    ],
  });
  return blocks;
}

/** A live-handoff turn after the human replied or closed the case. */
export function humanAgentResolvedBlocks(
  d: { reason?: string },
  r: { by?: string; reply?: string; closed?: boolean },
): KnownBlock[] {
  const who = r.by ? ` *${r.by}*` : "";
  const foot = r.closed
    ? `🔒 Case closed${who ? ` by${who}` : ""}`
    : r.reply
      ? `✅ Replied${who ? ` by${who}` : ""}\n> ${r.reply}`
      : `↩︎ No reply sent`;
  return [
    { type: "section", text: { type: "mrkdwn", text: `💬 *Customer:* ${d.reason ?? ""}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: foot }] },
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
