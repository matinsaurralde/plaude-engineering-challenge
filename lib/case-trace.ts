import type { UIMessage } from "ai";

// Everything in the Engineering tab is derived from the chat messages — the same stream the
// UI already has. No extra backend calls: the durable run's tool calls and results are right
// there in the message parts.

export type CaseStatus =
  | "idle"
  | "active"
  | "pending-approval"
  | "approved"
  | "denied"
  | "closed"
  | "handled";

export type TraceEventKind =
  | "user"
  | "agent"
  | "tool"
  | "approval-request"
  | "approval-resolved"
  | "human-agent"
  | "security";

export type TraceEvent = {
  key: string; // stable key, used to stamp first-seen timestamps client-side
  kind: TraceEventKind;
  title: string;
  detail?: string;
  why?: string;
  status?: "pending" | "ok" | "denied" | "error";
  input?: unknown;
  output?: unknown;
  /** Present on a pending approval request — the hook token to resume. */
  approvalToken?: string;
  approval?: { summary?: string; action?: string; riskLevel?: string };
};

export type CaseSummary = {
  status: CaseStatus;
  account?: { id: string; holder: string; balanceUsd: number; riskLevel: string };
  operation?: { kind: string; amountUsd?: number; ref?: string };
  approval?: {
    required: boolean;
    decision?: { approved: boolean; by?: string; note?: string; tier?: string; escalatedFrom?: string[] };
  };
  steps: number;
  toolCalls: number;
  securityFlags: number;
};

// ── small safe accessors (keep this module free of `any`) ────────────────────
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

type LooseTool = {
  name: string;
  toolCallId?: string;
  state?: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
};

function asTool(part: Record<string, unknown>): LooseTool | null {
  const type = str(part.type);
  if (type?.startsWith("tool-")) {
    return {
      name: type.slice(5),
      toolCallId: str(part.toolCallId),
      state: str(part.state),
      input: rec(part.input),
      output: rec(part.output),
    };
  }
  if (type === "dynamic-tool") {
    return {
      name: str(part.toolName) ?? "tool",
      toolCallId: str(part.toolCallId),
      state: str(part.state),
      input: rec(part.input),
      output: rec(part.output),
    };
  }
  return null;
}

export function money(v: unknown): string {
  const n = num(v);
  return n === undefined
    ? String(v ?? "")
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function whyApproval(input: Record<string, unknown>): string {
  const risk = str(input.riskLevel);
  const base = "The plain-text instructions require human sign-off before this action";
  if (risk === "high") return `${base} — flagged high risk.`;
  if (risk === "medium") return `${base} — medium risk / above threshold.`;
  return `${base}.`;
}

function toolLabel(t: LooseTool): string {
  switch (t.name) {
    case "lookupAccount":
      return `Looked up account ${str(t.input.accountId) ?? ""}`.trim();
    case "issueRefund":
      return `Issued refund ${money(t.input.amountUsd)} on ${str(t.input.orderId) ?? ""}`.trim();
    case "executeTransfer":
      return `Transferred ${money(t.input.amountUsd)} → account ${str(t.input.toAccountId) ?? ""}`.trim();
    default:
      return t.name;
  }
}

function toolDetail(t: LooseTool): string | undefined {
  if (t.name === "lookupAccount" && bool(t.output.found)) {
    return `${str(t.output.holder) ?? ""} · balance ${money(t.output.balanceUsd)} · risk ${str(t.output.riskLevel) ?? "?"}`;
  }
  if (t.name === "issueRefund" && str(t.output.refundId)) {
    return `${str(t.output.status) ?? "ok"} · ${str(t.output.refundId)}`;
  }
  if (t.name === "executeTransfer" && str(t.output.transferId)) {
    return `${str(t.output.status) ?? "ok"} · ${str(t.output.transferId)}`;
  }
  return undefined;
}

function partsOf(m: UIMessage): Record<string, unknown>[] {
  const parts = (m as unknown as { parts?: unknown[] }).parts ?? [];
  return parts.map(rec);
}

function textOf(parts: Record<string, unknown>[]): string {
  return parts
    .filter((p) => str(p.type) === "text")
    .map((p) => str(p.text) ?? "")
    .join("");
}

/** Build a human-readable, why-annotated timeline of the case from the messages. */
export function buildTimeline(messages: UIMessage[]): TraceEvent[] {
  const events: TraceEvent[] = [];

  for (const m of messages) {
    const parts = partsOf(m);

    if (m.role === "user") {
      const text = textOf(parts);
      if (text.trim()) {
        events.push({ key: `${m.id}:user`, kind: "user", title: "Customer message", detail: text });
      }
      continue;
    }

    parts.forEach((part, i) => {
      const type = str(part.type);

      if (type === "text" && str(part.text)?.trim()) {
        events.push({ key: `${m.id}:${i}:text`, kind: "agent", title: "Agent reply", detail: str(part.text) });
        return;
      }
      if (type === "reasoning" && str(part.text)?.trim()) {
        events.push({ key: `${m.id}:${i}:reason`, kind: "agent", title: "Reasoning", detail: str(part.text) });
        return;
      }

      const t = asTool(part);
      if (!t) return;

      if (t.name === "flagSecurityConcern") {
        events.push({
          key: `${m.id}:${i}:security`,
          kind: "security",
          title: `Security flag — ${str(t.input.type)?.replace(/_/g, " ") ?? "concern"}`,
          detail: str(t.input.reason),
          why: "A manipulation attempt was detected and refused — logged for review.",
          status: "denied",
          input: t.input,
          output: t.output,
        });
        return;
      }

      if (t.name === "requestHumanAgent") {
        const waiting = t.state === "input-available" || t.state === "input-streaming";
        const replied = bool(t.output.replied);
        const closed = bool(t.output.closed);
        events.push({
          key: `${m.id}:${i}:handoff-req`,
          kind: "human-agent",
          title: "Live chat with a human",
          detail: str(t.input.reason),
          why: "The customer is talking to a human agent — the assistant only relays.",
          status: waiting ? "pending" : replied || closed ? "ok" : "denied",
          input: t.input,
          approvalToken: waiting ? t.toolCallId : undefined,
          approval: { summary: str(t.input.reason), action: str(t.input.reason), riskLevel: "low" },
        });
        if (t.state === "output-available") {
          const reply = str(t.output.reply);
          const by = str(t.output.by);
          events.push({
            key: `${m.id}:${i}:handoff-res`,
            kind: "human-agent",
            title: closed ? "Live chat closed" : replied ? "Human agent replied" : "Waiting on a human",
            detail: closed
              ? `closed${by ? ` by ${by}` : ""}`
              : [by ? `by ${by}` : "", reply ? `“${reply}”` : ""].filter(Boolean).join(" — "),
            status: replied || closed ? "ok" : "denied",
            output: t.output,
          });
        }
        return;
      }

      if (t.name === "requestHumanApproval") {
        const pending = t.state === "input-available" || t.state === "input-streaming";
        const approved = bool(t.output.approved);
        const needsInput = bool(t.output.needsInput);
        events.push({
          key: `${m.id}:${i}:approval-req`,
          kind: "approval-request",
          title: "Human approval requested",
          detail: str(t.input.summary) ?? str(t.input.action),
          why: whyApproval(t.input),
          status: pending || needsInput ? "pending" : approved ? "ok" : "denied",
          input: t.input,
          approvalToken: pending ? t.toolCallId : undefined,
          approval: {
            summary: str(t.input.summary),
            action: str(t.input.action),
            riskLevel: str(t.input.riskLevel),
          },
        });
        if (t.state === "output-available") {
          const by = str(t.output.by);
          const note = str(t.output.note);
          const tier = str(t.output.tier);
          const esc = strArr(t.output.escalatedFrom);
          // `by: "system"` with no human decision means the approval window elapsed — surface that
          // clearly for the operator (the customer never sees this internal reason).
          const autoDenied = !approved && by === "system";
          events.push({
            key: `${m.id}:${i}:approval-res`,
            kind: "approval-resolved",
            title: needsInput
              ? "Question to customer"
              : approved
                ? "Approved"
                : autoDenied
                  ? "Auto-denied"
                  : "Denied",
            detail: needsInput
              ? [by ? `by ${by}` : "", note ? `asked: “${note}”` : "asked the customer"]
                  .filter(Boolean)
                  .join(" — ")
              : [
                  autoDenied ? "no reviewer responded in time" : by ? `by ${by}` : "",
                  tier ? `tier ${tier}` : "",
                  esc.length ? `escalated from ${esc.join(" → ")}` : "",
                  note ? `“${note}”` : "",
                ]
                  .filter(Boolean)
                  .join(" — "),
            status: needsInput ? "pending" : approved ? "ok" : "denied",
            output: t.output,
          });
        }
        return;
      }

      events.push({
        key: `${m.id}:${i}:tool`,
        kind: "tool",
        title: toolLabel(t),
        detail: toolDetail(t),
        status: t.state === "output-available" ? "ok" : t.state === "output-error" ? "error" : "pending",
        input: t.input,
        output: t.output,
      });
    });
  }

  return events;
}

/**
 * Is a live human handoff currently active, and which Slack thread does it live in? Derived from the
 * last requestHumanAgent result: active until the human closes it. The client passes this back so the
 * next turn stays in relay mode and in the same thread.
 */
export function liveHandoff(messages: UIMessage[]): { active: boolean; threadTs?: string } {
  let active = false;
  let threadTs: string | undefined;
  for (const m of messages) {
    for (const part of partsOf(m)) {
      const t = asTool(part);
      if (t?.name === "requestHumanAgent" && t.state === "output-available") {
        active = !bool(t.output.closed);
        threadTs = str(t.output.threadTs) ?? threadTs;
      }
    }
  }
  return { active, threadTs };
}

/**
 * The Slack thread this case's approvals live in (the first approval message becomes the root).
 * The client passes it back each turn so every approval round of a case stays in ONE thread.
 */
export function approvalThread(messages: UIMessage[]): string | undefined {
  let threadTs: string | undefined;
  for (const m of messages) {
    for (const part of partsOf(m)) {
      const t = asTool(part);
      if (t?.name === "requestHumanApproval" && t.state === "output-available") {
        threadTs = str(t.output.threadTs) ?? threadTs;
      }
    }
  }
  return threadTs;
}

/** A compact, business-facing summary of the case (for the Engineering header). */
export function deriveSummary(messages: UIMessage[]): CaseSummary {
  let account: CaseSummary["account"];
  let operation: CaseSummary["operation"];
  let approval: CaseSummary["approval"];
  let steps = 0;
  let toolCalls = 0;
  let pending = false;
  let handledAction = false;
  let securityFlags = 0;
  let handoffClosed = false;

  for (const m of messages) {
    for (const part of partsOf(m)) {
      const type = str(part.type);
      if (type === "step-start") steps += 1;
      const t = asTool(part);
      if (!t) continue;
      toolCalls += 1;

      if (t.name === "flagSecurityConcern") securityFlags += 1;

      // A live human handoff that the human closed resolves the case (latest result wins).
      if (t.name === "requestHumanAgent" && t.state === "output-available") {
        handoffClosed = bool(t.output.closed) ?? false;
      }

      if (t.name === "lookupAccount" && bool(t.output.found)) {
        account = {
          id: str(t.output.id) ?? str(t.input.accountId) ?? "",
          holder: str(t.output.holder) ?? "",
          balanceUsd: num(t.output.balanceUsd) ?? 0,
          riskLevel: str(t.output.riskLevel) ?? "?",
        };
      }
      if (t.name === "issueRefund") {
        operation = { kind: "refund", amountUsd: num(t.input.amountUsd), ref: str(t.input.orderId) };
        handledAction = true;
      }
      if (t.name === "executeTransfer") {
        operation = { kind: "transfer", amountUsd: num(t.input.amountUsd), ref: str(t.input.toAccountId) };
        handledAction = true;
      }
      if (t.name === "requestHumanApproval") {
        if (!operation) {
          operation = { kind: "approval", ref: str(t.input.action) };
        }
        // needsInput is a question, not a decision — the approval stays open until a real verdict.
        if (t.state === "output-available" && !bool(t.output.needsInput)) {
          const escalatedFrom = strArr(t.output.escalatedFrom);
          approval = {
            required: true,
            decision: {
              approved: bool(t.output.approved) ?? false,
              by: str(t.output.by),
              note: str(t.output.note),
              tier: str(t.output.tier),
              escalatedFrom: escalatedFrom.length ? escalatedFrom : undefined,
            },
          };
          pending = false;
        } else {
          approval = { required: true };
          pending = true;
        }
      }
    }
  }

  let status: CaseStatus = "idle";
  if (messages.length === 0) status = "idle";
  else if (pending) status = "pending-approval";
  else if (handoffClosed) status = "closed";
  else if (approval?.decision) status = approval.decision.approved ? "approved" : "denied";
  else if (handledAction || messages.some((m) => m.role === "assistant")) status = "handled";
  else status = "active";

  return { status, account, operation, approval, steps, toolCalls, securityFlags };
}

/** A clean, downloadable/clipboard-able JSON snapshot of the whole case. */
export function buildExport(
  meta: { id: string; title: string; createdAt: number },
  instructions: string,
  messages: UIMessage[],
  times: Record<string, number>,
) {
  const summary = deriveSummary(messages);
  const timeline = buildTimeline(messages).map((e) => ({
    at: times[e.key] ? new Date(times[e.key]).toISOString() : undefined,
    kind: e.kind,
    title: e.title,
    detail: e.detail,
    why: e.why,
    status: e.status,
    input: e.input,
    output: e.output,
  }));

  return {
    case: {
      id: meta.id,
      title: meta.title,
      createdAt: new Date(meta.createdAt).toISOString(),
      status: summary.status,
    },
    summary,
    instructions,
    timeline,
    messages,
    exportedBy: "Matute — human-in-the-loop fintech agent",
  };
}
