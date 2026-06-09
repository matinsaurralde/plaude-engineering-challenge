import type { UIMessage } from "ai";

/** A case is one conversation. We keep a browser-local history — no database (see ADR). */
export type StoredCase = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt?: number; // last time the case settled — drives total response time
  accountId?: string; // which signed-in account the case belongs to (Cust ID + country)
  messages: UIMessage[];
};

const CASES_KEY = "matute.cases.v1";
const INSTRUCTIONS_KEY = "matute.instructions.v1";

export function loadCases(): StoredCase[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CASES_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as StoredCase[]) : [];
  } catch {
    return [];
  }
}

export function saveCases(cases: StoredCase[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CASES_KEY, JSON.stringify(cases));
  } catch {
    // storage unavailable/full — non-fatal for a demo
  }
}

export function loadInstructions(fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return window.localStorage.getItem(INSTRUCTIONS_KEY) ?? fallback;
}

export function saveInstructions(value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INSTRUCTIONS_KEY, value);
  } catch {
    // ignore
  }
}

export function titleFromMessages(messages: UIMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New case";
  const text =
    (firstUser as unknown as { parts?: { type?: string; text?: string }[] }).parts
      ?.filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("") ?? "";
  return text.trim().slice(0, 48) || "New case";
}

export function newCaseId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `case_${Date.now()}`;
}
