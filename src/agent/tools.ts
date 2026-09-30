// The agent's tools. Each tool is defined once (name, description, Zod shape,
// handler) and then adapted to whichever backend runs the agent:
//   - backends/api.ts           → Anthropic API tool runner (betaZodTool)
//   - backends/subscription.ts  → Claude Agent SDK in-process MCP server (tool())
//
// Read tools only see the FORECAST. The actual weather/load stays hidden until
// the engine executes the plan, just like in real life.

import { z } from "zod";
import { forecastConditions, runDay } from "../sim/engine.js";
import { round } from "../sim/random.js";
import type { BatteryHourPlan, DayResult, DayScenario, EnergyPlan, FleetGroup, SiteState } from "../sim/types.js";
import { CONSTRAINTS, FLEET_SCHEDULES, SITE } from "../sim/world.js";

export interface DayHistory {
  date: string;
  regime: string;
  forecastSolarKwh: number;
  actualSolarKwh: number;
  forecastLoadKwh: number;
  actualLoadKwh: number;
  agentCost: number;
  baselineCost: number;
  violations: string[];
}

export interface PlanningContext {
  scenario: DayScenario;
  state: SiteState;
  history: DayHistory[];
  /** Set by submit_plan. */
  submittedPlan?: EnergyPlan;
  /** Every tool call, for the decision log. */
  toolLog: Array<{ tool: string; input: unknown }>;
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  shape: Shape;
  handler: (input: z.infer<z.ZodObject<Shape>>) => unknown;
}

const defineTool = <Shape extends z.ZodRawShape>(t: ToolDef<Shape>) => t;

const sum = (xs: number[]) => round(xs.reduce((s, x) => s + x, 0));
const GROUPS = ["forklifts_shift_a", "forklifts_shift_b", "vans"] as const;
const hour = z.number().int().min(0).max(23);

// --- Plan schema --------------------------------------------------------------

const planShape = {
  battery_schedule: z
    .array(
      z.object({
        start_hour: hour,
        end_hour: z.number().int().min(1).max(24).describe("Exclusive"),
        mode: z.enum(["self_consume", "grid_charge", "hold", "discharge"]),
        power_kw: z.number().min(0).optional().describe("Required for grid_charge and discharge"),
      }),
    )
    .describe("Time blocks. Hours not covered default to self_consume."),
  fleet_charging: z
    .array(
      z.object({
        group: z.enum(GROUPS),
        charge_hours: z.array(hour).describe("Hours in which this group may charge (only while plugged in)"),
        target_soc_pct: z.number().min(0).max(100),
      }),
    )
    .describe("One entry per fleet group. A group left out charges whenever plugged in, to 100%."),
  import_cap_kw: z.number().positive().optional().describe("Soft cap on grid import; battery discharges to hold it"),
  rationale: z.string().describe("Short explanation of the plan and the risks it hedges"),
};

type PlanInput = z.infer<z.ZodObject<typeof planShape>>;

export function toEnergyPlan(input: PlanInput): EnergyPlan {
  const battery: BatteryHourPlan[] = [];
  for (let h = 0; h < 24; h++) {
    // Later blocks win if they overlap.
    const block = [...input.battery_schedule].reverse().find((b) => h >= b.start_hour && h < b.end_hour);
    battery.push(block ? { hour: h, mode: block.mode, powerKw: block.power_kw } : { hour: h, mode: "self_consume" });
  }
  const fleet = FLEET_SCHEDULES.map((s) => {
    const p = input.fleet_charging.find((f) => f.group === s.group);
    return p
      ? { group: s.group as FleetGroup, chargeHours: p.charge_hours, targetSocPct: p.target_soc_pct }
      : { group: s.group as FleetGroup, chargeHours: Array.from({ length: 24 }, (_, h) => h), targetSocPct: 100 };
  });
  return { battery, fleet, importCapKw: input.import_cap_kw, rationale: input.rationale };
}

function summarize(r: DayResult) {
  return {
    total_cost: r.totalCost,
    bill: r.billCost,
    energy_cost: r.energyCost,
    export_revenue: r.exportRevenue,
    demand_charge: r.demandCharge,
    peak_import_kw: r.peakImportKw,
    penalties: r.violationPenalty,
    stored_energy_adjustment: r.storageAdjustment,
    import_kwh: r.importKwh,
    export_kwh: r.exportKwh,
    end_battery_soc_pct: r.endState.batterySocPct,
    violations: r.violations,
    failsafe_actions: r.failsafeActions.slice(0, 10),
    hourly: r.hours.map((h) => `${String(h.hour).padStart(2, "0")} solar=${h.solarKw} load=${h.loadKw} fleet=${h.fleetKw} batt=${h.batteryKw} grid=${h.gridKw} soc=${h.batterySocPct}% $=${h.cost}`),
  };
}

// --- Tools --------------------------------------------------------------------

export function createTools(ctx: PlanningContext) {
  const s = ctx.scenario;
  const log = (tool: string, input: unknown) => ctx.toolLog.push({ tool, input });

  return [
    defineTool({
      name: "get_battery_status",
      description: "Current state of the site battery: state of charge, capacity, power limits and efficiency.",
      shape: {},
      handler: () => {
        log("get_battery_status", {});
        const b = SITE.battery;
        const soc = ctx.state.batterySocPct;
        return {
          soc_pct: soc,
          stored_kwh: round((soc / 100) * b.capacityKwh),
          usable_above_reserve_kwh: round(Math.max(0, ((soc - CONSTRAINTS.batteryReserveSocPct) / 100) * b.capacityKwh)),
          capacity_kwh: b.capacityKwh,
          max_charge_kw: b.maxChargeKw,
          max_discharge_kw: b.maxDischargeKw,
          round_trip_efficiency: round(b.efficiency ** 2, 3),
        };
      },
    }),

    defineTool({
      name: "get_solar_forecast",
      description: `Hourly rooftop solar forecast (kW, ${SITE.solar.capacityKwp} kWp array) for tomorrow as P10 (pessimistic), P50 (expected) and P90 (optimistic), plus daily totals.`,
      shape: {},
      handler: () => {
        log("get_solar_forecast", {});
        return {
          date: s.date,
          p10_kw: s.forecast.solarP10Kw,
          p50_kw: s.forecast.solarP50Kw,
          p90_kw: s.forecast.solarP90Kw,
          daily_kwh: { p10: sum(s.forecast.solarP10Kw), p50: sum(s.forecast.solarP50Kw), p90: sum(s.forecast.solarP90Kw) },
        };
      },
    }),

    defineTool({
      name: "get_weather_forecast",
      description: "Hourly weather forecast for tomorrow: temperature (drives heating load), cloud cover and rain probability.",
      shape: {},
      handler: () => {
        log("get_weather_forecast", {});
        const w = s.forecast.weather;
        return {
          date: s.date,
          hourly: w.map((x, h) => ({ hour: h, temp_c: x.tempC, cloud_pct: x.cloudPct, rain_prob_pct: x.rainProbPct })),
          min_temp_c: Math.min(...w.map((x) => x.tempC)),
          max_temp_c: Math.max(...w.map((x) => x.tempC)),
          avg_cloud_pct: Math.round(w.reduce((a, x) => a + x.cloudPct, 0) / 24),
        };
      },
    }),

    defineTool({
      name: "get_electricity_prices",
      description: "Tomorrow's hourly import and export prices ($/kWh), tariff bands, network events, and the demand charge.",
      shape: {},
      handler: () => {
        log("get_electricity_prices", {});
        return {
          date: s.date,
          hourly: s.prices.importPerKwh.map((p, h) => ({ hour: h, band: s.prices.tariffBands[h], import: p, export: s.prices.exportPerKwh[h] })),
          demand_charge_per_kw: s.prices.demandChargePerKw,
          demand_charge_note: "Charged on the single highest hourly grid import of the day.",
          events: s.prices.events,
        };
      },
    }),

    defineTool({
      name: "get_workload_forecast",
      description: "Tomorrow's warehouse workload: orders per hour, shift pattern, and the forecast site load in kW (excluding fleet charging).",
      shape: {},
      handler: () => {
        log("get_workload_forecast", {});
        return {
          date: s.date,
          shifts: [
            { name: "A", from: 6, to: 14 },
            { name: "B", from: 14, to: 22 },
          ],
          orders_per_hour: s.forecast.ordersPerHour,
          site_load_kw: s.forecast.loadKw,
          site_load_kwh: sum(s.forecast.loadKw),
          forklift_kwh_per_working_hour: s.forecast.forkliftKwhPerHour,
          van_route_kwh_each: s.forecast.vanRouteKwh,
          notes: s.forecast.notes,
        };
      },
    }),

    defineTool({
      name: "get_fleet_status",
      description: "Electric forklifts and delivery vans: current state of charge, capacity, charger power, and when each group is away or plugged in.",
      shape: {},
      handler: () => {
        log("get_fleet_status", {});
        return {
          charger_bank_max_kw: SITE.chargers.maxTotalKw,
          groups: FLEET_SCHEDULES.map((sched) => {
            const vs = ctx.state.vehicles.filter((v) => v.group === sched.group);
            return {
              group: sched.group,
              away_from_hour: sched.departHour,
              back_at_hour: sched.returnHour,
              required_soc_at_departure_pct: sched.requiredSocPct,
              vehicles: vs.map((v) => ({ id: v.id, soc_pct: round(v.socPct), capacity_kwh: v.capacityKwh, charger_kw: v.maxChargeKw })),
              kwh_needed_to_reach_required: round(
                vs.reduce((a, v) => a + Math.max(0, ((sched.requiredSocPct - v.socPct) / 100) * v.capacityKwh), 0),
              ),
            };
          }),
        };
      },
    }),

    defineTool({
      name: "get_operational_constraints",
      description: "Site rules and hard limits the plan must respect, and the penalties for breaking them.",
      shape: {},
      handler: () => {
        log("get_operational_constraints", {});
        return {
          grid_max_import_kw: SITE.grid.maxImportKw,
          grid_max_export_kw: SITE.grid.maxExportKw,
          battery_reserve_soc_pct: CONSTRAINTS.batteryReserveSocPct,
          battery_reserve_reason: "Cold-room ride-through during outages. The battery will not discharge below this.",
          no_grid_charging_hours: CONSTRAINTS.noGridChargeHours,
          vehicle_shortfall_penalty_per_vehicle: CONSTRAINTS.vehicleShortfallPenalty,
          connection_limit_penalty: CONSTRAINTS.breakerPenalty,
          stored_energy_value_per_kwh: CONSTRAINTS.storedEnergyValuePerKwh,
          stored_energy_note:
            "Energy left in the battery and vehicles at midnight is credited at this price, and energy drawn down is charged. Leaving vehicles flat for tomorrow is not free.",
          failsafe:
            "The site controller force-charges any vehicle that would otherwise miss its departure SoC, at whatever the price is at that hour.",
        };
      },
    }),

    defineTool({
      name: "get_recent_history",
      description: "The last 7 days: forecast vs actual solar and load, what the agent's plan cost, and what doing nothing would have cost. Use it to calibrate how much to trust forecasts.",
      shape: {},
      handler: () => {
        log("get_recent_history", {});
        return { days: ctx.history.slice(-7) };
      },
    }),

    defineTool({
      name: "evaluate_plan",
      description:
        "Dry-run a candidate plan in the site simulator against the FORECAST (not the actual day). Returns the projected bill, peak import, violations and an hourly trace. Try the pessimistic solar case (p10) to test how robust a plan is.",
      shape: { ...planShape, solar_case: z.enum(["p10", "p50", "p90"]).default("p50") },
      handler: (input) => {
        log("evaluate_plan", input);
        const plan = toEnergyPlan(input);
        return summarize(runDay(ctx.state, plan, forecastConditions(s, input.solar_case)));
      },
    }),

    defineTool({
      name: "submit_plan",
      description: "Submit the final plan for tomorrow. Call exactly once, when you are done. The site controller will execute it hour by hour.",
      shape: planShape,
      handler: (input) => {
        log("submit_plan", input);
        ctx.submittedPlan = toEnergyPlan(input);
        return { status: "accepted", message: "Plan accepted. It will run from 00:00." };
      },
    }),
  ];
}

export type Tool = ReturnType<typeof createTools>[number];
