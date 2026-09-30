// The simulated world: site hardware, fleet, tariffs, and a day-by-day
// generator for weather, solar and workload (both "actual" and "forecast").

import { clamp, gaussian, mulberry32, pick, round, type Rng } from "./random.js";
import type {
  DayScenario,
  FleetGroup,
  GroupSchedule,
  Hourly,
  SiteConfig,
  SiteState,
  Vehicle,
  WeatherHour,
  WeatherRegime,
} from "./types.js";

export const SITE: SiteConfig = {
  name: "Northgate Distribution Centre",
  solar: { capacityKwp: 400 },
  battery: {
    capacityKwh: 500,
    maxChargeKw: 200,
    maxDischargeKw: 200,
    efficiency: 0.95,
    minSocPct: 10,
  },
  grid: { maxImportKw: 350, maxExportKw: 150 },
  chargers: { maxTotalKw: 80 },
};

export const FLEET_SCHEDULES: GroupSchedule[] = [
  { group: "forklifts_shift_a", departHour: 6, returnHour: 14, requiredSocPct: 85 },
  { group: "forklifts_shift_b", departHour: 14, returnHour: 22, requiredSocPct: 85 },
  { group: "vans", departHour: 7, returnHour: 17, requiredSocPct: 90 },
];

/** Business rules the site must respect. The engine enforces them; the agent should plan around them. */
export const CONSTRAINTS = {
  /** Cold-room ride-through: the battery may never be discharged below this SoC. */
  batteryReserveSocPct: 20,
  /** Network agreement: no grid-charging the battery during the peak band. */
  noGridChargeHours: [15, 16, 17, 18, 19, 20],
  /** $ penalty per vehicle that is below its required SoC when its shift/route starts. */
  vehicleShortfallPenalty: 60,
  /** $ penalty if site import exceeds the connection limit (main breaker trip risk). */
  breakerPenalty: 500,
  /**
   * End-of-day valuation of stored energy (battery + vehicles), $/kWh = tomorrow's off-peak refill price.
   * Without it a one-day planner could "save" money by leaving everything flat for tomorrow.
   */
  storedEnergyValuePerKwh: 0.09,
};

const SHIFT_HOURS = { start: 6, end: 22 };

export function isAway(schedule: GroupSchedule, hour: number): boolean {
  return hour >= schedule.departHour && hour < schedule.returnHour;
}

export function scheduleFor(group: FleetGroup): GroupSchedule {
  return FLEET_SCHEDULES.find((s) => s.group === group)!;
}

export function initialState(): SiteState {
  const vehicles: Vehicle[] = [];
  for (let i = 1; i <= 6; i++) {
    vehicles.push({ id: `FL-A${i}`, kind: "forklift", group: "forklifts_shift_a", capacityKwh: 30, maxChargeKw: 6, socPct: 55 + i * 3 });
    vehicles.push({ id: `FL-B${i}`, kind: "forklift", group: "forklifts_shift_b", capacityKwh: 30, maxChargeKw: 6, socPct: 40 + i * 2 });
  }
  for (let i = 1; i <= 3; i++) {
    vehicles.push({ id: `VAN-${i}`, kind: "van", group: "vans", capacityKwh: 75, maxChargeKw: 11, socPct: 60 + i * 5 });
  }
  return { batterySocPct: 45, vehicles };
}

// ---------------------------------------------------------------------------
// Tariff: a winter time-of-use plan with a cheap overnight window.

const BANDS: Array<{ from: number; to: number; name: string; price: number }> = [
  { from: 0, to: 6, name: "off-peak", price: 0.09 },
  { from: 6, to: 10, name: "shoulder", price: 0.24 },
  { from: 10, to: 15, name: "solar-soak", price: 0.16 },
  { from: 15, to: 21, name: "peak", price: 0.46 },
  { from: 21, to: 24, name: "shoulder", price: 0.24 },
];
const EXPORT_PRICE = 0.05;
const DEMAND_CHARGE_PER_KW_DAY = 0.45;

// ---------------------------------------------------------------------------
// Weather regimes follow a Markov chain so bad weather comes in spells.

const REGIME_TRANSITIONS: Record<WeatherRegime, Array<[WeatherRegime, number]>> = {
  sunny: [["sunny", 0.5], ["mixed", 0.3], ["overcast", 0.15], ["storm", 0.05]],
  mixed: [["sunny", 0.3], ["mixed", 0.35], ["overcast", 0.25], ["storm", 0.1]],
  overcast: [["sunny", 0.15], ["mixed", 0.35], ["overcast", 0.35], ["storm", 0.15]],
  storm: [["sunny", 0.1], ["mixed", 0.3], ["overcast", 0.4], ["storm", 0.2]],
};

const REGIME_WEATHER: Record<WeatherRegime, { cloud: number; tMin: number; tMax: number; rain: number }> = {
  sunny: { cloud: 10, tMin: 1, tMax: 15, rain: 5 },
  mixed: { cloud: 45, tMin: 4, tMax: 13, rain: 30 },
  overcast: { cloud: 80, tMin: 6, tMax: 10, rain: 60 },
  storm: { cloud: 95, tMin: 5, tMax: 8, rain: 95 },
};

/** Winter clear-sky output as a fraction of kWp for each hour (sunrise ~7, sunset ~17). */
function clearSkyFraction(hour: number): number {
  const mid = hour + 0.5;
  if (mid < 7 || mid > 17) return 0;
  return 0.62 * Math.sin((Math.PI * (mid - 7)) / 10);
}

function solarFromCloud(hour: number, cloudPct: number): number {
  return SITE.solar.capacityKwp * clearSkyFraction(hour) * (1 - 0.8 * (cloudPct / 100));
}

function weatherDay(rng: Rng, regime: WeatherRegime): Hourly<WeatherHour> {
  const w = REGIME_WEATHER[regime];
  const bias = gaussian(rng, 0, 8);
  return Array.from({ length: 24 }, (_, h) => {
    // Coldest ~06:00, warmest ~15:00.
    const diurnal = (1 - Math.cos((2 * Math.PI * (h - 6)) / 24)) / 2;
    return {
      tempC: round(w.tMin + (w.tMax - w.tMin) * diurnal + gaussian(rng, 0, 0.8)),
      cloudPct: Math.round(clamp(w.cloud + bias + gaussian(rng, 0, 12), 0, 100)),
      rainProbPct: Math.round(clamp(w.rain + gaussian(rng, 0, 10), 0, 100)),
    };
  });
}

function ordersProfile(hour: number): number {
  if (hour < SHIFT_HOURS.start || hour >= SHIFT_HOURS.end) return 0;
  // Two humps: late morning and mid-afternoon picking waves.
  return 0.75 + 0.25 * Math.exp(-((hour - 11) ** 2) / 4) + 0.2 * Math.exp(-((hour - 16) ** 2) / 4);
}

/** Warehouse load excluding fleet charging. */
export function siteLoadKw(hour: number, orders: number, tempC: number): number {
  const base = 45; // cold room refrigeration + IT + security lighting
  const operating = hour >= SHIFT_HOURS.start && hour < SHIFT_HOURS.end;
  const ops = operating ? 15 + 0.12 * orders : 0; // lighting + conveyors/sorters
  const heating = operating ? Math.max(0, 17 - tempC) * 3.5 : Math.max(0, 10 - tempC) * 1.5;
  return base + ops + heating;
}

export function generateDay(seed: number, dayIndex: number, startDate: string, prevRegime: WeatherRegime): DayScenario {
  const rng = mulberry32(seed * 1000 + dayIndex);
  const date = new Date(`${startDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayIndex);
  const iso = date.toISOString().slice(0, 10);
  const weekday = date.getUTCDay(); // 0 = Sunday

  const regime = pick(rng, REGIME_TRANSITIONS[prevRegime]);
  const actualWeather = weatherDay(rng, regime);

  // Forecast = actual + error. Occasionally the whole day is mis-forecast.
  const busted = rng() < 0.15;
  const cloudBias = busted ? (rng() < 0.5 ? -30 : 30) : gaussian(rng, 0, 6);
  const forecastWeather = actualWeather.map((w) => ({
    tempC: round(w.tempC + gaussian(rng, 0, 1)),
    cloudPct: Math.round(clamp(w.cloudPct + cloudBias + gaussian(rng, 0, 10), 0, 100)),
    rainProbPct: Math.round(clamp(w.rainProbPct + cloudBias / 2 + gaussian(rng, 0, 8), 0, 100)),
  }));

  // Workload.
  const volume = weekday === 0 ? 0.35 : weekday === 6 ? 0.7 : 1;
  const promo = weekday !== 0 && rng() < 0.12;
  const forecastOrders = Array.from({ length: 24 }, (_, h) => Math.round(320 * volume * (promo ? 1.35 : 1) * ordersProfile(h)));
  const orderNoise = gaussian(rng, 0, 0.07);
  const actualOrders = forecastOrders.map((o) => Math.round(o * (1 + orderNoise + gaussian(rng, 0, 0.05))));

  const forkliftKwhPerHourFc = round(1.5 + 0.0025 * Math.max(...forecastOrders), 2);
  const forkliftKwhPerHour = round(1.5 + 0.0025 * Math.max(...actualOrders), 2);
  const vanRouteKwhFc = weekday === 0 ? 20 : round(38 + (promo ? 10 : 0), 0);
  const vanRouteKwh = round(Math.max(10, vanRouteKwhFc + gaussian(rng, 0, 5)), 1);

  // Prices, with occasional network-peak events announced a day ahead.
  const tariffBands = Array.from({ length: 24 }, (_, h) => BANDS.find((b) => h >= b.from && h < b.to)!.name);
  const importPerKwh = Array.from({ length: 24 }, (_, h) => BANDS.find((b) => h >= b.from && h < b.to)!.price);
  const exportPerKwh = Array.from({ length: 24 }, () => EXPORT_PRICE);
  const events: string[] = [];
  const eventChance = regime === "storm" || regime === "overcast" ? 0.3 : 0.12;
  if (rng() < eventChance) {
    const start = 17 + Math.floor(rng() * 2);
    const len = 2 + Math.floor(rng() * 2);
    for (let h = start; h < Math.min(24, start + len); h++) {
      importPerKwh[h] = 1.2;
      exportPerKwh[h] = 0.8;
      tariffBands[h] = "network-peak-event";
    }
    events.push(`Network peak event ${start}:00–${start + len}:00: import $1.20/kWh, export credit $0.80/kWh.`);
  }

  const notes: string[] = [];
  if (promo) notes.push("Promotion day: order volume expected ~35% above normal.");
  if (weekday === 0) notes.push("Sunday: reduced operations (~35% volume), vans on short routes.");
  if (weekday === 6) notes.push("Saturday: ~70% volume.");

  return {
    dayIndex,
    date: iso,
    regime,
    actual: {
      weather: actualWeather,
      solarKw: actualWeather.map((w, h) => round(solarFromCloud(h, w.cloudPct))),
      loadKw: actualWeather.map((w, h) => round(siteLoadKw(h, actualOrders[h], w.tempC))),
      ordersPerHour: actualOrders,
      vanRouteKwh,
      forkliftKwhPerHour,
    },
    forecast: {
      weather: forecastWeather,
      solarP10Kw: forecastWeather.map((w, h) => round(solarFromCloud(h, clamp(w.cloudPct + 25, 0, 100)))),
      solarP50Kw: forecastWeather.map((w, h) => round(solarFromCloud(h, w.cloudPct))),
      solarP90Kw: forecastWeather.map((w, h) => round(solarFromCloud(h, clamp(w.cloudPct - 20, 0, 100)))),
      loadKw: forecastWeather.map((w, h) => round(siteLoadKw(h, forecastOrders[h], w.tempC))),
      ordersPerHour: forecastOrders,
      vanRouteKwh: vanRouteKwhFc,
      forkliftKwhPerHour: forkliftKwhPerHourFc,
      notes,
    },
    prices: {
      importPerKwh,
      exportPerKwh,
      demandChargePerKw: DEMAND_CHARGE_PER_KW_DAY,
      tariffBands,
      events,
    },
  };
}
