import { defineHook } from "workflow";
import { z } from "zod";

/**
 * The payload a human sends back when resolving an approval request.
 * `note` doubles as the free-text input channel (the "ask a human for input" case).
 */
export const approvalDecisionSchema = z.object({
  approved: z.boolean(),
  by: z.string().optional(), // who decided — "in-app", a Slack user, or "system" on timeout
  note: z.string().optional(), // optional comment / free-text input from the human
  tier: z.string().optional(), // the approver tier that made the decision
  escalatedFrom: z.array(z.string()).optional(), // tiers it was escalated through to reach the decider
  closed: z.boolean().optional(), // live human handoff: the human ended the session
  needsInput: z.boolean().optional(), // reviewer asked the customer something — NOT a decision
});

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/**
 * A typed, durable hook the workflow suspends on while it waits for a human decision.
 *
 * The workflow calls `approvalHook.create({ token })` and `await`s it; an API route
 * (in-app button in Phase 2, Slack in Phase 3) calls `approvalHook.resume(token, decision)`
 * to wake the exact same run back up. We key the token on the tool call id so the UI and
 * Slack can both reference the same pending approval.
 */
export const approvalHook = defineHook<ApprovalDecision>({
  schema: approvalDecisionSchema,
});
