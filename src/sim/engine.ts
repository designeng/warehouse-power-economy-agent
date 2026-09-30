// Hour-by-hour executor. Takes a plan and "conditions" (actual or forecast),
// applies battery physics, fleet charging, site rules and failsafes, and
// returns the bill. The same engine powers the real run and the agent's
// what-if tool (evaluate_plan), so the agent sees the same rules it is judged by.

import { round } from "./random.js";
import { CONSTRAINTS, FLEET_SCHEDULES, isAway, SITE } from "./world.js";
import type { BatteryHourPlan, DayResult, DayScenario, EnergyPlan, HourResult, SiteState, Vehicle } from "./types.js";

export interface Conditions {
  solarKw: number[];
  loadKw: number[];
  forkliftKwhPerHour: number;
  vanRouteKwh: number;
  prices: DayScenario["prices"];
}

export function actualConditions(s: DayScenario): Conditions {
  return { ...s.actual, prices: s.prices };
}

export function forecastConditions(s: DayScenario, solarCase: "p10" | "p50" | "p90" = "p50"): Conditions {
  const solar = { p10: s.forecast.solarP10Kw, p50: s.forecast.solarP50Kw, p90: s.forecast.solarP90Kw }[solarCase];
  return {
    solarKw: solar,
    loadKw: s.forecast.loadKw,
    forkliftKwhPerHour: s.forecast.forkliftKwhPerHour,
    vanRouteKwh: s.forecast.vanRouteKwh,
    prices: s.prices,
  };
}

function batteryPlanFor(plan: EnergyPlan, hour: number): BatteryHourPlan {
  return plan.battery.find((b) => b.hour === hour) ?? { hour, mode: "self_consume" };
}

export function runDay(state: SiteState, plan: EnergyPlan, c: Conditions): DayResult {
  const b = SITE.battery;
  const reserveKwh = (Math.max(CONSTRAINTS.batteryReserveSocPct, b.minSocPct) / 100) * b.capacityKwh;
  let socKwh = (state.batterySocPct / 100) * b.capacityKwh;
  const vehicles: Vehicle[] = state.vehicles.map((v) => ({ ...v }));
  const storedKwh = () => socKwh + vehicles.reduce((a, v) => a + (v.socPct / 100) * v.capacityKwh, 0);
  const startStoredKwh = storedKwh();

  const hours: HourResult[] = [];
  const violations: string[] = [];
  const failsafeActions: string[] = [];
  let energyCost = 0;
  let exportRevenue = 0;
  let peakImportKw = 0;
  let violationPenalty = 0;
  let importKwh = 0;
  let exportKwh = 0;
  let fleetKwh = 0;

  for (let h = 0; h < 24; h++) {
    const notes: string[] = [];

    // 1. Departures: check each group that leaves this hour has enough charge.
    for (const sched of FLEET_SCHEDULES.filter((s) => s.departHour === h)) {
      for (const v of vehicles.filter((v) => v.group === sched.group)) {
        if (v.socPct + 0.05 < sched.requiredSocPct) {
          violations.push(`${String(h).padStart(2, "0")}:00 ${v.id} departed at ${round(v.socPct)}% (needs ${sched.requiredSocPct}%)`);
          violationPenalty += CONSTRAINTS.vehicleShortfallPenalty;
        }
      }
    }

    // 2. Fleet charging requests for vehicles on chargers.
    const requests: Array<{ v: Vehicle; kw: number; forced: boolean }> = [];
    for (const v of vehicles) {
      const sched = FLEET_SCHEDULES.find((s) => s.group === v.group)!;
      if (isAway(sched, h)) continue;
      const groupPlan = plan.fleet.find((f) => f.group === v.group);
      const target = groupPlan?.targetSocPct ?? 100;
      const planned = groupPlan?.chargeHours.includes(h) ?? false;

      // Failsafe: if waiting any longer would make the vehicle miss its departure, charge now.
      let forced = false;
      if (h < sched.departHour) {
        const neededKwh = ((sched.requiredSocPct - v.socPct) / 100) * v.capacityKwh;
        const hoursLeftAfterThis = sched.departHour - h - 1;
        if (neededKwh > hoursLeftAfterThis * v.maxChargeKw + 0.01) forced = true;
      }

      const wantTarget = forced ? Math.max(target, sched.requiredSocPct) : target;
      if (!planned && !forced) continue;
      const kw = Math.min(v.maxChargeKw, Math.max(0, ((wantTarget - v.socPct) / 100) * v.capacityKwh));
      if (kw > 0.01) requests.push({ v, kw, forced });
    }
    // Charger bank limit: forced requests first, then lowest SoC first.
    requests.sort((a, b) => Number(b.forced) - Number(a.forced) || a.v.socPct - b.v.socPct);
    let bankLeft = SITE.chargers.maxTotalKw;
    for (const r of requests) {
      r.kw = Math.min(r.kw, bankLeft);
      bankLeft -= r.kw;
      if (r.forced && r.kw > 0) failsafeActions.push(`${String(h).padStart(2, "0")}:00 failsafe charge ${r.v.id} (${round(r.v.socPct)}%)`);
    }
    let fleetKw = requests.reduce((s, r) => s + r.kw, 0);

    // 3. Battery dispatch.
    const solar = c.solarKw[h];
    const load = c.loadKw[h];
    let net = load + fleetKw - solar;
    const chargeRoom = Math.min(b.maxChargeKw, Math.max(0, (b.capacityKwh - socKwh) / b.efficiency));
    const dischargeAvail = Math.min(b.maxDischargeKw, Math.max(0, (socKwh - reserveKwh) * b.efficiency));
    const bp = batteryPlanFor(plan, h);
    let mode = bp.mode;
    if (mode === "grid_charge" && CONSTRAINTS.noGridChargeHours.includes(h)) {
      mode = "hold";
      notes.push("grid_charge blocked in peak band → hold");
    }
    let batt = 0; // + charge, − discharge
    switch (mode) {
      case "self_consume":
        batt = net > 0 ? -Math.min(net, dischargeAvail) : Math.min(-net, chargeRoom);
        break;
      case "hold":
        batt = net < 0 ? Math.min(-net, chargeRoom) : 0;
        break;
      case "grid_charge":
        batt = Math.min(Math.max(bp.powerKw ?? b.maxChargeKw, net < 0 ? -net : 0), chargeRoom);
        break;
      case "discharge":
        batt = -Math.min(bp.powerKw ?? b.maxDischargeKw, dischargeAvail);
        break;
    }
    let grid = net + batt;

    // 4. Import cap (soft, from plan) and connection limit (hard): shed battery charging, then discharge.
    const shave = (limit: number, why: string) => {
      if (grid <= limit) return;
      if (batt > 0) {
        const cut = Math.min(batt, grid - limit);
        batt -= cut;
        grid -= cut;
      }
      if (grid > limit) {
        const extra = Math.min(grid - limit, dischargeAvail + Math.min(0, batt));
        if (extra > 0) {
          batt -= extra;
          grid -= extra;
          notes.push(`battery discharged extra ${round(extra)} kW (${why})`);
        }
      }
    };
    if (plan.importCapKw) shave(plan.importCapKw, "import cap");
    shave(SITE.grid.maxImportKw, "connection limit");
    if (grid > SITE.grid.maxImportKw) {
      // Curtail non-forced fleet charging.
      for (const r of requests.filter((r) => !r.forced)) {
        const cut = Math.min(r.kw, grid - SITE.grid.maxImportKw);
        r.kw -= cut;
        fleetKw -= cut;
        grid -= cut;
      }
      if (grid > SITE.grid.maxImportKw + 0.01) {
        violations.push(`${String(h).padStart(2, "0")}:00 import ${round(grid)} kW exceeded connection limit`);
        violationPenalty += CONSTRAINTS.breakerPenalty;
      }
    }
    if (grid < -SITE.grid.maxExportKw) {
      notes.push(`solar curtailed ${round(-SITE.grid.maxExportKw - grid)} kW (export limit)`);
      grid = -SITE.grid.maxExportKw;
    }
    net = load + fleetKw - solar;

    // 5. Apply energy flows.
    socKwh += batt > 0 ? batt * b.efficiency : batt / b.efficiency;
    for (const r of requests) r.v.socPct = Math.min(100, r.v.socPct + (r.kw / r.v.capacityKwh) * 100);
    fleetKwh += fleetKw;

    // Vehicles that are out working drain their batteries.
    for (const v of vehicles) {
      const sched = FLEET_SCHEDULES.find((s) => s.group === v.group)!;
      if (!isAway(sched, h)) continue;
      const kwh = v.kind === "forklift" ? c.forkliftKwhPerHour : c.vanRouteKwh / (sched.returnHour - sched.departHour);
      const before = v.socPct;
      v.socPct = Math.max(0, v.socPct - (kwh / v.capacityKwh) * 100);
      if (before > 0 && v.socPct === 0) {
        violations.push(`${String(h).padStart(2, "0")}:00 ${v.id} ran flat mid-shift`);
        violationPenalty += CONSTRAINTS.vehicleShortfallPenalty * 2;
      }
    }

    const priceImport = c.prices.importPerKwh[h];
    const cost = grid > 0 ? grid * priceImport : grid * c.prices.exportPerKwh[h];
    if (grid > 0) {
      energyCost += cost;
      importKwh += grid;
      peakImportKw = Math.max(peakImportKw, grid);
    } else {
      exportRevenue += -cost;
      exportKwh += -grid;
    }

    hours.push({
      hour: h,
      solarKw: round(solar),
      loadKw: round(load),
      fleetKw: round(fleetKw),
      batteryKw: round(batt),
      gridKw: round(grid),
      batterySocPct: round((socKwh / b.capacityKwh) * 100),
      priceImport,
      cost: round(cost, 2),
      notes,
    });
  }

  const demandCharge = peakImportKw * c.prices.demandChargePerKw;
  const billCost = energyCost - exportRevenue + demandCharge;
  const storageAdjustment = (startStoredKwh - storedKwh()) * CONSTRAINTS.storedEnergyValuePerKwh;
  const totalCost = billCost + violationPenalty + storageAdjustment;
  return {
    hours,
    energyCost: round(energyCost, 2),
    exportRevenue: round(exportRevenue, 2),
    demandCharge: round(demandCharge, 2),
    peakImportKw: round(peakImportKw),
    violationPenalty,
    storageAdjustment: round(storageAdjustment, 2),
    billCost: round(billCost, 2),
    totalCost: round(totalCost, 2),
    importKwh: round(importKwh),
    exportKwh: round(exportKwh),
    fleetKwh: round(fleetKwh),
    violations,
    failsafeActions,
    endState: {
      batterySocPct: round((socKwh / b.capacityKwh) * 100, 2),
      vehicles: vehicles.map((v) => ({ ...v, socPct: round(v.socPct, 2) })),
    },
  };
}
