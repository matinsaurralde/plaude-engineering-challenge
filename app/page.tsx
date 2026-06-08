"use client";

import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState } from "react";

const EXAMPLES = [
  "How do I check my account balance?",
  "Refund order #4815 for $12.50",
  "Move $25,000 from operating to payroll",
];

export default function Home() {
  const { messages, sendMessage, status } = useChat();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    sendMessage({ text: trimmed });
    setInput("");
  }

  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 border-b border-zinc-800/80 px-5 py-3.5">
        <div className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-emerald-400 to-teal-600 font-bold text-zinc-950">
          A
        </div>
        <div className="leading-tight">
          <h1 className="text-sm font-semibold">Matute</h1>
          <p className="text-xs text-zinc-500">Human-in-the-loop fintech agent</p>
        </div>
        <span className="ml-auto rounded-full border border-zinc-800 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          DurableAgent
        </span>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6">
          {messages.length === 0 ? (
            <div className="mt-[12vh] flex flex-col items-center text-center">
              <h2 className="text-lg font-medium text-zinc-300">What can I help you with?</h2>
              <p className="mt-1 text-sm text-zinc-500">
                Ask anything — the agent pauses for human approval in Slack when the rules say so.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => submit(ex)}
                    className="rounded-full border border-zinc-800 bg-zinc-900 px-3.5 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <Message key={m.id} role={m.role}>
                {m.parts
                  .filter((p) => p.type === "text")
                  .map((p, i) => (
                    <span key={i}>{(p as { text: string }).text}</span>
                  ))}
              </Message>
            ))
          )}

          {busy && messages.at(-1)?.role !== "assistant" && (
            <Message role="assistant">
              <Dots />
            </Message>
          )}
        </div>
      </div>

      <div className="border-t border-zinc-800/80 px-4 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          className="mx-auto flex w-full max-w-2xl items-end gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 px-3 py-2 focus-within:border-zinc-600"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(input);
              }
            }}
            rows={1}
            placeholder="Message Matute…"
            className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-zinc-600"
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            className="rounded-lg bg-emerald-500 px-3.5 py-2 text-sm font-medium text-zinc-950 transition enabled:hover:bg-emerald-400 disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function Message({ role, children }: { role: string; children: React.ReactNode }) {
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

function Dots() {
  return (
    <span className="inline-flex gap-1 py-1">
      <span className="size-1.5 animate-bounce rounded-full bg-zinc-500 [animation-delay:-0.3s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-zinc-500 [animation-delay:-0.15s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-zinc-500" />
    </span>
  );
}
