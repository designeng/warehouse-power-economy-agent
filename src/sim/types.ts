// Shared types for the simulated warehouse energy system.
// Every array indexed by hour has length 24 (hour 0 = 00:00–01:00 local time).

export type Hourly<T = number> = T[];

export interface SiteConfig {
  name: string;
  solar: { capacityKwp: number };
  battery: {
    capacityKwh: number;
    maxChargeKw: number;
    maxDischargeKw: number;
    /** One-way efficiency applied on charge and on discharge (round trip ≈ eff²). */
    efficiency: number;
    /** Hard floor enforced by the battery management system. */
    minSocPct: number;
  };
  grid: {
    /** Site connection limit. Import above this trips the main breaker. */
    maxImportKw: number;
    maxExportKw: number;
  };
  chargers: {
    /** Shared charger bank limit for the whole fleet. */
    maxTotalKw: number;
  };
}

export type VehicleKind = "forklift" | "van";
export type FleetGroup = "forklifts_shift_a" | "forklifts_shift_b" | "vans";

export interface Vehicle {
  id: string;
  kind: VehicleKind;
  group: FleetGroup;
  capacityKwh: number;
  maxChargeKw: number;
  socPct: number;
}

/** When a fleet group is away/working, and what charge it needs before it leaves. */
export interface GroupSchedule {
  group: FleetGroup;
  /** Hour the group leaves the charger (start of shift / route). */
  departHour: number;
  /** Hour the group is back on the charger. */
  returnHour: number;
  /** Required state of charge at departHour. */
  requiredSocPct: number;
}

export type WeatherRegime = "sunny" | "mixed" | "overcast" | "storm";

export interface WeatherHour {
  tempC: number;
  cloudPct: number;
  rainProbPct: number;
}

/** One simulated day: the "truth" and the forecast the agent is allowed to see. */
export interface DayScenario {
  dayIndex: number;
  date: string; // ISO date
  regime: WeatherRegime;
  actual: {
    weather: Hourly<WeatherHour>;
    solarKw: Hourly;
    /** Warehouse load excluding fleet charging. */
    loadKw: Hourly;
    ordersPerHour: Hourly;
    /** Energy each van uses on today's routes (kWh). */
    vanRouteKwh: number;
    /** Energy each forklift uses per working hour (kWh). */
    forkliftKwhPerHour: number;
  };
  forecast: {
    weather: Hourly<WeatherHour>;
    solarP10Kw: Hourly;
    solarP50Kw: Hourly;
    solarP90Kw: Hourly;
    loadKw: Hourly;
    ordersPerHour: Hourly;
    vanRouteKwh: number;
    forkliftKwhPerHour: number;
    notes: string[];
  };
  prices: {
    importPerKwh: Hourly;
    exportPerKwh: Hourly;
    /** $ per kW of the day's highest hourly import (daily share of a monthly demand charge). */
    demandChargePerKw: number;
    tariffBands: Hourly<string>;
    events: string[];
  };
}

export type BatteryMode = "self_consume" | "grid_charge" | "hold" | "discharge";

export interface BatteryHourPlan {
  hour: number;
  mode: BatteryMode;
  /** Only used for grid_charge / discharge. */
  powerKw?: number;
}

export interface FleetGroupPlan {
  group: FleetGroup;
  /** Hours in which the group is allowed to charge. */
  chargeHours: number[];
  /** Stop charging once each vehicle reaches this SoC. */
  targetSocPct: number;
}

export interface EnergyPlan {
  battery: BatteryHourPlan[];
  fleet: FleetGroupPlan[];
  /** Optional soft cap: the executor discharges the battery to keep grid import below this. */
  importCapKw?: number;
  rationale: string;
}

export interface SiteState {
  batterySocPct: number;
  vehicles: Vehicle[];
}

export interface HourResult {
  hour: number;
  solarKw: number;
  loadKw: number;
  fleetKw: number;
  batteryKw: number; // + charging, − discharging (AC side)
  gridKw: number; // + import, − export
  batterySocPct: number;
  priceImport: number;
  cost: number;
  notes: string[];
}

export interface DayResult {
  hours: HourResult[];
  energyCost: number;
  exportRevenue: number;
  demandCharge: number;
  peakImportKw: number;
  violationPenalty: number;
  /** (stored energy at start − at end) × valuation. Positive = the day drew down stored energy. */
  storageAdjustment: number;
  /** What the utility bill says: energy − export + demand charge. */
  billCost: number;
  /** billCost + penalties + storageAdjustment. The number strategies are compared on. */
  totalCost: number;
  importKwh: number;
  exportKwh: number;
  fleetKwh: number;
  violations: string[];
  failsafeActions: string[];
  endState: SiteState;
}
