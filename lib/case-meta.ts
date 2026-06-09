import type { UIMessage } from "ai";
import { deriveSummary, money } from "@/lib/case-trace";

// Derived, presentation-only case metadata for the operator console: category taxonomy,
// customer country/flag, total response time, and an estimated LLM cost per case. All of it
// is computed from the conversation the UI already holds — no extra backend calls.

// ── safe accessors (keep this module free of `any`) ──────────────────────────
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function partsOf(m: UIMessage): Record<string, unknown>[] {
  const parts = (m as unknown as { parts?: unknown[] }).parts ?? [];
  return parts.map(rec);
}

// ── Account directory (who the signed-in customer is) ────────────────────────
// Presentation copy of the back-office accounts so the UI can show "you are X with balance Y"
// before any tool call. The tools (lib/agent/tools.ts) remain the source of truth and enforce
// authorization independently — this is just what the customer sees about their own identity.
export type DirectoryEntry = {
  holder: string;
  country: string;
  countryName: string;
  balanceUsd: number;
  riskLevel: "low" | "medium" | "high";
};

export const ACCOUNT_DIRECTORY: Record<string, DirectoryEntry> = {
  "4815": { holder: "Acme Corp", country: "US", countryName: "United States", balanceUsd: 240.0, riskLevel: "low" },
  "2231": { holder: "Globex SA", country: "AR", countryName: "Argentina", balanceUsd: 184_200.5, riskLevel: "medium" },
  "9000": { holder: "Initech LLC", country: "MX", countryName: "Mexico", balanceUsd: 5_230.75, riskLevel: "high" },
};

/** Turn a 2-letter ISO country code into its flag emoji (regional indicator symbols). */
export function flagEmoji(country?: string): string {
  if (!country || country.length !== 2) return "🏳️";
  const base = 0x1f1e6; // regional indicator "A"
  const cc = country.toUpperCase();
  return String.fromCodePoint(base + (cc.charCodeAt(0) - 65), base + (cc.charCodeAt(1) - 65));
}

// ── Case category (a small fintech-support taxonomy) ─────────────────────────
export type CaseCategory = { breadcrumb: string[]; leaf: string };

const ROOT = "Fintech";

function caseText(messages: UIMessage[]): string {
  return messages
    .flatMap(partsOf)
    .filter((p) => str(p.type) === "text")
    .map((p) => str(p.text) ?? "")
    .join(" ")
    .toLowerCase();
}

function toolNames(messages: UIMessage[]): Set<string> {
  const names = messages
    .flatMap(partsOf)
    .map((p) => str(p.type) ?? "")
    .filter((t) => t.startsWith("tool-"))
    .map((t) => t.slice(5));
  return new Set(names);
}

/** Classify a case into a breadcrumb taxonomy from its content + the tools the agent used. */
export function categorize(messages: UIMessage[]): CaseCategory {
  const text = caseText(messages);
  const tools = toolNames(messages);
  const has = (re: RegExp) => re.test(text);

  if (has(/\b(fraud|unauthor|stolen|hack|scam|phish|compromis|dispute|disputed|didn'?t (make|authorize|recognize)|don'?t recognize|wasn'?t me)\b/)) {
    return {
      breadcrumb: [ROOT, "User Accounts", "Unauthorized activity & account compromise"],
      leaf: "Disputed / unrecognized transaction",
    };
  }
  if (tools.has("issueRefund") || has(/\b(refund|charge ?back|money back|reimburse)\b/)) {
    return { breadcrumb: [ROOT, "Payments", "Refunds"], leaf: "Refund request" };
  }
  if (tools.has("executeTransfer") || has(/\b(transfer|send money|wire|payout|move money)\b/)) {
    return { breadcrumb: [ROOT, "Payments", "Transfers"], leaf: "Money transfer" };
  }
  if (has(/\b(password|log ?in|locked out|can'?t access|2fa|reset|verification code|account security)\b/)) {
    return { breadcrumb: [ROOT, "User Accounts", "Account security"], leaf: "Account access / security" };
  }
  if (tools.has("lookupAccount") || has(/\b(balance|how much|statement|transactions?|account info)\b/)) {
    return { breadcrumb: [ROOT, "User Accounts", "Account information"], leaf: "Balance & activity inquiry" };
  }
  return { breadcrumb: [ROOT, "General", "Support"], leaf: "General inquiry" };
}

// ── Brief case description ───────────────────────────────────────────────────
// A one-line, fact-derived summary of what the case is about — independent of the title
// (which is just whatever the customer typed first, and may be noise). Built from the
// operation the agent performed and the outcome, falling back to the category.
const OUTCOME: Record<string, string> = {
  "pending-approval": "awaiting human approval",
  approved: "approved",
  denied: "denied",
  handled: "handled",
  active: "in progress",
  idle: "new",
};

export function caseDescription(messages: UIMessage[]): string {
  if (messages.length === 0) return "New case";
  const s = deriveSummary(messages);
  const cat = categorize(messages);

  let head: string;
  if (s.operation?.kind === "refund") {
    const amt = s.operation.amountUsd != null ? ` ${money(s.operation.amountUsd)}` : "";
    const ref = s.operation.ref ? ` on ${s.operation.ref}` : "";
    head = `Refund${amt}${ref}`;
  } else if (s.operation?.kind === "transfer") {
    const amt = s.operation.amountUsd != null ? ` ${money(s.operation.amountUsd)}` : "";
    const ref = s.operation.ref ? ` → account ${s.operation.ref}` : "";
    head = `Transfer${amt}${ref}`;
  } else {
    head = cat.leaf;
  }

  const outcome = OUTCOME[s.status] ?? s.status;
  return `${head} — ${outcome}`;
}

// ── Total response time ──────────────────────────────────────────────────────
export function responseTimeMs(createdAt: number, updatedAt?: number): number {
  return Math.max(0, (updatedAt ?? createdAt) - createdAt);
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// ── Estimated cost per case (Claude Sonnet 4.6 list pricing) ─────────────────
// Real per-million-token prices for the model the agent runs on. Token counts are estimated
// from character length (~4 chars/token) since the demo doesn't surface server-side usage —
// the figure is labelled "est." in the UI. In production you'd sum usage from the model response.
export const SONNET_PRICE_PER_MTOK = { input: 3, output: 15 } as const;

function jsonLen(v: unknown): number {
  try {
    return JSON.stringify(v ?? "").length;
  } catch {
    return 0;
  }
}

export type CostEstimate = { inputTokens: number; outputTokens: number; usd: number };

export function estimateCost(messages: UIMessage[], instructions: string): CostEstimate {
  let inputChars = instructions.length; // the policy is sent with the request
  let outputChars = 0;
  for (const m of messages) {
    for (const p of partsOf(m)) {
      const type = str(p.type);
      if (type === "text") {
        if (m.role === "user") inputChars += (str(p.text) ?? "").length;
        else outputChars += (str(p.text) ?? "").length;
      } else if (type?.startsWith("tool-")) {
        outputChars += jsonLen(p.input); // the model generated the tool call
        inputChars += jsonLen(p.output); // and then consumed its result
      }
    }
  }
  const inputTokens = Math.ceil(inputChars / 4);
  const outputTokens = Math.ceil(outputChars / 4);
  const usd =
    (inputTokens / 1e6) * SONNET_PRICE_PER_MTOK.input +
    (outputTokens / 1e6) * SONNET_PRICE_PER_MTOK.output;
  return { inputTokens, outputTokens, usd };
}

export function formatUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
