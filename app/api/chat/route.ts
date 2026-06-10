import { start } from "workflow/api";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { chatWorkflow } from "@/lib/workflow/chat";
import { DEFAULT_INSTRUCTIONS } from "@/lib/agent/instructions";

// The agent may loop over tool calls (and, later, wait on Slack), so give it room.
export const maxDuration = 60;

export async function POST(req: Request) {
  const {
    messages,
    instructions,
    caseId,
    authenticatedAccountId,
    quarantined,
    humanMode,
    humanThreadTs,
    approvalThreadTs,
  } = (await req.json()) as {
    messages: UIMessage[];
    instructions?: string;
    caseId?: string;
    authenticatedAccountId?: string;
    quarantined?: boolean;
    humanMode?: boolean;
    humanThreadTs?: string;
    approvalThreadTs?: string;
  };

  const modelMessages = await convertToModelMessages(messages);

  // Start a durable run of the chat workflow. The UI passes the (editable) plain-text
  // instructions, the case id, the signed-in account, and whether the session is quarantined.
  const run = await start(chatWorkflow, [
    modelMessages,
    instructions?.trim() || DEFAULT_INSTRUCTIONS,
    caseId,
    authenticatedAccountId,
    Boolean(quarantined),
    Boolean(humanMode),
    typeof humanThreadTs === "string" ? humanThreadTs : undefined,
    typeof approvalThreadTs === "string" ? approvalThreadTs : undefined,
  ]);

  // run.readable carries the UIMessageChunks the agent writes inside the workflow. We also return
  // the run id so the client (WorkflowChatTransport) can reconnect to this exact run if the stream
  // drops — a 60s function timeout, a page refresh, or a multi-minute Slack approval wait no longer
  // strands the durable run with no way to deliver its result back to the browser.
  return createUIMessageStreamResponse({
    stream: run.readable,
    headers: { "x-workflow-run-id": run.runId },
  });
}
