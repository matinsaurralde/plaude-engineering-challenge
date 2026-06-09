# ADR 0002 — Architecture

**Status:** Accepted · **Date:** 2026-06-08

## Context

Build an AI agent governed by plain-text instructions that runs a human-in-the-loop workflow over
Slack — for a fintech support scenario where some actions need human sign-off. It must be simple,
runnable by a reviewer, and deployable on Vercel.

## Decisions

### 1. Durable workflow as the backbone (not a hand-rolled queue/DB)

The agent runs inside a WorkflowDevKit `DurableAgent` (`"use workflow"`). Human-in-the-loop is a
`defineHook()` the run suspends on; Slack/UI resume it by token. This gives the scalability
properties for free, without operating infrastructure:

- **Durability** — a suspended run persists; it survives restarts and redeploys and resumes from
  the exact point, even after a long wait. (The classic "designing a reliable system" goal, met by
  the platform rather than by us.)
- **Idempotent steps** — side effects (`lookupAccount`, `issueRefund`, the Slack post) are
  `"use step"` functions: memoized and retried, so a resume never double-posts or double-charges.
- **Decoupling** — the producer (the agent deciding to escalate) and the consumer (a human in
  Slack, minutes or hours later) are decoupled by the hook, the way a message queue decouples
  services — but with no broker to run.

A suspended run uses **zero compute** while it waits, so "scale" here is mostly "cost nothing while
idle," which a durable workflow gives directly.

> We deliberately did **not** read a full distributed-systems text for this. The relevant
> principles — durability, idempotency, decoupling — are supplied by the framework; adding a
> database, queue, or cache would be complexity the problem doesn't need.

### 2. Plain-text instructions per request — no database

The approval policy lives in an editable text file and travels with each request. The app is
**stateless**: no DB, no Redis. This keeps it deployable on Vercel with zero infra, and puts the
editable policy — the heart of the challenge — front and center. Case history is browser-local
(`localStorage`); it's a UI convenience, not a system of record.

### 3. Slack via raw `@slack/web-api` + manual HMAC verification

No Slack framework or Redis adapter. The webhook verifies the Slack signature itself
(`lib/slack.ts`) — fewer dependencies, and the verification is correct by construction (timestamp
window + constant-time compare), which matters for an endpoint that can authorize money movement.

### 4. Security is layered, not prompt-only

Account authorization and approval integrity are enforced in the tools, not just asked for in the
prompt. See `docs/adr/0001-guardrails.md`.

## Consequences

- **Good:** minimal dependencies, nothing to operate, deploys on Vercel, easy for a reviewer to run.
- **Trade-off:** durable runs that stay suspended longer than a serverless function's max duration
  need the resumable-stream reconnect pattern to keep the browser live; in-app approvals (fast) use
  the single open stream.
- **Stubbed for the demo:** simulated fintech back office (in-memory), and "signed in as" instead
  of real auth.

## Stack

Next.js 16 (App Router) · WorkflowDevKit (`workflow`, `@workflow/ai`) · AI SDK v6 +
`@ai-sdk/anthropic` (Claude Sonnet 4.6) · `@slack/web-api` · zod.
