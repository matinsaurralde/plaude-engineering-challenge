# Human-in-the-Loop AI Agent

An AI agent, governed by **plain-text instructions**, that runs a **human-in-the-loop
workflow over Slack**. When a request needs sign-off — a refund, a high-value transfer, an
ambiguous ask — the durable workflow **pauses**, asks a human in Slack to approve, deny, ask
the customer a question, or escalate, and then **resumes from the exact same point** once the
human responds.

Built with [WorkflowDevKit](https://workflow-sdk.dev) (`DurableAgent`) on Next.js, as an
engineering challenge for [Plaude](https://plaude.com).

> **▶ Live demo: _<link goes here once deployed>_**
>
> Talk to **Matute**, the demo fintech support agent. Its entire behaviour — including
> *when* to escalate to a human — comes from editable plain-text instructions, not hardcoded
> logic. Try a small refund (instant), a large transfer (pauses for a human), ask to talk to
> a person (live handoff), or try to talk it into breaking its rules.

## How it works

```
Browser (chat UI)
   │  POST /api/chat  { messages, instructions, account }
   ▼
chatWorkflow            ← "use workflow" (durable: survives restarts, can pause for hours)
   │  DurableAgent · Claude Sonnet 4.6 · instructions (plain text, per request)
   │  tools: lookupAccount, issueRefund, executeTransfer ("use step")
   │         requestHumanApproval, requestHumanAgent (suspend on a durable hook)
   ▼
requestHumanApproval → posts to Slack (Approve / Deny / Ask the customer / Escalate)
   │  await hook        ⏸  workflow suspended — zero compute while it waits
   ▼
POST /api/slack/interactions  → verifies the Slack signature (HMAC) → resumes the hook
   ▼
workflow resumes exactly where it paused → agent finishes → streams back to the browser
   ⤷ if the stream ever drops (timeout, refresh), the client reconnects to the same
     durable run via GET /api/chat/{runId}/stream and the result still arrives
```

The durable workflow is the scalable backbone: a paused run consumes no compute, survives
redeploys, and resumes deterministically. No database or queue to operate — the demo is
fully stateless on the server.

## A tour of the app

Three tabs, three audiences:

- **Chat** — the customer's view. Pick which account you're "signed in" as (the demo's
  identity selector), and talk to Matute. While a request awaits a human you'll see a status
  pill; the input locks until it's resolved. The customer never sees internal mechanics —
  thresholds, tiers, or reviewers.
- **Engineering** — the operator's console. A browsable case list (status / account /
  category filters, a pending-approvals queue) and, per case: a **why-annotated timeline**
  of every step the agent took, response time, estimated token cost, security flags, the
  in-app approval / live-chat reply cards, and one-click JSON export of the full case.
- **Instructions** — the live plain-text policy. Edit it and the agent's behaviour changes
  on the next message, with no redeploy: approval thresholds, the approver ladder, tone,
  scope, security rules. A reset button restores the canonical version.

## Two human-in-the-loop flows, one engine

Both flows ride the exact same mechanism — a durable hook the workflow suspends on, resumed
by a webhook — applied to two very different jobs:

**1. Approvals (maker-checker).** The plain-text policy defines an approver ladder —
**Support → Finance → Compliance** — and which tier should review first. The Slack message
shows the assigned tier; a reviewer can **Approve**, **Deny**, **Ask the customer** a
clarifying question (which is *not* a decision — the approval stays open while the agent
relays the question and returns with the answer), or **Escalate** it up the ladder with one
button. Every round of the same case threads under one Slack message, so the channel stays
clean. If nobody responds, the request **fails closed** (denies) after a configurable window.

**2. Live human handoff.** If the customer asks for a person, the agent steps aside and
becomes a pure relay: each customer message lands in the same Slack thread, the human
replies from Slack, and the agent passes it along in the customer's language — until the
human closes the case with a button. Same durable pause, zero compute while waiting.

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
- **Layer 2 — code-enforced controls in the tools.** Account authorization, balance limits,
  and approval integrity are enforced in code, so a prompt that talks the model out of a
  rule still can't read another account or move money without a real human approval. Asking
  the customer a question never counts as an approval, and timeouts fail closed.
- **Detection → log → quarantine.** Genuine manipulation attempts (injection, instruction
  extraction, insistence after a refusal — not honest mistakes) are silently flagged to
  Slack and the case timeline; repeated flags restrict the session so money-moving tools
  fail closed regardless of what the model is talked into.

We built a probe harness and red-teamed the **live** agent against a catalog of attacks —
instruction extraction, cross-account access, injection, approval bypass, social
engineering. See **[ADR 0001 — Guardrails](docs/adr/0001-guardrails.md)** for the threat
model, the results table, and the honest residual risks.

## Built on WorkflowDevKit

The durable pieces, in SDK terms:

- **`"use workflow"`** — `chatWorkflow` is the durable function: persisted, replayable,
  resumable across restarts and deploys.
- **`"use step"`** — side-effecting tools (`lookupAccount`, `issueRefund`,
  `executeTransfer`, the Slack posts) run exactly once and are memoized on replay.
- **Durable hooks** (`defineHook`) — `requestHumanApproval` and `requestHumanAgent` create
  a hook keyed to the tool call and `await` it; the Slack webhook and the in-app card both
  `resume()` that same token. `Promise.race` with a durable `sleep()` implements the
  fail-closed timeout.
- **Resumable streams** — the chat endpoint returns `x-workflow-run-id`, and
  `WorkflowChatTransport` reconnects to `GET /api/chat/{runId}/stream` if the connection
  drops, so a multi-minute human pause still delivers its result to the browser.

## Stack

- **Next.js 16** (App Router) + **TypeScript** + **Tailwind CSS v4**
- **WorkflowDevKit** — `workflow`, `@workflow/ai` (`DurableAgent`, `WorkflowChatTransport`)
- **AI SDK v6** + `@ai-sdk/anthropic` — Claude Sonnet 4.6
- **`@slack/web-api`** + manual HMAC verification (no extra Slack framework)
- **zod** for tool/schema validation

## Architecture decisions

- [ADR 0001 — Guardrails](docs/adr/0001-guardrails.md) — defense-in-depth, red-team results, residual risk
- [ADR 0002 — Architecture](docs/adr/0002-architecture.md) — durable workflow as the backbone, instructions-per-request, no DB

## Project structure

```
app/
  page.tsx                         chat UI + engineering console + editable instructions
  api/chat/route.ts                starts a durable run, streams the reply (+ run id header)
  api/chat/[id]/stream/route.ts    reconnect endpoint — re-attaches to a run's stream
  api/approve/route.ts             in-app approval → resumes the same durable hook
  api/slack/interactions/route.ts  HMAC-verified Slack webhook → resumes the workflow
lib/
  workflow/chat.ts                 the "use workflow" function + DurableAgent
  workflow/hooks.ts                the typed durable hook a human resolves
  workflow/slack-steps.ts          "use step" Slack calls (post / thread / resolve)
  agent/instructions.ts            default plain-text instructions (the editable policy)
  agent/tools.ts                   fintech tools with code-enforced authorization
  slack.ts                         Block Kit + HMAC signature verification
  case-trace.ts                    derives the case timeline/summary from the messages
  case-meta.ts                     operator metadata: category, country, response time, cost
next.config.ts                     withWorkflow() — installs the durable-execution transform
```

## License

MIT
