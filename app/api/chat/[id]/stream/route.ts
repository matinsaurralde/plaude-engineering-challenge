import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";

/**
 * Stream reconnection endpoint.
 *
 * The chat workflow can suspend for minutes while a human approves in Slack. A single HTTP stream
 * can't survive that — a 60s function timeout, a refresh, or a dropped connection cuts it, and the
 * durable run is left with no open channel to deliver its result back to the browser. The run
 * itself is durable, so WorkflowChatTransport reconnects here by run id and we re-attach to the
 * same run's output stream, resuming exactly where the client left off.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);

  // The client tells us the last chunk index it received, so we don't replay what it already has.
  const startIndexParam = searchParams.get("startIndex");
  const startIndex = startIndexParam ? parseInt(startIndexParam, 10) : undefined;

  // Re-attach to the existing run instead of starting a new one. Bail fast on a stale/expired run
  // id (e.g. one left in localStorage after the run was garbage-collected) — without this guard,
  // reading a missing run's stream hangs until the function times out and throws an unhandled
  // rejection. A 404 tells the transport to stop retrying.
  const run = getRun(id);
  if (!(await run.exists)) {
    return new Response("workflow run not found", { status: 404 });
  }
  const readable = run.getReadable({ startIndex });

  // Expose the stream's tail index so the transport can resolve negative startIndex values into
  // absolute positions on subsequent retries.
  const tailIndex = await readable.getTailIndex();

  return createUIMessageStreamResponse({
    stream: readable,
    headers: { "x-workflow-stream-tail-index": String(tailIndex) },
  });
}
