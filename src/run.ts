// Runs the warehouse for N days with three strategies side by side:
//   baseline: no agent (the counterfactual)
//   rules:    a fixed if-then policy
//   agent:    Claude plans each night via tools (API key or subscription)
// Each strategy carries its own battery/fleet state forward from day to day.
//
//   npm run sim -- --days 14 --backend subscription
//   npm run sim -- --days 7  --backend api --model claude-sonnet-5-5
//   npm run sim -- --days 30 --backend none        # no LLM, just baseline vs rules

import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runWithApi } from "./agent/backends/api.js";
import { runWithSubscription } from "./agent/backends/subscription.js";
import type { AgentBackend, AgentOptions, AgentRunResult } from "./agent/backends/types.js";
import type { DayHistory, PlanningContext } from "./agent/tools.js";
import { actualConditions, runDay } from "./sim/engine.js";
import { round } from "./sim/random.js";
import { baselinePlan, rulesPlan } from "./sim/strategies.js";
import type { DayResult, EnergyPlan, SiteState, WeatherRegime } from "./sim/types.js";
import { generateDay, initialState } from "./sim/world.js";

const { values: args } = parseArgs({
  options: {
    days: { type: "string", default: "7" },
    seed: { type: "string", default: "42" },
    start: { type: "string", default: "2026-06-01" },
    backend: { type: "string", default: "subscription" }, // subscription | api | none
    model: { type: "string", default: "claude-opus-5-5" },
    effort: { type: "string", default: "medium" },
    quiet: { type: "boolean", default: false },
  },
});

const days = Number(args.days);
const seed = Number(args.seed);
const backends: Record<string, AgentBackend | null> = { api: runWithApi, subscription: runWithSubscription, none: null };
if (!(args.backend! in backends)) throw new Error(`--backend must be one of: ${Object.keys(backends).join(", ")}`);
const backend = backends[args.backend!];
const agentOpts: AgentOptions = {
  model: args.model!,
  effort: args.effort as AgentOptions["effort"],
  verbose: !args.quiet,
};

const runDir = `runs/${new Date().toISOString().replace(/[:.]/g, "-")}`;
mkdirSync(runDir, { recursive: true });

const states: Record<"baseline" | "rules" | "agent", SiteState> = {
  baseline: initialState(),
  rules: initialState(),
  agent: initialState(),
};
const history: DayHistory[] = [];
const rows: Array<Record<string, string | number>> = [];
const totals = { baseline: 0, rules: 0, agent: 0, llm: 0, violations: 0 };

const sumKwh = (xs: number[]) => round(xs.reduce((a, x) => a + x, 0));
const money = (x: number) => `$${x.toFixed(2)}`;

console.log(`\n⚡ Warehouse energy agent: ${days} days from ${args.start}, backend=${args.backend}, model=${args.model}\n`);

let regime: WeatherRegime = "mixed";
for (let d = 0; d < days; d++) {
  const scenario = generateDay(seed, d, args.start!, regime);
  regime = scenario.regime;
  const actual = actualConditions(scenario);

  const baseline = runDay(states.baseline, baselinePlan(), actual);
  const rules = runDay(states.rules, rulesPlan(), actual);

  console.log(`📅 ${scenario.date} (${scenario.regime}) solar fc ${sumKwh(scenario.forecast.solarP50Kw)} kWh, actual ${sumKwh(scenario.actual.solarKw)} kWh`);

  let agentResult: DayResult | undefined;
  let run: AgentRunResult | undefined;
  let plan: EnergyPlan | undefined;
  if (backend) {
    const ctx: PlanningContext = { scenario, state: states.agent, history, toolLog: [] };
    try {
      run = await backend(ctx, agentOpts);
    } catch (err) {
      console.error(`    ❌ agent error: ${(err as Error).message}`);
    }
    // Fail safe: if the agent crashed or never submitted, fall back to the rule-based plan.
    plan = ctx.submittedPlan ?? { ...rulesPlan(), rationale: "FALLBACK: agent did not submit a plan" };
    agentResult = runDay(states.agent, plan, actual);
    states.agent = agentResult.endState;
    totals.agent += agentResult.totalCost;
    totals.llm += run?.costUsd ?? 0;
    totals.violations += agentResult.violations.length;

    history.push({
      date: scenario.date,
      regime: scenario.regime,
      forecastSolarKwh: sumKwh(scenario.forecast.solarP50Kw),
      actualSolarKwh: sumKwh(scenario.actual.solarKw),
      forecastLoadKwh: sumKwh(scenario.forecast.loadKw),
      actualLoadKwh: sumKwh(scenario.actual.loadKw),
      agentCost: agentResult.totalCost,
      baselineCost: baseline.totalCost,
      violations: agentResult.violations,
    });

    writeFileSync(
      `${runDir}/day-${String(d + 1).padStart(2, "0")}-${scenario.date}.json`,
      JSON.stringify({ scenario, plan, toolLog: ctx.toolLog, agent: run, result: agentResult, baseline, rules }, null, 2),
    );
  }

  states.baseline = baseline.endState;
  states.rules = rules.endState;
  totals.baseline += baseline.totalCost;
  totals.rules += rules.totalCost;

  const row: Record<string, string | number> = {
    date: scenario.date,
    weather: scenario.regime,
    baseline: money(baseline.totalCost),
    rules: money(rules.totalCost),
  };
  if (agentResult) {
    row.agent = money(agentResult.totalCost);
    row.saved = money(baseline.totalCost - agentResult.totalCost);
    row.llm = money(run?.costUsd ?? 0);
    row.issues = agentResult.violations.length;
    console.log(`    ✅ agent ${money(agentResult.totalCost)} vs baseline ${money(baseline.totalCost)} vs rules ${money(rules.totalCost)} · LLM ${money(run?.costUsd ?? 0)} · ${run?.turns ?? 0} turns`);
    if (agentResult.violations.length) console.log(`    ⚠️  ${agentResult.violations.join("; ")}`);
  }
  rows.push(row);
}

console.log("\n📊 Results");
console.table(rows);

const summary = {
  days,
  seed,
  backend: args.backend,
  model: args.model,
  effort: args.effort,
  baselineCost: round(totals.baseline, 2),
  rulesCost: round(totals.rules, 2),
  agentCost: backend ? round(totals.agent, 2) : null,
  llmCostUsd: backend ? round(totals.llm, 2) : null,
  agentViolations: totals.violations,
};
writeFileSync(`${runDir}/summary.json`, JSON.stringify({ summary, rows }, null, 2));

console.log(`Baseline (no agent): ${money(totals.baseline)}`);
console.log(`Rules (if-then):     ${money(totals.rules)}   saved ${money(totals.baseline - totals.rules)}`);
if (backend) {
  const saved = totals.baseline - totals.agent;
  console.log(`Agent:               ${money(totals.agent)}   saved ${money(saved)} (${round((saved / totals.baseline) * 100)}%)`);
  console.log(`LLM cost:            ${money(totals.llm)}${args.backend === "subscription" ? " (API-equivalent estimate; covered by your subscription)" : ""}`);
  console.log(`Net of LLM cost:     ${money(saved - totals.llm)}`);
}
console.log(`\nDecision logs: ${runDir}/`);
