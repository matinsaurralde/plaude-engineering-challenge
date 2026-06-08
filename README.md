# Human-in-the-Loop AI Agent

An AI agent, governed by **plain-text instructions**, that runs a **human-in-the-loop
workflow over Slack**. When a request needs sign-off — a refund, a high-value transfer, an
ambiguous ask — the durable workflow **pauses**, asks a human in Slack to approve, deny, or
provide input, and then **resumes from the exact same point** once the human responds.

Built with [WorkflowDevKit](https://workflow-sdk.dev) (`DurableAgent`) on Next.js, as an
engineering challenge for [Plaude](https://plaude.com).

> **Matute** is the demo agent — a fintech support assistant. Its entire behaviour, including
> *when* to escalate to a human, comes from editable plain-text instructions, not hardcoded
> logic.

## How it works

```
Browser (chat UI)
   │  POST /api/chat  { messages, instructions }
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

## Stack

- **Next.js 16** (App Router) + **TypeScript** + **Tailwind CSS v4**
- **WorkflowDevKit** — `workflow`, `@workflow/ai` (`DurableAgent`)
- **AI SDK v6** + `@ai-sdk/anthropic` — Claude Sonnet 4.6
- **`@slack/web-api`** + manual HMAC verification (no extra Slack framework)
- **zod** for tool/schema validation

## Getting started

Prerequisites: Node 22+ and an [Anthropic API key](https://console.anthropic.com).

```bash
npm install
cp .env.example .env.local   # then add your ANTHROPIC_API_KEY
npm run dev
```

Open http://localhost:3000 and chat with the agent.

Slack and deployment configuration are documented as they are wired up (see `.env.example`
for the variables involved).

## Project structure

```
app/
  page.tsx              chat UI
  api/chat/route.ts     starts a durable run, streams the reply
lib/
  workflow/chat.ts      the "use workflow" function + DurableAgent
  agent/instructions.ts default plain-text instructions
next.config.ts          withWorkflow() — installs the durable-execution transform
```

## License

MIT
