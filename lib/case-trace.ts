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
  | "handled";

export type TraceEventKind =
  | "user"
  | "agent"
  | "tool"
  | "approval-request"
  | "approval-resolved"
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

      if (t.name === "requestHumanApproval") {
        const pending = t.state === "input-available" || t.state === "input-streaming";
        const approved = bool(t.output.approved);
        events.push({
          key: `${m.id}:${i}:approval-req`,
          kind: "approval-request",
          title: "Human approval requested",
          detail: str(t.input.summary) ?? str(t.input.action),
          why: whyApproval(t.input),
          status: pending ? "pending" : approved ? "ok" : "denied",
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
          events.push({
            key: `${m.id}:${i}:approval-res`,
            kind: "approval-resolved",
            title: approved ? "Approved" : "Denied",
            detail: [
              by ? `by ${by}` : "",
              tier ? `tier ${tier}` : "",
              esc.length ? `escalated from ${esc.join(" → ")}` : "",
              note ? `“${note}”` : "",
            ]
              .filter(Boolean)
              .join(" — "),
            status: approved ? "ok" : "denied",
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

  for (const m of messages) {
    for (const part of partsOf(m)) {
      const type = str(part.type);
      if (type === "step-start") steps += 1;
      const t = asTool(part);
      if (!t) continue;
      toolCalls += 1;

      if (t.name === "flagSecurityConcern") securityFlags += 1;

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
        if (t.state === "output-available") {
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
