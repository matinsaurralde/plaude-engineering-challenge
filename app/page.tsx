"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@workflow/ai";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DEFAULT_INSTRUCTIONS } from "@/lib/agent/instructions";
import {
  approvalThread,
  buildExport,
  buildTimeline,
  deriveSummary,
  liveHandoff,
  money,
  type CaseStatus,
  type TraceEvent,
} from "@/lib/case-trace";
import {
  loadCases,
  loadInstructions,
  newCaseId,
  saveCases,
  saveInstructions,
  titleFromMessages,
  type StoredCase,
} from "@/lib/cases";
import {
  ACCOUNT_DIRECTORY,
  caseDescription,
  categorize,
  estimateCost,
  flagEmoji,
  formatDate,
  formatDuration,
  formatUsd,
  responseTimeMs,
  type CaseCategory,
  type CostEstimate,
  type DirectoryEntry,
} from "@/lib/case-meta";

type Tab = "chat" | "engineering" | "instructions";
type EngView = "list" | "detail";
type CaseMeta = {
  id: string;
  title: string;
  description: string;
  createdAt: number;
  accountId: string;
  category: CaseCategory;
  responseMs: number;
  cost: CostEstimate;
  operationRef?: string;
};

// The demo has no auth, so the UI lets you pick which customer you're "signed in" as. The tools
// enforce that you can only touch this account (see docs/adr/0001-guardrails.md). Each account
// ships example prompts that show the instant path, the approval path, and the data-leak defense.
const DEMO_ACCOUNTS = [
  {
    id: "4815",
    holder: "Acme Corp",
    examples: ["What's my balance?", "Refund $12.50 on order o_4815", "Look up account 9000"],
  },
  {
    id: "2231",
    holder: "Globex SA",
    examples: ["What's my balance?", "Transfer $25,000 to account 9000", "Look up account 4815"],
  },
  {
    id: "9000",
    holder: "Initech LLC",
    examples: ["What's my balance?", "Refund $240 on order o_9000", "Look up account 2231"],
  },
];

// Honest customers slip up; attackers insist. The agent only flags genuine manipulation, and a
// session is locked for sensitive actions once it accumulates this many flags.
const SECURITY_QUARANTINE_THRESHOLD = 2;
const quarantinedFromFlags = (flags: number): boolean => flags >= SECURITY_QUARANTINE_THRESHOLD;

const STATUS_META: Record<CaseStatus, { label: string; text: string; dot: string }> = {
  "pending-approval": { label: "Awaiting approval", text: "text-amber-400", dot: "bg-amber-400" },
  approved: { label: "Approved", text: "text-emerald-400", dot: "bg-emerald-400" },
  denied: { label: "Denied", text: "text-rose-400", dot: "bg-rose-400" },
  closed: { label: "Closed", text: "text-violet-300", dot: "bg-violet-400" },
  handled: { label: "Handled", text: "text-zinc-400", dot: "bg-zinc-500" },
  active: { label: "Active", text: "text-sky-400", dot: "bg-sky-400" },
  idle: { label: "New", text: "text-zinc-500", dot: "bg-zinc-600" },
};

// localStorage key for the in-flight durable run id. The chat workflow can pause for minutes on a
// Slack approval; if the stream drops (a function timeout, a refresh, a dev-server restart) we use
// this to reconnect to the very same durable run instead of stranding it. See app/api/chat/[id].
const RUN_ID_KEY = "matute.run.v1";

export default function Home() {
  // Resume an in-flight run on mount (e.g. the tab was reopened while paused on an approval).
  const activeRunId = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    return window.localStorage.getItem(RUN_ID_KEY) ?? undefined;
  }, []);

  // Drop-in transport that auto-reconnects to interrupted streams (network drops, refreshes, Vercel
  // function timeouts). This is the piece that makes "pause for a human in Slack, then resume"
  // actually reach the browser even when the wait outlives a single HTTP request — without it the
  // durable run keeps going server-side but its result never gets delivered to the UI.
  const transport = useMemo(
    () =>
      new WorkflowChatTransport<UIMessage>({
        onChatSendMessage: (response) => {
          const id = response.headers.get("x-workflow-run-id");
          if (id) window.localStorage.setItem(RUN_ID_KEY, id);
        },
        onChatEnd: () => window.localStorage.removeItem(RUN_ID_KEY),
        prepareReconnectToStreamRequest: (config) => {
          const id = window.localStorage.getItem(RUN_ID_KEY);
          if (!id) throw new Error("No active workflow run to reconnect to");
          return { ...config, api: `/api/chat/${encodeURIComponent(id)}/stream` };
        },
      }),
    [],
  );

  const { messages, sendMessage, status, setMessages } = useChat({
    resume: Boolean(activeRunId),
    transport,
  });
  const [tab, setTab] = useState<Tab>("chat");
  const [input, setInput] = useState("");
  const [authAccount, setAuthAccount] = useState("9000");
  const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);
  const [cases, setCases] = useState<StoredCase[]>([]);
  const [activeId, setActiveId] = useState("");
  const [times, setTimes] = useState<Record<string, number>>({});
  const [approving, setApproving] = useState(false);
  const [engView, setEngView] = useState<EngView>("list");

  const busy = status === "submitted" || status === "streaming";

  // Load persisted cases + instructions once (one-time hydration from localStorage).
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- syncing React state from localStorage on mount */
    const loaded = loadCases();
    setCases(loaded);
    setInstructions(loadInstructions(DEFAULT_INSTRUCTIONS));
    const savedAcct = window.localStorage.getItem("matute.account.v1");
    if (savedAcct) setAuthAccount(savedAcct);

    // Deep links from Slack: /?tab=engineering&case=<id>
    const params = new URLSearchParams(window.location.search);
    const wantTab = params.get("tab");
    const wantCase = params.get("case");
    if (wantTab === "chat" || wantTab === "engineering" || wantTab === "instructions") setTab(wantTab);

    const target = (wantCase && loaded.find((c) => c.id === wantCase)) || loaded[0];
    if (target) {
      setActiveId(target.id);
      setMessages(target.messages);
      // A Slack deep link points at one case — drop the operator straight into its detail view.
      if (wantCase && target.id === wantCase) setEngView("detail");
    } else {
      setActiveId(newCaseId());
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the active conversation as a case — only once a turn settles (keeps writes off the
  // streaming hot path).
  useEffect(() => {
    if (!activeId || messages.length === 0) return;
    // Persist when a turn settles, or when it's paused on an approval (so the Slack deep link
    // can find the case while it's awaiting review).
    const hasPending = buildTimeline(messages).some(
      (e) => (e.kind === "approval-request" || e.kind === "human-agent") && e.approvalToken,
    );
    if (busy && !hasPending) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- persisting a settled or paused conversation
    setCases((prev) => {
      const existing = prev.find((c) => c.id === activeId);
      const now = Date.now();
      const next: StoredCase[] = existing
        ? prev.map((c) =>
            c.id === activeId
              ? { ...c, title: titleFromMessages(messages), messages, updatedAt: now }
              : c,
          )
        : [
            {
              id: activeId,
              title: titleFromMessages(messages),
              createdAt: now,
              updatedAt: now,
              accountId: authAccount,
              messages,
            },
            ...prev,
          ];
      saveCases(next);
      return next;
    });
  }, [messages, activeId, busy, authAccount]);

  // Stamp the wall-clock time each timeline event was first observed.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- bounded: only stamps brand-new events
    setTimes((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const e of buildTimeline(messages)) {
        if (next[e.key] === undefined) {
          next[e.key] = Date.now();
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [messages]);

  const timeline = useMemo(() => buildTimeline(messages), [messages]);
  const summary = useMemo(() => deriveSummary(messages), [messages]);
  // A live human handoff stays active (and in one Slack thread) until a human closes it. We pass
  // this back each turn so the agent keeps relaying instead of answering.
  const live = useMemo(() => liveHandoff(messages), [messages]);
  // The Slack thread this case's approvals live in — keeps every approval round in one thread.
  const approvalTs = useMemo(() => approvalThread(messages), [messages]);
  const pending = timeline.find(
    (e) => (e.kind === "approval-request" || e.kind === "human-agent") && e.approvalToken,
  );
  const account = DEMO_ACCOUNTS.find((a) => a.id === authAccount) ?? DEMO_ACCOUNTS[0];
  const identity = ACCOUNT_DIRECTORY[authAccount];
  const quarantined = quarantinedFromFlags(summary.securityFlags);

  // Operator-console metadata for the active case (category, country, response time, cost).
  const activeCase = cases.find((c) => c.id === activeId);
  const caseMeta = useMemo<CaseMeta>(() => {
    const createdAt = activeCase?.createdAt ?? Date.now();
    return {
      id: activeId,
      title: titleFromMessages(messages),
      description: caseDescription(messages),
      createdAt,
      accountId: activeCase?.accountId ?? authAccount,
      category: categorize(messages),
      responseMs: responseTimeMs(createdAt, activeCase?.updatedAt),
      cost: estimateCost(messages, instructions),
      operationRef: summary.operation?.ref,
    };
  }, [messages, activeCase, authAccount, instructions, summary, activeId]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    sendMessage(
      { text: trimmed },
      {
        body: {
          instructions,
          caseId: activeId,
          authenticatedAccountId: authAccount,
          quarantined,
          humanMode: live.active,
          humanThreadTs: live.threadTs,
          approvalThreadTs: approvalTs,
        },
      },
    );
    setInput("");
    setTab("chat");
  }

  function changeAccount(id: string) {
    setAuthAccount(id);
    try {
      window.localStorage.setItem("matute.account.v1", id);
    } catch {
      // ignore
    }
    newCase();
  }

  function selectCase(id: string) {
    const c = cases.find((x) => x.id === id);
    if (!c) return;
    setActiveId(id);
    setMessages(c.messages);
    setTab("chat");
  }

  function openCaseInEng(id: string) {
    const c = cases.find((x) => x.id === id);
    if (!c) return;
    setActiveId(id);
    setMessages(c.messages);
    setEngView("detail");
    setTab("engineering");
  }

  function newCase() {
    setActiveId(newCaseId());
    setMessages([]);
    setInput("");
    setTab("chat");
  }

  async function resolveApproval(token: string, approved: boolean, note: string, closed = false) {
    setApproving(true);
    try {
      await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, approved, note: note.trim() || undefined, closed: closed || undefined }),
      });
    } finally {
      setApproving(false);
    }
  }

  function updateInstructions(value: string) {
    setInstructions(value);
    saveInstructions(value);
  }

  return (
    <div className="flex h-dvh bg-zinc-950 text-zinc-100">
      <Sidebar cases={cases} activeId={activeId} onSelect={selectCase} onNew={newCase} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-800/80 px-5 py-3">
          <div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-emerald-400 to-teal-600 text-sm font-bold text-zinc-950">
            M
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold">Matute</h1>
            <p className="text-xs text-zinc-500">Human-in-the-loop fintech agent</p>
          </div>
          <label className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
            <span className="hidden sm:inline">Signed in as</span>
            <select
              value={authAccount}
              onChange={(e) => changeAccount(e.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-zinc-500"
            >
              {DEMO_ACCOUNTS.map((a) => (
                <option key={a.id} value={a.id}>
                  {flagEmoji(ACCOUNT_DIRECTORY[a.id]?.country)} {a.holder} · #{a.id}
                </option>
              ))}
            </select>
            {identity && (
              <span className="hidden items-center gap-1 md:inline-flex">
                · Balance <span className="font-medium text-zinc-300">{money(identity.balanceUsd)}</span>
              </span>
            )}
          </label>
          <nav className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1 text-xs">
            {(["chat", "engineering", "instructions"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1.5 capitalize transition ${
                  tab === t ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {t}
                {t === "engineering" && pending ? (
                  <span className="ml-1.5 inline-block size-1.5 rounded-full bg-amber-400 align-middle" />
                ) : null}
              </button>
            ))}
          </nav>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          {tab === "chat" && (
            <ChatTab
              messages={messages}
              busy={busy}
              pending={pending}
              examples={account.examples}
              identity={identity}
              accountId={authAccount}
              restricted={quarantined}
              onExample={submit}
            />
          )}
          {tab === "engineering" &&
            (engView === "list" ? (
              <CaseListPanel cases={cases} instructions={instructions} onOpen={openCaseInEng} onNew={newCase} />
            ) : (
              <EngineeringTab
                summary={summary}
                timeline={timeline}
                times={times}
                instructions={instructions}
                meta={caseMeta}
                empty={messages.length === 0}
                pending={pending}
                approving={approving}
                onBack={() => setEngView("list")}
                onResolve={resolveApproval}
                onExport={() =>
                  buildExport(
                    { id: activeId, title: caseMeta.title, createdAt: caseMeta.createdAt },
                    instructions,
                    messages,
                    times,
                  )
                }
              />
            ))}
          {tab === "instructions" && (
            <InstructionsTab value={instructions} onChange={updateInstructions} />
          )}
        </main>

        {tab === "chat" && (
          <Composer input={input} setInput={setInput} onSubmit={() => submit(input)} disabled={busy || !!pending} />
        )}
      </div>
    </div>
  );
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({
  cases,
  activeId,
  onSelect,
  onNew,
}: {
  cases: StoredCase[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-900/40">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">Cases</span>
        <button
          onClick={onNew}
          className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
        >
          + New
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {cases.length === 0 ? (
          <p className="px-2 py-4 text-xs text-zinc-600">No cases yet.</p>
        ) : (
          cases.map((c) => {
            const meta = STATUS_META[deriveSummary(c.messages).status];
            return (
              <button
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={`mb-1 flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition ${
                  c.id === activeId ? "bg-zinc-800" : "hover:bg-zinc-800/50"
                }`}
              >
                <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${meta.dot}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-200">{c.title}</span>
                  <span className={`text-[11px] ${meta.text}`}>{meta.label}</span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}

// ── Chat tab ─────────────────────────────────────────────────────────────────

function ChatTab({
  messages,
  busy,
  pending,
  examples,
  identity,
  accountId,
  restricted,
  onExample,
}: {
  messages: UIMessage[];
  busy: boolean;
  pending: TraceEvent | undefined;
  examples: string[];
  identity?: DirectoryEntry;
  accountId: string;
  restricted: boolean;
  onExample: (text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, pending]);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
        {restricted && (
          <div className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-300">
            <span aria-hidden>🔒</span>
            This session is restricted after repeated suspicious activity — sensitive actions are paused.
          </div>
        )}
        {messages.length === 0 ? (
          <div className="mt-[8vh] flex flex-col items-center text-center">
            {identity && (
              <div className="mb-6 w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-left">
                <div className="flex items-center gap-2">
                  <span className="text-base">{flagEmoji(identity.country)}</span>
                  <span className="text-sm font-medium text-zinc-200">{identity.holder}</span>
                  <span className="text-xs text-zinc-500">#{accountId}</span>
                  <span className="ml-auto text-xs text-zinc-400">
                    Balance <span className="font-medium text-zinc-200">{money(identity.balanceUsd)}</span>
                  </span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                  You&apos;re signed in as this account — the agent only ever acts on <span className="text-zinc-300">your own</span> account.
                  Switch accounts (top right) to try other balances, or ask about someone else&apos;s account to watch it refuse.
                </p>
              </div>
            )}
            <h2 className="text-lg font-medium text-zinc-300">What can I help you with?</h2>
            <p className="mt-1 max-w-sm text-sm text-zinc-500">
              Try a small refund (instant) vs. a large or high-risk one (pauses for human approval).
            </p>
            <div className="mt-6 flex flex-col gap-2">
              {examples.map((ex) => (
                <button
                  key={ex}
                  onClick={() => onExample(ex)}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2 text-left text-xs text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => <ChatMessage key={m.id} message={m} />)
        )}

        {pending && (
          <div className="flex items-center gap-2 self-start rounded-2xl rounded-bl-sm border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-400">
            <span
              className={`size-1.5 animate-pulse rounded-full ${pending.kind === "human-agent" ? "bg-violet-400" : "bg-amber-400"}`}
            />
            {pending.kind === "human-agent"
              ? "Connecting you with a person… we'll bring their reply here."
              : "Awaiting human confirmation — we'll update you here as soon as it's reviewed."}
          </div>
        )}

        {busy && !pending && messages.at(-1)?.role !== "assistant" && (
          <Bubble role="assistant">
            <Dots />
          </Bubble>
        )}
      </div>
    </div>
  );
}

function ChatMessage({ message }: { message: UIMessage }) {
  const parts = (message as unknown as { parts?: { type?: string; text?: string }[] }).parts ?? [];
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
  const toolNames = parts
    .map((p) => p.type ?? "")
    .filter((t) => t.startsWith("tool-"))
    .map((t) => t.slice(5));

  if (!text && toolNames.length === 0) return null;

  return (
    <div className={message.role === "user" ? "flex justify-end" : "flex flex-col gap-1.5"}>
      {toolNames.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {toolNames.map((name, i) => (
            <span
              key={i}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 font-mono text-[11px] text-zinc-400"
            >
              {name === "requestHumanApproval"
                ? "⏸ requestHumanApproval"
                : name === "requestHumanAgent"
                  ? "🙋 requestHumanAgent"
                  : `⚙ ${name}`}
            </span>
          ))}
        </div>
      )}
      {text &&
        (message.role === "user" ? (
          <Bubble role="user">{text}</Bubble>
        ) : (
          <div className="max-w-[85%] self-start rounded-2xl rounded-bl-sm border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-100">
            <Markdown>{text}</Markdown>
          </div>
        ))}
    </div>
  );
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="leading-relaxed [&_a]:underline [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

function ApprovalCard({
  event,
  approving,
  onResolve,
}: {
  event: TraceEvent;
  approving: boolean;
  onResolve: (token: string, approved: boolean, note: string, closed?: boolean) => void;
}) {
  const [note, setNote] = useState("");
  const isHandoff = event.kind === "human-agent";
  const risk = event.approval?.riskLevel ?? "medium";
  const riskColor =
    risk === "high" ? "text-rose-400" : risk === "medium" ? "text-amber-400" : "text-emerald-400";

  return (
    <div
      className={`rounded-xl border p-4 ${isHandoff ? "border-violet-500/40 bg-violet-500/5" : "border-amber-500/40 bg-amber-500/5"}`}
    >
      <div className="flex items-center gap-2">
        <span className={`text-sm font-semibold ${isHandoff ? "text-violet-300" : "text-amber-300"}`}>
          {isHandoff ? "🙋 Customer wants a human" : "⏸ Human approval required"}
        </span>
        {!isHandoff && (
          <span className={`ml-auto font-mono text-[11px] uppercase ${riskColor}`}>{risk} risk</span>
        )}
      </div>
      <p className="mt-2 text-sm text-zinc-200">{event.approval?.action ?? event.detail}</p>
      {event.why && <p className="mt-1 text-xs text-zinc-500">{event.why}</p>}

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={isHandoff ? "Type the reply to send to the customer…" : "Optional note / input for the agent…"}
        className="mt-3 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
      />
      <div className="mt-3 flex gap-2">
        <button
          disabled={approving || (isHandoff && !note.trim())}
          onClick={() => onResolve(event.approvalToken!, true, note)}
          className={`rounded-lg px-3.5 py-1.5 text-sm font-medium text-zinc-950 transition disabled:opacity-50 ${isHandoff ? "bg-violet-400 enabled:hover:bg-violet-300" : "bg-emerald-500 enabled:hover:bg-emerald-400"}`}
        >
          {isHandoff ? "Send reply" : "Approve"}
        </button>
        <button
          disabled={approving}
          onClick={() => onResolve(event.approvalToken!, false, isHandoff ? "" : note, isHandoff)}
          className="rounded-lg border border-zinc-700 px-3.5 py-1.5 text-sm text-zinc-300 transition enabled:hover:border-rose-500/60 enabled:hover:text-rose-300 disabled:opacity-50"
        >
          {isHandoff ? "Close case" : "Deny"}
        </button>
        <span className="ml-auto self-center font-mono text-[10px] text-zinc-600">
          token {event.approvalToken?.slice(0, 10)}…
        </span>
      </div>
    </div>
  );
}

// ── Engineering: case list (operator console) ────────────────────────────────

function CaseListPanel({
  cases,
  instructions,
  onOpen,
  onNew,
}: {
  cases: StoredCase[];
  instructions: string;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const [statusFilter, setStatusFilter] = useState<CaseStatus | "all">("all");
  const [acctFilter, setAcctFilter] = useState("all");
  const [catFilter, setCatFilter] = useState("all");

  // Derive each case's metadata once, so filtering and rendering don't recompute it per row.
  const rows = useMemo(
    () =>
      cases.map((c) => {
        const summary = deriveSummary(c.messages);
        return {
          c,
          status: summary.status,
          securityFlags: summary.securityFlags,
          accountId: c.accountId ?? "",
          leaf: categorize(c.messages).leaf,
          description: caseDescription(c.messages),
          cost: estimateCost(c.messages, instructions),
        };
      }),
    [cases, instructions],
  );

  const pendingCount = rows.filter((r) => r.status === "pending-approval").length;
  const statuses = Array.from(new Set(rows.map((r) => r.status)));
  const accounts = Array.from(new Set(rows.map((r) => r.accountId).filter(Boolean)));
  const categories = Array.from(new Set(rows.map((r) => r.leaf))).sort();

  const filtered = rows.filter(
    (r) =>
      (statusFilter === "all" || r.status === statusFilter) &&
      (acctFilter === "all" || r.accountId === acctFilter) &&
      (catFilter === "all" || r.leaf === catFilter),
  );
  const anyFilter = statusFilter !== "all" || acctFilter !== "all" || catFilter !== "all";
  const clearFilters = () => {
    setStatusFilter("all");
    setAcctFilter("all");
    setCatFilter("all");
  };

  if (cases.length === 0) {
    return (
      <div className="grid h-full place-items-center">
        <div className="text-center">
          <p className="text-sm text-zinc-500">No cases yet.</p>
          <button
            onClick={onNew}
            className="mt-3 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400"
          >
            Start a case
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-zinc-200">Cases</h2>
        <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">{cases.length}</span>
        <span className="ml-auto text-[11px] text-zinc-600">Operator console · click a case to open</span>
      </div>

      {/* Pending approvals — the operator's actionable queue, surfaced first */}
      {pendingCount > 0 && (
        <button
          onClick={() => setStatusFilter(statusFilter === "pending-approval" ? "all" : "pending-approval")}
          className={`mb-3 flex w-full items-center gap-2 rounded-xl border px-4 py-2.5 text-sm transition ${
            statusFilter === "pending-approval"
              ? "border-amber-500/60 bg-amber-500/10"
              : "border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10"
          }`}
        >
          <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
          <span className="font-medium text-amber-300">
            {pendingCount} approval{pendingCount > 1 ? "s" : ""} awaiting review
          </span>
          <span className="ml-auto text-[11px] text-amber-400/70">
            {statusFilter === "pending-approval" ? "showing only these · clear" : "show only these →"}
          </span>
        </button>
      )}

      {/* Filters: status · account · category */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <FilterSelect
          label="Status"
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as CaseStatus | "all")}
          options={[["all", "All statuses"], ...statuses.map((s) => [s, STATUS_META[s].label] as [string, string])]}
        />
        <FilterSelect
          label="Account"
          value={acctFilter}
          onChange={setAcctFilter}
          options={[
            ["all", "All accounts"],
            ...accounts.map(
              (id) =>
                [
                  id,
                  `${flagEmoji(ACCOUNT_DIRECTORY[id]?.country)} ${ACCOUNT_DIRECTORY[id]?.holder ?? "Account"} · #${id}`,
                ] as [string, string],
            ),
          ]}
        />
        <FilterSelect
          label="Category"
          value={catFilter}
          onChange={setCatFilter}
          options={[["all", "All categories"], ...categories.map((l) => [l, l] as [string, string])]}
        />
        {anyFilter && (
          <button onClick={clearFilters} className="text-zinc-500 transition hover:text-zinc-300">
            Clear
          </button>
        )}
        <span className="ml-auto text-zinc-600">
          {filtered.length} of {rows.length}
        </span>
      </div>

      <div className="divide-y divide-zinc-800/70 overflow-hidden rounded-xl border border-zinc-800">
        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-zinc-600">No cases match these filters.</div>
        ) : (
          filtered.map((r) => {
            const c = r.c;
            const sMeta = STATUS_META[r.status];
            const dir = ACCOUNT_DIRECTORY[r.accountId];
            return (
              <button
                key={c.id}
                onClick={() => onOpen(c.id)}
                className="flex w-full items-center gap-4 px-4 py-3 text-left transition hover:bg-zinc-900/50"
              >
                <span className={`size-2 shrink-0 rounded-full ${sMeta.dot}`} />

                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-sm text-zinc-100">{c.title}</span>
                    {r.securityFlags > 0 && (
                      <span
                        className="shrink-0 text-[11px] text-rose-400"
                        title={`${r.securityFlags} security flag${r.securityFlags > 1 ? "s" : ""}`}
                      >
                        🚨
                      </span>
                    )}
                    <span className={`shrink-0 text-[11px] ${sMeta.text}`}>{sMeta.label}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-zinc-500">{r.description}</span>
                </span>

                <span className="hidden shrink-0 flex-col items-end gap-0.5 text-[11px] text-zinc-500 sm:flex">
                  <span title={dir?.countryName}>
                    {flagEmoji(dir?.country)} {formatDate(c.createdAt)}
                  </span>
                  <span className="flex items-center gap-3">
                    <span>{formatDuration(responseTimeMs(c.createdAt, c.updatedAt))}</span>
                    <span className="font-mono text-zinc-400">{formatUsd(r.cost.usd)}</span>
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="flex items-center gap-1.5 text-zinc-500">
      <span className="hidden sm:inline">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-zinc-500"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function BackToCases({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="flex items-center gap-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
    >
      <span aria-hidden>←</span> All cases
    </button>
  );
}

function CopyId({ label, value }: { label: string; value?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</div>
      {value ? (
        <button
          onClick={() => {
            navigator.clipboard?.writeText(value).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              },
              () => {},
            );
          }}
          className="mt-0.5 flex w-full items-center gap-1.5 font-mono text-xs text-zinc-300 transition hover:text-zinc-100"
          title="Copy"
        >
          <span className="truncate">{value}</span>
          <span className="shrink-0 text-zinc-600">{copied ? "✓" : "⧉"}</span>
        </button>
      ) : (
        <div className="mt-0.5 font-mono text-xs text-zinc-600">—</div>
      )}
    </div>
  );
}

// ── Engineering tab ──────────────────────────────────────────────────────────

function EngineeringTab({
  summary,
  timeline,
  times,
  instructions,
  meta,
  empty,
  pending,
  approving,
  onBack,
  onResolve,
  onExport,
}: {
  summary: ReturnType<typeof deriveSummary>;
  timeline: TraceEvent[];
  times: Record<string, number>;
  instructions: string;
  meta: CaseMeta;
  empty: boolean;
  pending: TraceEvent | undefined;
  approving: boolean;
  onBack: () => void;
  onResolve: (token: string, approved: boolean, note: string, closed?: boolean) => void;
  onExport: () => object;
}) {
  const [copied, setCopied] = useState(false);
  const dir = ACCOUNT_DIRECTORY[meta.accountId];

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(onExport(), null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — ignore
    }
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(onExport(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "matute-case.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (empty) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <BackToCases onBack={onBack} />
        <div className="mt-10 grid place-items-center text-sm text-zinc-600">
          This case has no activity yet — send a message in Chat and the run trace shows up here.
        </div>
      </div>
    );
  }

  const statusMeta = STATUS_META[summary.status];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <BackToCases onBack={onBack} />

      {/* Case identity — what this case is, who it's for, and its category */}
      <div className="mt-3 mb-4">
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-lg font-semibold text-zinc-100">{meta.title}</h2>
          <span className="shrink-0 pt-1 text-sm text-zinc-400" title={dir?.countryName}>
            {flagEmoji(dir?.country)} {formatDate(meta.createdAt)}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-400">{meta.description}</p>
        <div className="mt-1.5 text-[11px] text-zinc-500">
          <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Category</span>
          <span className="ml-2 text-sky-400/90">{meta.category.leaf}</span>
          <span className="ml-2 text-zinc-600">
            {meta.category.breadcrumb.join(" › ")} › {meta.category.leaf}
          </span>
        </div>
      </div>

      {summary.securityFlags > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-x-2 rounded-xl border border-rose-500/40 bg-rose-500/5 px-4 py-2.5 text-sm">
          <span className="font-semibold text-rose-300">
            🚨 {summary.securityFlags} security flag{summary.securityFlags > 1 ? "s" : ""}
          </span>
          <span className="text-zinc-400">
            {quarantinedFromFlags(summary.securityFlags)
              ? "— session restricted; sensitive actions are blocked in code"
              : "— manipulation attempt detected and refused (logged for review)"}
          </span>
        </div>
      )}

      {pending && pending.approvalToken && (
        <div className="mb-4">
          <ApprovalCard event={pending} approving={approving} onResolve={onResolve} />
        </div>
      )}

      {/* Case header */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${statusMeta.dot}`} />
          <span className={`text-sm font-medium ${statusMeta.text}`}>{statusMeta.label}</span>
          <div className="ml-auto flex gap-2">
            <button
              onClick={copyJson}
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500"
            >
              {copied ? "Copied ✓" : "Copy JSON"}
            </button>
            <button
              onClick={downloadJson}
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500"
            >
              Download JSON
            </button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Field label="Account">
            {summary.account ? `${summary.account.holder} · #${summary.account.id}` : "—"}
          </Field>
          <Field label="Balance">{summary.account ? money(summary.account.balanceUsd) : "—"}</Field>
          <Field label="Risk">{summary.account?.riskLevel ?? "—"}</Field>
          <Field label="Operation">
            {summary.operation
              ? `${summary.operation.kind}${summary.operation.amountUsd ? " " + money(summary.operation.amountUsd) : ""}`
              : "—"}
          </Field>
          <Field label="Steps">{summary.steps || "—"}</Field>
          <Field label="Tool calls">{summary.toolCalls || "—"}</Field>
          <Field label="Approval">
            {summary.approval
              ? summary.approval.decision
                ? summary.approval.decision.approved
                  ? "approved"
                  : "denied"
                : "pending"
              : "not required"}
          </Field>
          <Field label="Decided by">{summary.approval?.decision?.by ?? "—"}</Field>
          <Field label="Response time">{formatDuration(meta.responseMs)}</Field>
          <Field label="Cost of handling">{formatUsd(meta.cost.usd)} <span className="text-[10px] text-zinc-600">est.</span></Field>
        </div>
      </div>

      {/* Case IDs */}
      <h3 className="mt-6 mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
        Case IDs
      </h3>
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 sm:grid-cols-3">
        <CopyId label="Case ID" value={meta.id} />
        <CopyId label="Cust ID" value={meta.accountId} />
        <CopyId label="Operation ref" value={meta.operationRef} />
      </div>

      {/* Timeline */}
      <h3 className="mt-6 mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
        Run timeline
      </h3>
      <ol className="relative ml-2 border-l border-zinc-800">
        {timeline.map((e) => (
          <TimelineItem key={e.key} event={e} at={times[e.key]} />
        ))}
      </ol>

      {/* Live instructions */}
      <h3 className="mt-6 mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
        Instructions used (live)
      </h3>
      <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-[11px] leading-relaxed text-zinc-400">
        {instructions}
      </pre>
    </div>
  );
}

const EVENT_DOT: Record<TraceEvent["kind"], string> = {
  user: "bg-sky-400",
  agent: "bg-zinc-500",
  tool: "bg-teal-400",
  "approval-request": "bg-amber-400",
  "approval-resolved": "bg-emerald-400",
  "human-agent": "bg-violet-400",
  security: "bg-rose-500",
};

function TimelineItem({ event, at }: { event: TraceEvent; at?: number }) {
  const dot =
    event.status === "denied"
      ? "bg-rose-400"
      : event.status === "error"
        ? "bg-rose-400"
        : EVENT_DOT[event.kind];
  return (
    <li className="mb-4 ml-4">
      <span className={`absolute -left-[5px] mt-1.5 size-2.5 rounded-full ${dot} ring-4 ring-zinc-950`} />
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-zinc-200">{event.title}</span>
        {event.status === "pending" && (
          <span className="animate-pulse font-mono text-[10px] text-amber-400">waiting…</span>
        )}
        {at && <span className="ml-auto font-mono text-[10px] text-zinc-600">{fmtTime(at)}</span>}
      </div>
      {event.detail && <p className="mt-0.5 text-sm whitespace-pre-wrap text-zinc-400">{event.detail}</p>}
      {event.why && <p className="mt-0.5 text-xs text-zinc-500">↳ {event.why}</p>}
    </li>
  );
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}

// ── Instructions tab ─────────────────────────────────────────────────────────

function InstructionsTab({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const dirty = value !== DEFAULT_INSTRUCTIONS;
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 py-6">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium text-zinc-300">Plain-text instructions</h2>
        <span className="text-xs text-zinc-500">used on the next message — no redeploy</span>
        {dirty && (
          <>
            <span className="text-[11px] text-amber-400/80">· showing your edited copy</span>
            <button
              onClick={() => onChange(DEFAULT_INSTRUCTIONS)}
              className="ml-auto rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500"
            >
              Reset to default
            </button>
          </>
        )}
      </div>
      <p className="mb-3 text-xs leading-relaxed text-zinc-500">
        These <span className="text-zinc-300">are</span> the guardrails — layer 1: trust boundary, account
        scope, approval thresholds + tiers, confidentiality, conduct. They&apos;re probabilistic, so the hard
        guarantees (account authorization, approval integrity, insufficient-funds) live in{" "}
        <span className="text-zinc-300">layer 2</span> — enforced in the tool code, not editable here. See{" "}
        <span className="font-mono text-zinc-400">docs/adr/0001-guardrails.md</span>.
      </p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 font-mono text-[13px] leading-relaxed text-zinc-200 outline-none focus:border-zinc-600"
      />
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

function Composer({
  input,
  setInput,
  onSubmit,
  disabled,
}: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  return (
    <div className="border-t border-zinc-800/80 px-4 py-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="mx-auto flex w-full max-w-2xl items-end gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 px-3 py-2 focus-within:border-zinc-600"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={1}
          placeholder="Message Matute…"
          className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-zinc-600"
        />
        <button
          type="submit"
          disabled={!input.trim() || disabled}
          className="rounded-lg bg-emerald-500 px-3.5 py-2 text-sm font-medium text-zinc-950 transition enabled:hover:bg-emerald-400 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function Bubble({ role, children }: { role: string; children: React.ReactNode }) {
  const isUser = role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          isUser
            ? "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-emerald-500 px-4 py-2.5 text-sm text-zinc-950"
            : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-100"
        }
      >
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</div>
      <div className="mt-0.5 truncate text-sm text-zinc-200">{children}</div>
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex gap-1 py-1">
      <span className="size-1.5 animate-bounce rounded-full bg-zinc-500 [animation-delay:-0.3s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-zinc-500 [animation-delay:-0.15s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-zinc-500" />
    </span>
  );
}
