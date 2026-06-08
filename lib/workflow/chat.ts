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
export async function chatWorkflow(messages: ModelMessage[], instructions: string) {
  "use workflow";

  const agent = new DurableAgent({
    model: anthropic(AGENT_MODEL),
    instructions,
    tools,
  });

  await agent.stream({
    messages,
    writable: getWritable<UIMessageChunk>(),
    // Allow the agent to loop over tool calls (look up → maybe ask a human → act → confirm).
    stopWhen: stepCountIs(12),
  });
}
