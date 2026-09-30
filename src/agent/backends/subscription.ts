// Backend 2: Claude Agent SDK, authenticated with your Claude subscription
// (Pro/Max/Team). It uses the same login as the `claude` CLI, so run `claude`
// once and sign in first. No API key is needed.
//
// The Agent SDK runs the Claude Code agent loop. Our tools are exposed to it
// through an in-process MCP server, and we turn off Claude Code's built-in tools
// (Bash, Read, Edit, ...) so the agent can only touch the warehouse.

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { dailyPrompt, SYSTEM_PROMPT } from "../prompt.js";
import { createTools, type PlanningContext } from "../tools.js";
import type { AgentBackend } from "./types.js";

const SERVER = "warehouse";

export const runWithSubscription: AgentBackend = async (ctx: PlanningContext, opts) => {
  const defs = createTools(ctx);

  const server = createSdkMcpServer({
    name: SERVER,
    version: "1.0.0",
    tools: defs.map((t) =>
      tool(t.name, t.description, t.shape, async (input: unknown) => {
        const out = (t.handler as (i: unknown) => unknown)(input);
        if (opts.verbose) console.log(`    🔧 ${t.name}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      }),
    ),
  });

  // Drop API keys from the child process env so the SDK falls back to the
  // subscription login instead of silently billing an API key.
  const { ANTHROPIC_API_KEY: _k, ANTHROPIC_AUTH_TOKEN: _t, ...env } = process.env;

  const transcript: string[] = [];
  let summary = "";
  let turns = 0;
  let costUsd = 0;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for await (const msg of query({
    prompt: dailyPrompt(ctx.scenario.date),
    options: {
      model: opts.model,
      effort: opts.effort,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { [SERVER]: server },
      tools: [], // no built-in Claude Code tools
      allowedTools: defs.map((t) => `mcp__${SERVER}__${t.name}`),
      settingSources: [], // ignore local CLAUDE.md / settings so runs are reproducible
      persistSession: false,
      maxTurns: 25,
      env,
    },
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) {
          transcript.push(block.text);
          if (opts.verbose) console.log(`    💬 ${block.text.trim().split("\n")[0].slice(0, 140)}`);
        }
      }
    } else if (msg.type === "result") {
      turns = msg.num_turns;
      costUsd = msg.total_cost_usd;
      for (const u of Object.values(msg.modelUsage)) {
        usage.inputTokens += u.inputTokens;
        usage.outputTokens += u.outputTokens;
        usage.cacheReadTokens += u.cacheReadInputTokens;
        usage.cacheWriteTokens += u.cacheCreationInputTokens;
      }
      if (msg.subtype === "success") summary = msg.result;
      else transcript.push(`[agent ended: ${msg.subtype}]`);
    }
  }

  return { summary, transcript, turns, usage, costUsd };
};
