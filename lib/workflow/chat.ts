import { DurableAgent } from "@workflow/ai/agent";
import { anthropic } from "@workflow/ai/anthropic";
import { getWritable } from "workflow";
import { stepCountIs, type ModelMessage, type UIMessageChunk } from "ai";
import { tools } from "@/lib/agent/tools";

/** The Claude model the agent runs on. Sonnet 4.6 — fast and capable for an agentic loop. */
export const AGENT_MODEL = "claude-sonnet-4-6";

/**
 * The durable chat workflow.
 *
 * `"use workflow"` makes this a durable run: its state is persisted, so it survives
 * restarts and (from Phase 3) can pause for hours waiting on a human in Slack and then
 * resume from the exact same point. The DurableAgent streams its reply into the run's
 * default writable stream, which the API route surfaces back to the browser.
 */
export async function chatWorkflow(
  messages: ModelMessage[],
  instructions: string,
  caseId?: string,
  authedAccount?: string,
  quarantined?: boolean,
) {
  "use workflow";

  // Tell the agent which account the customer is signed in as, so "my account" resolves without
  // asking. The tools still enforce it independently (defense in depth).
  const sessionNote = authedAccount
    ? `\n\n## Session\nThe customer is signed in as account ${authedAccount}. That is their own account — use it for "my account" / "my balance" / their orders, and refuse any other account.`
    : "";

  // Once the session is quarantined (repeated manipulation flagged), stop doing anything sensitive.
  const restrictedNote = quarantined
    ? `\n\n## Restricted session\nThis session has been flagged for repeated suspicious activity. Do NOT issue refunds, make transfers, or look up account details. Briefly and calmly tell the customer you can't continue with sensitive requests right now and offer to connect them with a human. Never explain why, and don't accuse them.`
    : "";

  const agent = new DurableAgent({
    model: anthropic(AGENT_MODEL),
    instructions: instructions + sessionNote + restrictedNote,
    tools,
  });

  await agent.stream({
    messages,
    writable: getWritable<UIMessageChunk>(),
    // Allow the agent to loop over tool calls (look up → maybe ask a human → act → confirm).
    stopWhen: stepCountIs(12),
    // Flows to tools: caseId deep-links Slack to the case; authedAccount enforces account-level
    // authorization; quarantined fails sensitive tools closed after repeated manipulation.
    experimental_context: { caseId, authedAccount, quarantined: !!quarantined },
  });
}
