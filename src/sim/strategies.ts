// Non-AI strategies used as yardsticks for the agent.
//
// - baselinePlan: the counterfactual ("what if there were no agent?").
//   The battery just self-consumes and every vehicle charges the moment it is plugged in.
// - rulesPlan: a typical hand-written if-then policy. Always fills the battery
//   overnight and charges the fleet only in cheap bands, regardless of weather.

import type { BatteryHourPlan, EnergyPlan, FleetGroupPlan } from "./types.js";
import { FLEET_SCHEDULES, isAway } from "./world.js";

const allHours = Array.from({ length: 24 }, (_, h) => h);

export function baselinePlan(): EnergyPlan {
  return {
    battery: allHours.map((hour) => ({ hour, mode: "self_consume" })),
    fleet: FLEET_SCHEDULES.map((s) => ({
      group: s.group,
      chargeHours: allHours.filter((h) => !isAway(s, h)),
      targetSocPct: 100,
    })),
    rationale: "Baseline: no optimisation. Battery self-consumes; vehicles charge as soon as they are plugged in.",
  };
}

export function rulesPlan(): EnergyPlan {
  const battery: BatteryHourPlan[] = allHours.map((hour) =>
    hour < 6 ? { hour, mode: "grid_charge", powerKw: 200 } : { hour, mode: "self_consume" },
  );
  const cheap = (h: number) => h < 6 || (h >= 10 && h < 15);
  const fleet: FleetGroupPlan[] = FLEET_SCHEDULES.map((s) => ({
    group: s.group,
    chargeHours: allHours.filter((h) => !isAway(s, h) && cheap(h)),
    targetSocPct: 100,
  }));
  return {
    battery,
    fleet,
    rationale: "Rules: grid-charge battery 00–06 every night; charge fleet only in off-peak and solar-soak bands.",
  };
}
