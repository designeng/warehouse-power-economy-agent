import type { PlanningContext } from "../tools.js";

export interface AgentRunResult {
  /** Final text reply from the agent (its summary). */
  summary: string;
  /** Visible text the agent wrote along the way, for the decision log. */
  transcript: string[];
  turns: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  /** Estimated $ cost of the model calls. On a subscription this is a notional API-equivalent figure. */
  costUsd: number;
}

export interface AgentOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  verbose: boolean;
}

export type AgentBackend = (ctx: PlanningContext, opts: AgentOptions) => Promise<AgentRunResult>;
