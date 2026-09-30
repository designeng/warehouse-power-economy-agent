// Backend 1: Anthropic API (pay per token, needs ANTHROPIC_API_KEY).
// Uses the SDK's tool runner, which runs the loop: call the model, run the
// requested tools, send the results back, and repeat until the model stops.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { dailyPrompt, SYSTEM_PROMPT } from "../prompt.js";
import { createTools, type PlanningContext } from "../tools.js";
import type { AgentBackend } from "./types.js";

// $ per million tokens: input, output, cache read, cache write (5-minute TTL).
const PRICING: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25],
};

export const runWithApi: AgentBackend = async (ctx: PlanningContext, opts) => {
  const client = new Anthropic();

  const tools = createTools(ctx).map((t) =>
    betaZodTool({
      name: t.name,
      description: t.description,
      inputSchema: z.object(t.shape),
      run: async (input) => {
        const out = (t.handler as (i: unknown) => unknown)(input);
        if (opts.verbose) console.log(`    🔧 ${t.name}`);
        return JSON.stringify(out);
      },
    }),
  );

  const runner = client.beta.messages.toolRunner({
    model: opts.model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools,
    output_config: { effort: opts.effort },
    // Automatically cache the growing prefix (tools + system + history) between loop iterations.
    cache_control: { type: "ephemeral" },
    // If the model refuses, the API retries the same request on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    max_iterations: 25,
    messages: [{ role: "user", content: dailyPrompt(ctx.scenario.date) }],
  });

  const transcript: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let turns = 0;
  let last: Anthropic.Beta.BetaMessage | undefined;

  for await (const message of runner) {
    turns++;
    last = message;
    usage.inputTokens += message.usage.input_tokens;
    usage.outputTokens += message.usage.output_tokens;
    usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) {
        transcript.push(block.text);
        if (opts.verbose) console.log(`    💬 ${block.text.trim().split("\n")[0].slice(0, 140)}`);
      }
    }
    if (message.stop_reason === "refusal") {
      transcript.push(`[refusal: ${message.stop_details?.category ?? "unknown"}]`);
    }
  }

  const [pin, pout, pread, pwrite] = PRICING[opts.model] ?? PRICING["claude-opus-5-5"];
  const costUsd =
    (usage.inputTokens * pin + usage.outputTokens * pout + usage.cacheReadTokens * pread + usage.cacheWriteTokens * pwrite) / 1e6;

  const summary = last?.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim() ?? "";
  return { summary, transcript, turns, usage, costUsd };
};
