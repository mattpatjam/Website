// Generates a realistic Health Auto Export payload with N days of synthetic data,
// for local testing only:  node scripts/demo-payload.mjs 35 > /tmp/demo.json
const days = Number(process.argv[2] ?? 35);
const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00 +0800`;
// Wall-clock Bali time represented as a UTC Date (so getUTC* = Bali fields).
const bali = new Date(Date.now() + 8 * 3600e3);
bali.setUTCHours(0, 0, 0, 0);
const at = (dayOffset, h, m = 0) => new Date(bali.getTime() + dayOffset * 86400e3 + (h * 60 + m) * 60e3);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const metrics = { resting_heart_rate: [], heart_rate_variability: [], blood_oxygen_saturation: [], step_count: [], active_energy: [], sleep_analysis: [] };
const workouts = [];
for (let i = -days + 1; i <= 0; i++) {
  const tired = i === 0 || i === -1; // make the last two days look a bit rough
  const bedM = 22 * 60 + 40 + Math.round((rnd() - 0.5) * 70);
  const asleep = tired ? 5.6 + rnd() * 0.4 : 6.6 + rnd() * 1.2;
  const start = at(i - 1, 0, bedM);
  const end = new Date(start.getTime() + (asleep + 0.4) * 3600e3);
  metrics.sleep_analysis.push({ date: fmt(at(i, 0)), totalSleep: +asleep.toFixed(2), asleep: 0, deep: +(asleep * 0.17).toFixed(2), rem: +(asleep * 0.22).toFixed(2), core: +(asleep * 0.61).toFixed(2), awake: 0.4,
    sleepStart: fmt(start), sleepEnd: fmt(end), inBed: +(asleep + 0.6).toFixed(2), inBedStart: fmt(new Date(start - 10 * 60e3)), inBedEnd: fmt(new Date(end.getTime() + 5 * 60e3)), source: "Zepp" });
  metrics.resting_heart_rate.push({ date: fmt(at(i, 0)), qty: Math.round((tired ? 59 : 54) + rnd() * 3), source: "Zepp" });
  for (const h of [2, 5, 15]) metrics.heart_rate_variability.push({ date: fmt(at(i, h, 10)), qty: +((tired ? 36 : 46) + rnd() * 10).toFixed(1), source: "Zepp" });
  for (const h of [1, 3, 5]) metrics.blood_oxygen_saturation.push({ date: fmt(at(i, h)), qty: +(0.94 + rnd() * 0.04).toFixed(3), source: "Zepp" });
  if (i < 0) {
    metrics.step_count.push({ date: fmt(at(i, 12)), qty: Math.round(6000 + rnd() * 6000), source: "Zepp" });
    metrics.active_energy.push({ date: fmt(at(i, 12)), qty: Math.round(1500 + rnd() * 1500), source: "Zepp" });
  }
  const dow = at(i, 12).getUTCDay();
  if (i < 0 && [1, 3, 5, 6].includes(dow)) {
    const s = at(i, 16), e = at(i, 17, 30);
    workouts.push({ id: `demo-t-${i}`, name: "Tennis", start: fmt(s), end: fmt(e), duration: 5400, activeEnergyBurned: { qty: 600, units: "kcal" }, avgHeartRate: { qty: 128 + Math.round(rnd() * 20) }, maxHeartRate: { qty: 172 }, source: "Zepp" });
  }
  if (i < 0 && [2, 4].includes(dow)) {
    workouts.push({ id: `demo-g-${i}`, name: "Traditional Strength Training", start: fmt(at(i, 7)), end: fmt(at(i, 8)), duration: 3600, activeEnergyBurned: { qty: 300, units: "kcal" }, avgHeartRate: { qty: 112 }, maxHeartRate: { qty: 145 }, source: "Zepp" });
  }
}
const units = { resting_heart_rate: "count/min", heart_rate_variability: "ms", blood_oxygen_saturation: "%", step_count: "count", active_energy: "kJ", sleep_analysis: "hr" };
process.stdout.write(JSON.stringify({ data: { metrics: Object.entries(metrics).map(([name, data]) => ({ name, units: units[name], data })), workouts } }));
