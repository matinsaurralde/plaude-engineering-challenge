import { tool } from "ai";
import { z } from "zod";
import { sleep } from "workflow";
import { approvalHook, type ApprovalDecision } from "@/lib/workflow/hooks";
import { postApprovalToSlack, resolveSlackMessage } from "@/lib/workflow/slack-steps";
import { DEFAULT_TIERS } from "@/lib/slack";

// ── Simulated fintech back office ────────────────────────────────────────────
// No database — a small in-memory fixture is enough to make the demo concrete.
// The point of the challenge is the human-in-the-loop workflow, not a payments backend.

type Account = {
  id: string;
  holder: string;
  balanceUsd: number;
  riskLevel: "low" | "medium" | "high";
  recentTransactions: { id: string; description: string; amountUsd: number }[];
};

const ACCOUNTS: Record<string, Account> = {
  "4815": {
    id: "4815",
    holder: "Acme Corp",
    balanceUsd: 240.0,
    riskLevel: "low",
    recentTransactions: [
      { id: "o_4815", description: "Order #4815 — annual plan", amountUsd: 12.5 },
      { id: "o_4790", description: "Order #4790 — add-on seats", amountUsd: 48.0 },
    ],
  },
  "2231": {
    id: "2231",
    holder: "Globex SA",
    balanceUsd: 184_200.5,
    riskLevel: "medium",
    recentTransactions: [
      { id: "o_2231", description: "Wire — supplier payment", amountUsd: 22_000 },
      { id: "o_2218", description: "Payroll top-up", amountUsd: 9_800 },
    ],
  },
  "9000": {
    id: "9000",
    holder: "Initech LLC",
    balanceUsd: 5_230.75,
    riskLevel: "high",
    recentTransactions: [
      { id: "o_9000", description: "Order #9000 — enterprise tier", amountUsd: 240.0 },
      { id: "o_8951", description: "Chargeback — disputed", amountUsd: 120.0 },
    ],
  },
};

const APPROVAL_TIMEOUT_MS = 5 * 60_000; // 5 minutes, then deny by default (HITL-05)

// ── Tool-level authorization (defense in depth) ──────────────────────────────
// The customer is "signed in" as one account (passed via experimental_context from the UI).
// The tools refuse any other account regardless of what the model is talked into — the prompt
// alone can't enforce this, because without identity the model can't tell whose account it is.
function authedAccount(opts?: { experimental_context?: unknown }): string | undefined {
  return (opts?.experimental_context as { authedAccount?: string } | undefined)?.authedAccount;
}

const NOT_AUTHORIZED = {
  ok: false as const,
  authorized: false as const,
  error: "Not authorized — you can only access your own account.",
};

// ── Durable step tools (memoized + retried by the workflow runtime) ───────────

export async function lookupAccount(
  { accountId }: { accountId: string },
  opts?: { experimental_context?: unknown },
) {
  "use step";
  const authed = authedAccount(opts);
  if (authed && accountId !== authed) {
    return { found: false as const, authorized: false as const, accountId };
  }
  const account = ACCOUNTS[accountId];
  if (!account) return { found: false as const, accountId };
  return { found: true as const, ...account };
}

export async function issueRefund(
  { accountId, orderId, amountUsd }: { accountId: string; orderId: string; amountUsd: number },
  opts?: { experimental_context?: unknown },
) {
  "use step";
  const authed = authedAccount(opts);
  if (authed && accountId !== authed) return NOT_AUTHORIZED;
  return {
    ok: true as const,
    refundId: `rf_${orderId}_${Math.round(amountUsd * 100)}`,
    accountId,
    orderId,
    amountUsd,
    status: "settled" as const,
  };
}

export async function executeTransfer(
  {
    fromAccountId,
    toAccountId,
    amountUsd,
  }: { fromAccountId: string; toAccountId: string; amountUsd: number },
  opts?: { experimental_context?: unknown },
) {
  "use step";
  const authed = authedAccount(opts);
  if (authed && fromAccountId !== authed) return NOT_AUTHORIZED;
  // Can't move more than the account actually holds — enforced in code, not just asked of the model.
  const account = ACCOUNTS[fromAccountId];
  if (account && amountUsd > account.balanceUsd) {
    return {
      ok: false as const,
      error: "insufficient_funds" as const,
      fromAccountId,
      balanceUsd: account.balanceUsd,
      amountUsd,
    };
  }
  return {
    ok: true as const,
    transferId: `tx_${fromAccountId}_${toAccountId}_${Math.round(amountUsd * 100)}`,
    fromAccountId,
    toAccountId,
    amountUsd,
    status: "completed" as const,
  };
}

// ── Human-in-the-loop tool (workflow-level, not a step — it suspends on a hook) ─

async function requestHumanApproval(
  input: {
    summary: string;
    action: string;
    riskLevel: "low" | "medium" | "high";
    tiers?: string[];
    tierIndex?: number;
  },
  { toolCallId, experimental_context }: { toolCallId: string; experimental_context?: unknown },
): Promise<ApprovalDecision> {
  const details = { summary: input.summary, action: input.action, riskLevel: input.riskLevel };
  const caseId = (experimental_context as { caseId?: string } | undefined)?.caseId;

  // Approver tiers come from the plain-text policy (the model passes them); fall back to the
  // default ladder so routing never breaks. A human can escalate up the ladder from Slack.
  const tiers = input.tiers && input.tiers.length ? input.tiers : [...DEFAULT_TIERS];
  // If the model routes by amount it sets tierIndex; otherwise default by risk so a high-risk
  // action still lands on the top tier (Compliance) instead of silently sitting at tier 0.
  const riskDefaultTier: Record<string, number> = { high: 2, medium: 1, low: 0 };
  const rawIndex = input.tierIndex ?? riskDefaultTier[input.riskLevel] ?? 0;
  const tierIndex = Math.min(Math.max(rawIndex, 0), tiers.length - 1);
  const routing = { tiers, tierIndex, from: [] as string[] };

  // Post to Slack (if configured), then suspend the durable run on a hook keyed by this tool
  // call. The Slack buttons and the in-app card both resume the very same token. Zero compute
  // is used while suspended.
  const slackRef = await postApprovalToSlack(details, toolCallId, caseId, routing);
  const hook = approvalHook.create({ token: toolCallId });

  const TIMED_OUT = Symbol("timed-out");
  const outcome = await Promise.race([
    hook,
    sleep(APPROVAL_TIMEOUT_MS).then(() => TIMED_OUT),
  ]);

  let decision: ApprovalDecision;
  if (typeof outcome === "symbol") {
    hook.dispose();
    decision = { approved: false, by: "system", note: "Approval timed out — denied by default." };
  } else {
    decision = outcome;
  }

  await resolveSlackMessage(slackRef, details, decision);
  return decision;
}

// ── Tool set handed to the DurableAgent ──────────────────────────────────────

export const tools = {
  lookupAccount: tool({
    description:
      "Look up the customer's account. Returns balance, holder, risk level and recent transactions, or { authorized: false } if it is not the customer's own account. Always call this before acting on an account.",
    inputSchema: z.object({
      accountId: z.string().describe("The customer's own account id"),
    }),
    execute: lookupAccount,
  }),

  issueRefund: tool({
    description:
      "Issue a refund on one of the customer's own orders. Only call AFTER any required human approval. Returns { authorized: false } if the account is not the customer's own.",
    inputSchema: z.object({
      accountId: z.string().describe("The customer's own account id"),
      orderId: z.string(),
      amountUsd: z.number().positive().describe("Refund amount in USD"),
    }),
    execute: issueRefund,
  }),

  executeTransfer: tool({
    description: "Move money between two accounts. Only call AFTER any required human approval.",
    inputSchema: z.object({
      fromAccountId: z.string(),
      toAccountId: z.string(),
      amountUsd: z.number().positive().describe("Transfer amount in USD"),
    }),
    execute: executeTransfer,
  }),

  requestHumanApproval: tool({
    description:
      "Pause and ask a human to approve, deny, or provide input before a sensitive action. " +
      "Call this BEFORE the action whenever the instructions require human sign-off. " +
      "Route it to the right approver tier via tiers + tierIndex (see the routing rules). " +
      "Returns { approved, note }. If approved is false, do not perform the action.",
    inputSchema: z.object({
      summary: z.string().describe("One-line summary of what needs approval"),
      action: z
        .string()
        .describe("The exact action taken if approved, e.g. 'refund $250 on order #4815'"),
      riskLevel: z.enum(["low", "medium", "high"]),
      tiers: z
        .array(z.string())
        .optional()
        .describe('Approver ladder from the policy, low → high, e.g. ["Support","Finance","Compliance"]'),
      tierIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Which tier should review first (0-based), per the routing rules"),
    }),
    execute: requestHumanApproval,
  }),
};
