# Human-in-the-Loop AI Agent

An AI agent, governed by **plain-text instructions**, that runs a **human-in-the-loop
workflow over Slack**. When a request needs sign-off — a refund, a high-value transfer, an
ambiguous ask — the durable workflow **pauses**, asks a human in Slack to approve, deny, or
provide input, and then **resumes from the exact same point** once the human responds.

Built with [WorkflowDevKit](https://workflow-sdk.dev) (`DurableAgent`) on Next.js, as an
engineering challenge for [Plaude](https://plaude.com).

> **▶ Live demo: _<link goes here once deployed>_**
>
> Talk to **Matute**, the demo fintech support agent. Its entire behaviour — including
> *when* to escalate to a human — comes from editable plain-text instructions, not hardcoded
> logic. Try a small refund (instant), a large one (pauses for a human), or ask it to do
> something it shouldn't.

## How it works

```
Browser (chat UI)
   │  POST /api/chat  { messages, instructions, account }
   ▼
chatWorkflow            ← "use workflow" (durable: survives restarts, can pause for hours)
   │  DurableAgent · Claude Sonnet 4.6 · instructions (plain text, per request)
   │  tools: lookupAccount, issueRefund, executeTransfer, requestHumanApproval ("use step")
   ▼
requestHumanApproval → posts to Slack (Approve / Deny / Provide input) and awaits a hook
   │  await hook        ⏸  workflow suspended — zero compute while it waits
   ▼
POST /api/slack/interactions  → verifies the Slack signature (HMAC) → resumes the hook
   ▼
workflow resumes exactly where it paused → agent finishes → streams back to the browser
```

The durable workflow is the scalable backbone: a paused run consumes no compute, survives
redeploys, and resumes deterministically. No database or queue to operate.

## The core idea: behaviour is plain text

The approval policy isn't code — it's an **editable text file** that travels with every
request. Edit it in the UI and the agent's behaviour changes (when it escalates, how it
talks, what it refuses) with no redeploy. The app is stateless: the instructions *are* the
configuration, which is why there's no database. See
[ADR 0002 — Architecture](docs/adr/0002-architecture.md).

## Security: defense in depth

The agent can read balances and move money, so it's a target for prompt injection, data
exfiltration, approval bypass, and abuse. Guardrails are **not prompt-only** — two
independent layers, neither trusted alone:

- **Layer 1 — hardened instructions.** All message content is treated as untrusted *data*;
  the agent refuses to reveal its rules or tools, scopes itself to the customer's own
  account, holds the approval thresholds as non-negotiable, and stays composed under abuse.
- **Layer 2 — code-enforced controls in the tools.** Account authorization and approval
  integrity are enforced in code, so a prompt that talks the model out of a rule still can't
  read another account or move money without a real human approval.

We built a probe harness and red-teamed the **live** agent against a catalog of attacks —
instruction extraction, cross-account access, injection, approval bypass, social
engineering. See **[ADR 0001 — Guardrails](docs/adr/0001-guardrails.md)** for the threat
model, the results table, and the honest residual risks.

## Beyond the chat: the engineering console

The chat is the customer's view. A separate **Engineering** view is the operator's:

- **Case history** — every conversation, browsable.
- **Why-annotated timeline** — what the customer asked, what the agent did, and *why* it
  paused, step by step.
- **One-click JSON export** of the full case.
- **The approval surface** — approvals happen only here and in Slack, never in the customer
  chat, and reviewer notes are rephrased into clean customer-facing language.

## Stack

- **Next.js 16** (App Router) + **TypeScript** + **Tailwind CSS v4**
- **WorkflowDevKit** — `workflow`, `@workflow/ai` (`DurableAgent`)
- **AI SDK v6** + `@ai-sdk/anthropic` — Claude Sonnet 4.6
- **`@slack/web-api`** + manual HMAC verification (no extra Slack framework)
- **zod** for tool/schema validation

## Architecture decisions

- [ADR 0001 — Guardrails](docs/adr/0001-guardrails.md) — defense-in-depth, red-team results, residual risk
- [ADR 0002 — Architecture](docs/adr/0002-architecture.md) — durable workflow as the backbone, instructions-per-request, no DB

## Project structure

```
app/
  page.tsx                      chat UI + engineering console + editable instructions
  api/chat/route.ts             starts a durable run, streams the reply
  api/slack/interactions/route.ts  HMAC-verified Slack webhook → resumes the workflow
lib/
  workflow/chat.ts              the "use workflow" function + DurableAgent
  agent/instructions.ts         default plain-text instructions (the editable policy)
  agent/tools.ts                fintech tools with code-enforced account authorization
  slack.ts                      Block Kit + HMAC signature verification
next.config.ts                  withWorkflow() — installs the durable-execution transform
```

## License

MIT
