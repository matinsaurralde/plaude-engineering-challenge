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
  const { messages, instructions, caseId } = (await req.json()) as {
    messages: UIMessage[];
    instructions?: string;
    caseId?: string;
  };

  const modelMessages = await convertToModelMessages(messages);

  // Start a durable run of the chat workflow. The UI passes the (editable) plain-text
  // instructions and the case id with each request; we fall back to the committed defaults.
  const run = await start(chatWorkflow, [
    modelMessages,
    instructions?.trim() || DEFAULT_INSTRUCTIONS,
    caseId,
  ]);

  // run.readable carries the UIMessageChunks the agent writes inside the workflow.
  return createUIMessageStreamResponse({ stream: run.readable });
}
