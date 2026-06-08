import { tool } from "ai";
import { z } from "zod";
import { sleep } from "workflow";
import { approvalHook, type ApprovalDecision } from "@/lib/workflow/hooks";

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

// ── Durable step tools (memoized + retried by the workflow runtime) ───────────

export async function lookupAccount({ accountId }: { accountId: string }) {
  "use step";
  const account = ACCOUNTS[accountId];
  if (!account) return { found: false as const, accountId };
  return { found: true as const, ...account };
}

export async function issueRefund({
  orderId,
  amountUsd,
}: {
  orderId: string;
  amountUsd: number;
}) {
  "use step";
  return {
    ok: true as const,
    refundId: `rf_${orderId}_${Math.round(amountUsd * 100)}`,
    orderId,
    amountUsd,
    status: "settled" as const,
  };
}

export async function executeTransfer({
  fromAccountId,
  toAccountId,
  amountUsd,
}: {
  fromAccountId: string;
  toAccountId: string;
  amountUsd: number;
}) {
  "use step";
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
  {
    summary,
    action,
    riskLevel,
  }: { summary: string; action: string; riskLevel: "low" | "medium" | "high" },
  { toolCallId }: { toolCallId: string },
): Promise<ApprovalDecision> {
  // Suspend the durable run on a hook keyed by this tool call. The UI (Phase 2) and
  // Slack (Phase 3) resume the very same token. Zero compute is used while suspended.
  const hook = approvalHook.create({ token: toolCallId });

  const TIMED_OUT = Symbol("timed-out");
  const outcome = await Promise.race([
    hook,
    sleep(APPROVAL_TIMEOUT_MS).then(() => TIMED_OUT),
  ]);

  if (typeof outcome === "symbol") {
    hook.dispose();
    return { approved: false, by: "system", note: "Approval timed out — denied by default." };
  }
  return outcome;
}

// ── Tool set handed to the DurableAgent ──────────────────────────────────────

export const tools = {
  lookupAccount: tool({
    description:
      "Look up a customer account by id. Returns balance, holder, risk level and recent transactions. Always call this before acting on an account.",
    inputSchema: z.object({
      accountId: z.string().describe("Account id, e.g. 4815"),
    }),
    execute: lookupAccount,
  }),

  issueRefund: tool({
    description: "Issue a refund on an order. Only call AFTER any required human approval.",
    inputSchema: z.object({
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
      "Returns { approved, note }. If approved is false, do not perform the action.",
    inputSchema: z.object({
      summary: z.string().describe("One-line summary of what needs approval"),
      action: z
        .string()
        .describe("The exact action taken if approved, e.g. 'refund $250 on order #4815'"),
      riskLevel: z.enum(["low", "medium", "high"]),
    }),
    execute: requestHumanApproval,
  }),
};
