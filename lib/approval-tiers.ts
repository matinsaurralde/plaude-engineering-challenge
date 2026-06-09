// The approver escalation ladder, low → high. Lives in its own Node-free module so the tools
// (which run inside the durable workflow) can import it without pulling in @slack/web-api or
// node:crypto — those are only allowed in "use step" functions, not in workflow code.
export const DEFAULT_TIERS = ["Support", "Finance", "Compliance"] as const;
