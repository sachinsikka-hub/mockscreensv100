import React, { useState, useEffect, useMemo, useRef } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Activity, Upload, Plus, Heart, ChevronRight, X, Flame, Award, Gauge, Tag, Send } from 'lucide-react';
import { storage } from './storage.js';

// ---------- design tokens ----------
const COL = {
  court: '#123832',
  courtLine: '#EFE9DD',
  net: '#0B1512',
  panel: '#0F2B26',
  panelAlt: '#173F38',
  shuttle: '#E2622C',
  ink: '#EFE9DD',
  inkDim: '#9FB8B0',
  zone: ['#3E6E63', '#4C8A78', '#79A66A', '#D6A24B', '#E2622C'],
};

const ZONE_LABELS = ['Recovery', 'Aerobic', 'Tempo', 'Threshold', 'Peak'];
const ZONE_WEIGHT = [1, 2, 3, 4, 5];
const TYPE_COLOR = { match: COL.shuttle, drill: COL.zone[1], social: COL.zone[3] };
const TYPE_LABEL = { match: 'Match', drill: 'Drill', social: 'Social' };
const INTENSITY_FRAC = {
  Easy: [0.35, 0.35, 0.20, 0.08, 0.02],
  Moderate: [0.15, 0.25, 0.30, 0.20, 0.10],
  Hard: [0.05, 0.15, 0.25, 0.30, 0.25],
};
const INTENSITY_HR = { Easy: { avg: 112, max: 138, kcal: 8.5 }, Moderate: { avg: 132, max: 164, kcal: 9.8 }, Hard: { avg: 150, max: 181, kcal: 11.5 } };

const FONT_LINK = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap';

function uid() { return Math.random().toString(36).slice(2, 10); }
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}
function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function sampleWorkouts() {
  const today = new Date();
  const days = [1, 3, 5, 8, 10, 12, 15, 17, 19, 22, 24, 27, 34, 41, 55, 68, 82, 95, 110, 130, 155, 180, 210, 245, 280, 310, 340];
  const types = ['drill', 'drill', 'match', 'drill', 'social', 'drill', 'match', 'drill', 'drill', 'match', 'drill', 'drill', 'drill', 'match', 'drill', 'social', 'drill', 'match', 'drill', 'drill', 'match', 'drill', 'social', 'drill', 'match', 'drill', 'drill'];
  return days.map((d, i) => {
    const date = new Date(today);
    date.setDate(date.getDate() - d);
    const dur = 55 + Math.round(Math.sin(i) * 10 + 10);
    const z1 = Math.round(dur * 0.12);
    const z2 = Math.round(dur * 0.28);
    const z3 = Math.round(dur * 0.32);
    const z4 = Math.round(dur * 0.20);
    const z5 = Math.max(0, dur - z1 - z2 - z3 - z4);
    return {
      id: uid(), date: date.toISOString().slice(0, 10), duration_min: dur,
      avg_hr: 128 + Math.round(Math.sin(i) * 6), max_hr: 168 + Math.round(Math.cos(i) * 8),
      calories: Math.round(dur * 9.2), zones: [z1, z2, z3, z4, z5], zonesSource: 'sample',
      type: types[i] || 'drill', source: 'sample',
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function sessionLoad(zones) { return zones.reduce((s, mins, i) => s + mins * ZONE_WEIGHT[i], 0); }
function zoneOfHR(hr, maxHR) {
  const pct = hr / maxHR;
  if (pct < 0.60) return 0; if (pct < 0.70) return 1; if (pct < 0.80) return 2; if (pct < 0.90) return 3; return 4;
}
function zonesFromSamples(samples, maxHR) {
  const zones = [0, 0, 0, 0, 0];
  const times = samples.map((s) => new Date(s.date || s.timestamp).getTime()).filter((t) => !isNaN(t));
  if (times.length < 2) return null;
  const spanMin = (Math.max(...times) - Math.min(...times)) / 60000;
  const perSample = spanMin / (samples.length - 1 || 1);
  samples.forEach((s) => { const hr = s.value ?? s.Avg ?? s.avg ?? s.qty; if (typeof hr === 'number') zones[zoneOfHR(hr, maxHR)] += perSample; });
  return zones.map((m) => Math.round(m));
}
function inferType(w) {
  const raw = (w.type || w.workoutType || w.activity || '').toString().toLowerCase();
  if (raw.includes('match') || raw.includes('tournament') || raw.includes('competitive')) return 'match';
  if (raw.includes('social') || raw.includes('casual') || raw.includes('fun')) return 'social';
  return 'drill';
}
function parseImport(raw, maxHR) {
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error('Not valid JSON — paste the exported file contents, not a screenshot description.'); }
  const list = Array.isArray(data) ? data : (data.data?.workouts || data.workouts || [data]);
  return list.map((w) => {
    let dur;
    if (w.duration_min != null) dur = Math.round(w.duration_min);
    else if (w.durationSeconds != null) dur = Math.round(w.durationSeconds / 60);
    else if (w.duration != null) dur = Math.round(w.duration / 60);
    else dur = 60;
    const suspicious = dur > 240 || dur < 5;
    // Apple Health Auto Export's real shape nests HR/calories under statistics.HK...,
    // and the workout date lives in startDate/endDate, not a flat "date" field.
    const stats = w.statistics || {};
    const hrStat = stats.HKQuantityTypeIdentifierHeartRate;
    const energyStat = stats.HKQuantityTypeIdentifierActiveEnergyBurned;
    const avg = Math.round(w.avgHeartRate ?? w.avg_hr ?? w.heartRateAvg ?? hrStat?.average ?? 130);
    const max = Math.round(w.maxHeartRate ?? w.max_hr ?? w.heartRateMax ?? hrStat?.max ?? avg + 30);
    const cals = Math.round(w.activeEnergy ?? w.calories ?? energyStat?.sum ?? dur * 9);
    const dateStr = w.date || w.start || w.startDate || w.endDate || new Date().toISOString();
    let zones = w.zones || w.hr_zones;
    let zonesSource = zones ? 'measured' : null;
    const rawSamples = w.heartRateData || w.heartRateSamples || w.hrSamples;
    if (!zones && Array.isArray(rawSamples) && rawSamples.length > 1) {
      const computed = zonesFromSamples(rawSamples, maxHR);
      if (computed) { zones = computed; zonesSource = 'measured'; }
    }
    if (!zones) {
      const intensity = Math.min(1, Math.max(0, (avg - 90) / 80));
      const z5 = Math.round(dur * (0.05 + intensity * 0.25));
      const z4 = Math.round(dur * (0.10 + intensity * 0.25));
      const z3 = Math.round(dur * 0.30);
      const z2 = Math.round(dur * 0.25);
      const z1 = Math.max(0, dur - z5 - z4 - z3 - z2);
      zones = [z1, z2, z3, z4, z5]; zonesSource = 'estimated';
    }
    return { id: uid(), date: dateStr.slice(0, 10), duration_min: dur, avg_hr: avg, max_hr: max, calories: cals, zones, zonesSource, type: inferType(w), suspicious, source: 'import' };
  });
}

function computeReadiness(enriched) {
  if (enriched.length === 0) return null;
  const last8 = enriched.slice(-8); const last3 = enriched.slice(-3);
  const avg = (arr) => arr.reduce((s, w) => s + w.load, 0) / arr.length;
  const chronic = avg(last8); const acute = avg(last3);
  const ratio = chronic === 0 ? 1 : acute / chronic;
  const lastDate = new Date(enriched[enriched.length - 1].date + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysSince = Math.round((today - lastDate) / 86400000);
  let score = 70;
  if (ratio > 1.3) score -= 25; else if (ratio > 1.15) score -= 10;
  if (ratio < 0.75) score -= 10;
  if (daysSince <= 0) score -= 15; else if (daysSince === 1) score += 5; else if (daysSince >= 2) score += 12;
  score = Math.max(5, Math.min(98, Math.round(score)));
  let label, detail;
  if (score >= 75) { label = 'Fresh'; detail = 'Good to go hard today.'; }
  else if (score >= 45) { label = 'Moderate'; detail = 'Normal training load is fine.'; }
  else { label = 'Fatigued'; detail = 'Consider easing up or resting.'; }
  return { score, label, detail };
}
function computeStreak(enriched) {
  if (enriched.length === 0) return 0;
  const weeks = new Set(enriched.map((w) => mondayOf(w.date)));
  const todayStr = new Date().toISOString().slice(0, 10);
  let cursor = mondayOf(todayStr);
  if (!weeks.has(cursor)) cursor = shiftDate(cursor, -7);
  let streak = 0;
  while (weeks.has(cursor)) { streak++; cursor = shiftDate(cursor, -7); }
  return streak;
}
function personalBests(enriched) {
  if (enriched.length === 0) return null;
  const longest = enriched.reduce((a, b) => (b.duration_min > a.duration_min ? b : a));
  const highestLoad = enriched.reduce((a, b) => (b.load > a.load ? b : a));
  const mostPeak = enriched.reduce((a, b) => (b.zones[4] > a.zones[4] ? b : a));
  return { longest, highestLoad, mostPeak };
}
function trendCallout(delta) {
  if (delta > 20) return "Load's climbing fast vs your recent stretch — keep an eye on recovery.";
  if (delta > 8) return 'Trending harder than recent weeks — solid progression.';
  if (delta >= -8) return 'Holding steady — consistent training load.';
  if (delta >= -20) return 'Lighter than recent weeks — a good window for technical work.';
  return 'Big drop in load — planned rest, or worth checking training consistency.';
}
function buildHeatmap(enriched, weeksCount = 12) {
  const byDate = {};
  enriched.forEach((w) => { byDate[w.date] = (byDate[w.date] || 0) + w.load; });
  const todayMonday = mondayOf(new Date().toISOString().slice(0, 10));
  const cols = [];
  for (let wI = weeksCount - 1; wI >= 0; wI--) {
    const monday = shiftDate(todayMonday, -wI * 7);
    const days = [];
    for (let d = 0; d < 7; d++) { const key = shiftDate(monday, d); days.push({ date: key, load: byDate[key] || 0 }); }
    cols.push(days);
  }
  const maxLoad = Math.max(1, ...Object.values(byDate));
  return { cols, maxLoad };
}
function buildQuickWorkout(duration, intensity, type) {
  const fracs = INTENSITY_FRAC[intensity];
  const zones = fracs.map((f) => Math.round(f * duration));
  const diff = duration - zones.reduce((a, b) => a + b, 0);
  zones[2] += diff;
  const hr = INTENSITY_HR[intensity];
  return {
    id: uid(), date: new Date().toISOString().slice(0, 10), duration_min: duration,
    avg_hr: hr.avg, max_hr: hr.max, calories: Math.round(duration * hr.kcal),
    zones, zonesSource: 'estimated', type, source: 'quick-add',
  };
}

// Acute:Chronic Workload Ratio — standard sports-science injury-risk indicator.
// Acute = last 7 days' total load. Chronic = average weekly load over the last 4 weeks.
function computeACWR(enriched) {
  if (enriched.length === 0) return null;
  const todayStr = new Date().toISOString().slice(0, 10);
  const acuteCutoff = shiftDate(todayStr, -6);
  const chronicCutoff = shiftDate(todayStr, -27);
  const acuteLoad = enriched.filter((w) => w.date >= acuteCutoff).reduce((s, w) => s + w.load, 0);
  const chronicSessions = enriched.filter((w) => w.date >= chronicCutoff);
  const chronicWeeklyAvg = chronicSessions.reduce((s, w) => s + w.load, 0) / 4;
  const ratio = chronicWeeklyAvg === 0 ? (acuteLoad > 0 ? 2 : 1) : acuteLoad / chronicWeeklyAvg;
  let zone, label, detail;
  if (ratio < 0.8) { zone = 'low'; label = 'Undertraining'; detail = 'Load is well below your recent norm — room to add more if you want.'; }
  else if (ratio <= 1.3) { zone = 'sweet'; label = 'Sweet spot'; detail = 'Load ramp looks sustainable.'; }
  else if (ratio <= 1.5) { zone = 'caution'; label = 'Elevated'; detail = 'Ramping up fast — keep an eye on recovery.'; }
  else { zone = 'high'; label = 'High risk'; detail = 'Sharp spike vs your recent average — higher injury-risk territory.'; }
  return { ratio: Math.round(ratio * 100) / 100, acuteLoad: Math.round(acuteLoad), chronicWeeklyAvg: Math.round(chronicWeeklyAvg), zone, label, detail };
}

// Then vs Now — splits full history in half chronologically and compares key metrics,
// a proxy for whether fitness/tolerance is actually improving over the season.
function computeThenVsNow(enriched) {
  if (enriched.length < 4) return null;
  const half = Math.floor(enriched.length / 2);
  const then = enriched.slice(0, half);
  const now = enriched.slice(half);
  const metrics = (arr) => {
    const totalMin = arr.reduce((s, w) => s + w.duration_min, 0);
    const avgLoad = arr.reduce((s, w) => s + w.load, 0) / arr.length;
    const avgHR = arr.reduce((s, w) => s + w.avg_hr, 0) / arr.length;
    const peakMin = arr.reduce((s, w) => s + w.zones[3] + w.zones[4], 0);
    const pctPeak = totalMin === 0 ? 0 : (peakMin / totalMin) * 100;
    const spanDays = Math.max(1, (new Date(arr[arr.length - 1].date) - new Date(arr[0].date)) / 86400000);
    const perWeek = arr.length / (spanDays / 7);
    return { avgLoad, avgHR, pctPeak, perWeek };
  };
  const t = metrics(then), n = metrics(now);
  return {
    then: t, now: n,
    loadDelta: t.avgLoad === 0 ? 0 : ((n.avgLoad - t.avgLoad) / t.avgLoad) * 100,
    hrDelta: n.avgHR - t.avgHR,
    pctPeakDelta: n.pctPeak - t.pctPeak,
    freqDelta: n.perWeek - t.perWeek,
  };
}

// Benchmark vs published sports-science convention for competitive singles badminton:
// average HR during rally play typically runs ~80-90% of max HR. General guidance, not personalized/medical.
function computeHRBenchmark(enriched, maxHR) {
  const matches = enriched.filter((w) => w.type === 'match');
  const pool = matches.length >= 3 ? matches : enriched;
  if (pool.length === 0) return null;
  const avgPct = pool.reduce((s, w) => s + (w.avg_hr / maxHR) * 100, 0) / pool.length;
  const bandLow = 80, bandHigh = 90;
  const position = avgPct < bandLow ? 'below' : avgPct <= bandHigh ? 'within' : 'above';
  return { avgPct: Math.round(avgPct), bandLow, bandHigh, position, usedMatchesOnly: matches.length >= 3, sampleSize: pool.length };
}

const DEFAULT_CHIPS = ['How am I trending?', 'Am I ready today?', 'Injury risk check', 'Am I improving?', 'Vs competitive benchmark', 'Show my streak', 'Personal bests', 'Tag last session', 'Log a quick session'];

// Parses Health Auto Export's real export shape: { data: { metrics: [ { name, units, data: [{date, qty, source}] } ] } }.
// Metric values live under "qty" (not "value"), dates are "YYYY-MM-DD HH:MM:SS +ZZZZ" strings,
// and sleep_analysis has its own richer shape (sleepStart/sleepEnd/asleep/totalSleep in hours) rather than a flat qty.
function parseHealthMetrics(raw) {
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error('Not valid JSON — paste or choose the exported Health Metrics file.'); }
  const metrics = data?.data?.metrics;
  if (!Array.isArray(metrics)) throw new Error('Unrecognized export shape — expected a Health Auto Export "Health Metrics" file with a data.metrics array.');
  const findMetric = (name) => metrics.find((m) => m.name === name)?.data;
  const mapQty = (records) => (Array.isArray(records) ? records.map((r) => ({ date: (r.date || '').slice(0, 10), value: r.qty })).filter((r) => r.date && typeof r.value === 'number') : []);
  const sleepRecords = findMetric('sleep_analysis');
  const sleep = Array.isArray(sleepRecords)
    ? sleepRecords.map((r) => ({ date: (r.date || r.sleepStart || '').slice(0, 10), value: r.totalSleep ?? r.asleep })).filter((r) => r.date && typeof r.value === 'number')
    : [];
  return {
    sleep,
    hrv: mapQty(findMetric('heart_rate_variability')),
    restingHR: mapQty(findMetric('resting_heart_rate')),
    vo2max: mapQty(findMetric('vo2_max')),
    weight: mapQty(findMetric('weight_body_mass')),
    bodyFat: mapQty(findMetric('body_fat_percentage')),
  };
}
function mergeMetricSeries(existing, incoming) {
  const byDate = {};
  [...existing, ...incoming].forEach((r) => { byDate[r.date] = r; }); // incoming wins on same date
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}
// Generic recent-vs-prior trend for any {date,value} series.
function computeMetricTrend(series, days = 14) {
  if (!series || series.length === 0) return null;
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const todayStr = new Date().toISOString().slice(0, 10);
  const recentCutoff = shiftDate(todayStr, -days);
  const priorCutoff = shiftDate(todayStr, -days * 2);
  const recent = sorted.filter((r) => r.date >= recentCutoff);
  const prior = sorted.filter((r) => r.date >= priorCutoff && r.date < recentCutoff);
  const avg = (arr) => arr.reduce((s, r) => s + r.value, 0) / arr.length;
  const latest = sorted[sorted.length - 1].value;
  const recentAvg = recent.length ? avg(recent) : null;
  const priorAvg = prior.length ? avg(prior) : null;
  const delta = recentAvg != null && priorAvg != null && priorAvg !== 0 ? ((recentAvg - priorAvg) / priorAvg) * 100 : null;
  return { latest, recentAvg, priorAvg, delta, points: sorted.slice(-30) };
}

const COURTIQ_SYSTEM_PROMPT = `You are CourtIQ — the personal performance coach inside this app. You think like three people at once: an elite badminton coach who's watched thousands of matches, a sports scientist who reads HR/load/recovery data fluently, and a performance-academy mentor who tracks the whole athlete — not just court time, but sleep, recovery, cardiovascular trend, and body composition too. You are not a stats readout. You are not a customer support bot. You have a point of view, and you're not afraid to share it.

The athlete you're coaching trains 3–4x/week, competes regularly, and sits in elite physiological territory (VO2 max ~52-53, resting HR in the low 40s). Talk to them like it. No generic "great job, keep it up" — they'll see through that immediately and disengage.

What "intelligence" means here: Every response must be grounded in the athlete's actual data — session load, HR zone distribution, ACWR ratio, recent trend vs. baseline, personal bests, streaks, sleep, HRV, resting HR trend, VO2max trend, and body composition where relevant. Never answer with a fact that could apply to anyone. If the data shows something interesting (a zone-4/5 spike, a load ratio creeping past 1.3, HRV dropping while load climbs, resting HR drifting up, a sleep deficit stacking before a match), say so specifically, with the number, and say what it means for their next session or match. Connect domains when it matters — e.g. if court load is up but sleep is down, that combination matters more than either alone. If the data doesn't support a strong claim, say what you do see and what you'd need to know more — don't pad with disclaimers or hedge into blandness.

What "warmth" means here: Warmth isn't compliments — it's attention. Reference their specific recent pattern before giving advice ("your last three sessions" not "your sessions"). Acknowledge effort and frustration where it's earned, briefly, then move to substance. Never open with "I understand how you feel" — just demonstrate it by getting the specifics right.

Response shape — every response should do three things, not necessarily in this order and not as a rigid template: (1) A read — one sharp observation grounded in their data, stated plainly. (2) Why it matters — the performance implication, tied to competition, recovery, or long-term health, not just tracking trivia. (3) A next move or an open thread — either a concrete adjustment, or a question that invites them to go deeper. Don't just answer and stop; leave the conversation somewhere to go, the way a real coach would after reviewing film.

Avoid: single-sentence answers, "Great question!", restating their question back to them, ending on a flat statement with nothing for them to respond to.

Tone: Direct, economical, a little competitive — like someone who respects the athlete enough not to soften things. Comfortable disagreeing or flagging a bad trend without being alarmist. Never corporate, never clinical-sounding unless flagging genuine injury or health risk (then be clear and specific, not scary). Short paragraphs or tight bullets over walls of text — this is a chat, not a report.

Guardrails: If data suggests overtraining, injury risk, or a concerning health pattern (ACWR spike, HRV/resting-HR divergence, chronic sleep deficit, reported pain), name it clearly and recommend concrete action (rest day, sleep prioritization, professional/medical assessment) — don't bury it in hedging, but don't diagnose a medical condition. Never invent data points you don't have. If asked something the data can't answer, say so and pivot to what it can tell you. Keep responses to 2-4 short paragraphs or tight bullets — this is a mobile chat, not a report.`;

// Builds a compact, factual snapshot of the athlete's real computed data to ground every coach response.
function buildDataDigest({ enriched, tab, totals, readiness, streak, acwr, trend, thenVsNow, hrBenchmark, bests, typeBreakdown, settings, sleepTrend, hrvTrend, rhrTrend, vo2Trend, weightTrend, bodyFatTrend }) {
  const recent = enriched.slice(-5).map((w) => ({
    date: w.date, type: w.type, duration_min: w.duration_min, load: Math.round(w.load),
    avg_hr: w.avg_hr, max_hr: w.max_hr, zones_min: w.zones, zones_source: w.zonesSource,
  }));
  const roundTrend = (t, dp = 1) => t ? { latest: Math.round(t.latest * 10 ** dp) / 10 ** dp, recent_avg: t.recentAvg != null ? Math.round(t.recentAvg * 10 ** dp) / 10 ** dp : null, delta_pct: t.delta != null ? Math.round(t.delta * 10) / 10 : null } : null;
  return JSON.stringify({
    viewing_period: tab,
    period_totals: totals,
    readiness, streak_weeks: streak, acwr, overall_trend: trend, then_vs_now: thenVsNow,
    hr_benchmark: hrBenchmark, personal_bests_this_period: bests ? {
      longest: { min: bests.longest.duration_min, date: bests.longest.date },
      highest_load: { load: Math.round(bests.highestLoad.load), date: bests.highestLoad.date },
      most_peak_time: { min: bests.mostPeak.zones[4], date: bests.mostPeak.date },
    } : null,
    load_by_type: typeBreakdown, athlete_settings: settings,
    last_5_sessions: recent, total_sessions_logged: enriched.length,
    recovery_and_health: {
      sleep_hours_per_night: roundTrend(sleepTrend, 1),
      hrv_ms: roundTrend(hrvTrend, 0),
      resting_hr_bpm: roundTrend(rhrTrend, 0),
      vo2max: roundTrend(vo2Trend, 1),
      weight_kg: roundTrend(weightTrend, 1),
      body_fat_pct: roundTrend(bodyFatTrend, 1),
      note: 'For resting HR, lower recent_avg vs prior is good (better recovery); rising resting HR alongside high load is a fatigue flag. For HRV, higher is generally better recovery. Any metric with null recent_avg/delta_pct means not enough data yet.',
    },
  }, null, 2);
}

export default function BadmintonOS() {
  const [workouts, setWorkouts] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [settings, setSettings] = useState({ restingHR: 44, maxHR: 185 });
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([{ role: 'assistant', text: "CourtIQ here — your court-side coach. Tap a chip or ask me anything." }]);
  const [flow, setFlow] = useState(null);
  const [pending, setPending] = useState({});
  const [inputText, setInputText] = useState('');
  const [tab, setTab] = useState('month');
  const [fileName, setFileName] = useState('');
  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState([]);
  const [coachLoading, setCoachLoading] = useState(false);
  const [healthMetrics, setHealthMetrics] = useState({ sleep: [], hrv: [], restingHR: [], vo2max: [], weight: [], bodyFat: [] });
  const [showHealthImport, setShowHealthImport] = useState(false);
  const [healthImportText, setHealthImportText] = useState('');
  const [healthImportError, setHealthImportError] = useState('');
  const [healthFileName, setHealthFileName] = useState('');
  const chatEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const healthFileInputRef = useRef(null);

  useEffect(() => {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = FONT_LINK; document.head.appendChild(link);
    (async () => {
      let hasWorkouts = false;
      try { const w = await storage.get('badminton:workouts'); if (w) { setWorkouts(JSON.parse(w.value)); hasWorkouts = true; } } catch (e) {}
      try { const s = await storage.get('badminton:settings'); if (s) setSettings(JSON.parse(s.value)); } catch (e) {}
      try { const h = await storage.get('badminton:health'); if (h) setHealthMetrics(JSON.parse(h.value)); } catch (e) {}
      if (!hasWorkouts) {
        // First run, nothing in local storage yet — seed from the bundled export
        // so the app isn't empty on first load. Re-uploading a new export later
        // adds to this same local store, it never touches this seed file again.
        try {
          const res = await fetch('/data/courtiq-seed-workouts.json');
          if (res.ok) {
            const raw = await res.text();
            setWorkouts(parseImport(raw, 185));
          }
        } catch (e) {}
      }
      setLoaded(true);
    })();
    return () => { try { document.head.removeChild(link); } catch (e) {} };
  }, []);
  useEffect(() => { if (loaded) storage.set('badminton:workouts', JSON.stringify(workouts)); }, [workouts, loaded]);
  useEffect(() => { if (loaded) storage.set('badminton:settings', JSON.stringify(settings)); }, [settings, loaded]);
  useEffect(() => { if (loaded) storage.set('badminton:health', JSON.stringify(healthMetrics)); }, [healthMetrics, loaded]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [messages]);

  const sorted = useMemo(() => [...workouts].sort((a, b) => a.date.localeCompare(b.date)), [workouts]);
  const enriched = useMemo(() => sorted.map((w) => ({ ...w, load: sessionLoad(w.zones), type: w.type || 'drill' })), [sorted]);

  const filtered = useMemo(() => {
    if (tab === 'all') return enriched;
    const days = tab === 'week' ? 7 : tab === 'month' ? 30 : 365;
    const cutoff = shiftDate(new Date().toISOString().slice(0, 10), -days);
    return enriched.filter((w) => w.date >= cutoff);
  }, [enriched, tab]);

  const trend = useMemo(() => {
    if (enriched.length < 2) return null;
    const half = Math.max(1, Math.floor(enriched.length / 2));
    const prev = enriched.slice(0, half); const recent = enriched.slice(half);
    const avg = (arr) => arr.reduce((s, w) => s + w.load, 0) / arr.length;
    const prevAvg = avg(prev), recentAvg = avg(recent);
    const delta = prevAvg === 0 ? 0 : ((recentAvg - prevAvg) / prevAvg) * 100;
    return { prevAvg, recentAvg, delta };
  }, [enriched]);
  const totals = useMemo(() => {
    if (filtered.length === 0) return null;
    const sessions = filtered.length;
    const totalMin = filtered.reduce((s, w) => s + w.duration_min, 0);
    const avgLoad = filtered.reduce((s, w) => s + w.load, 0) / sessions;
    return { sessions, totalMin, avgLoad };
  }, [filtered]);
  const readiness = useMemo(() => computeReadiness(enriched), [enriched]);
  const streak = useMemo(() => computeStreak(enriched), [enriched]);
  const bests = useMemo(() => personalBests(filtered), [filtered]);
  const heatmapWeeks = tab === 'week' ? 4 : tab === 'month' ? 12 : 52;
  const heatmap = useMemo(() => buildHeatmap(enriched, heatmapWeeks), [enriched, heatmapWeeks]);
  const typeBreakdown = useMemo(() => {
    const sums = { match: 0, drill: 0, social: 0 };
    filtered.forEach((w) => { sums[w.type || 'drill'] += w.load; });
    return sums;
  }, [filtered]);
  const typeTotal = typeBreakdown.match + typeBreakdown.drill + typeBreakdown.social || 1;
  const sleepTrend = useMemo(() => computeMetricTrend(healthMetrics.sleep), [healthMetrics.sleep]);
  const hrvTrend = useMemo(() => computeMetricTrend(healthMetrics.hrv), [healthMetrics.hrv]);
  const rhrTrend = useMemo(() => computeMetricTrend(healthMetrics.restingHR), [healthMetrics.restingHR]);
  const vo2Trend = useMemo(() => computeMetricTrend(healthMetrics.vo2max, 30), [healthMetrics.vo2max]);
  const weightTrend = useMemo(() => computeMetricTrend(healthMetrics.weight, 30), [healthMetrics.weight]);
  const bodyFatTrend = useMemo(() => computeMetricTrend(healthMetrics.bodyFat, 30), [healthMetrics.bodyFat]);
  const hasHealthData = Object.values(healthMetrics).some((arr) => arr.length > 0);
  const acwr = useMemo(() => computeACWR(enriched), [enriched]);
  const thenVsNow = useMemo(() => computeThenVsNow(enriched), [enriched]);
  const hrBenchmark = useMemo(() => computeHRBenchmark(enriched, settings.maxHR), [enriched, settings.maxHR]);
  const compareSessions = useMemo(() => compareIds.map((id) => enriched.find((w) => w.id === id)).filter(Boolean), [compareIds, enriched]);

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setImportError('');
    const reader = new FileReader();
    reader.onload = () => setImportText(reader.result);
    reader.onerror = () => setImportError('Could not read that file — try picking it again.');
    reader.readAsText(file);
  }

  function addSample() { setWorkouts((w) => [...w, ...sampleWorkouts()]); }

  function handleHealthFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setHealthImportError('');
    const MAX_MB = 10;
    if (file.size > MAX_MB * 1024 * 1024) {
      setHealthFileName('');
      setHealthImportError(`That file is ${(file.size / (1024 * 1024)).toFixed(0)}MB — too large to process here safely. This usually means every metric got exported, not just the ones this app needs. In Health Auto Export, deselect everything except Sleep Analysis, Heart Rate Variability, Resting Heart Rate, VO2 Max, Weight, and Body Fat Percentage, then export again — it should shrink to a few hundred KB.`);
      return;
    }
    setHealthFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setHealthImportText(reader.result);
    reader.onerror = () => setHealthImportError('Could not read that file — try picking it again.');
    reader.readAsText(file);
  }
  function doHealthImport() {
    setHealthImportError('');
    try {
      const parsed = parseHealthMetrics(healthImportText);
      setHealthMetrics((prev) => ({
        sleep: mergeMetricSeries(prev.sleep, parsed.sleep),
        hrv: mergeMetricSeries(prev.hrv, parsed.hrv),
        restingHR: mergeMetricSeries(prev.restingHR, parsed.restingHR),
        vo2max: mergeMetricSeries(prev.vo2max, parsed.vo2max),
        weight: mergeMetricSeries(prev.weight, parsed.weight),
        bodyFat: mergeMetricSeries(prev.bodyFat, parsed.bodyFat),
      }));
      setShowHealthImport(false); setHealthImportText(''); setHealthFileName('');
    } catch (e) { setHealthImportError(e.message); }
  }
  function doImport() {
    setImportError('');
    try {
      const parsed = parseImport(importText, settings.maxHR);
      const flagged = parsed.filter((p) => p.suspicious);
      if (flagged.length > 0) {
        setImportError(`${flagged.length} of ${parsed.length} session(s) have an implausible duration (under 5 min or over 4 hours) — likely a units mismatch. Not imported.`);
        const clean = parsed.filter((p) => !p.suspicious);
        if (clean.length > 0) setWorkouts((w) => [...w, ...clean]);
        return;
      }
      setWorkouts((w) => [...w, ...parsed]); setShowImport(false); setImportText(''); setFileName('');
    } catch (e) { setImportError(e.message); }
  }
  function removeAll() { setWorkouts([]); }
  function toggleCompare(id) {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  }
  function setType(id, type) {
    setWorkouts((ws) => ws.map((w) => (w.id === id ? { ...w, type } : w)));
    setSelected((s) => (s && s.id === id ? { ...s, type } : s));
  }

  function pushUser(text) { setMessages((m) => [...m, { role: 'user', text }]); }
  function pushBot(text) { setMessages((m) => [...m, { role: 'assistant', text }]); }

  function coachAnswer(topic) {
    const pct = (n) => `${n > 0 ? '+' : ''}${Math.round(n)}%`;
    const zoneLead = (w) => {
      if (!w) return null;
      const maxZone = w.zones.indexOf(Math.max(...w.zones));
      return ZONE_LABELS[maxZone];
    };
    switch (topic) {
      case 'How am I trending?': {
        if (!trend) return "Not enough sessions logged yet to call a trend — get a few more in and ask again.";
        const last = enriched[enriched.length - 1];
        let read = `Recent avg load is ${Math.round(trend.recentAvg)} vs ${Math.round(trend.prevAvg)} earlier — that's ${pct(trend.delta)}.`;
        let why = trend.delta > 15 ? "That's a real ramp, not noise. Good if you're building toward something specific; risky if it's crept up without a plan." : trend.delta < -15 ? "Meaningfully lighter than your recent norm — fine as a deload, worth flagging if it's not intentional." : "That's within normal week-to-week variation, not a shift worth reacting to.";
        let next = rhrTrend?.delta != null ? `Your resting HR is ${rhrTrend.delta > 3 ? 'drifting up' : 'holding steady'} over the same window — ${rhrTrend.delta > 3 ? 'that combination is worth watching' : "so the load shift isn't showing up as fatigue yet"}. What's driving the change — more matches, or just a busier calendar?` : `What's behind it — more matches, or just a busier week?`;
        return `${read} ${why}\n\n${next}`;
      }
      case 'Am I ready today?': {
        if (!readiness) return "No sessions logged yet, so no basis for a readiness read.";
        let read = `Readiness sits at ${readiness.score}/100 — ${readiness.label}.`;
        let why = acwr ? `Your workload ratio is ${acwr.ratio} (${acwr.label}), which ${acwr.zone === 'high' || acwr.zone === 'caution' ? 'is part of why holding back today makes sense' : 'lines up with going hard if you want to'}.` : '';
        let next;
        if (hrvTrend?.delta != null || rhrTrend?.delta != null) {
          const hrvNote = hrvTrend?.delta != null ? `HRV is ${pct(hrvTrend.delta)} vs your prior stretch` : '';
          const rhrNote = rhrTrend?.delta != null ? `resting HR is ${pct(rhrTrend.delta)}` : '';
          next = `${[hrvNote, rhrNote].filter(Boolean).join(', ')} — ${(hrvTrend?.delta < -5 || rhrTrend?.delta > 3) ? "that combination backs up going easier today." : "recovery markers look fine alongside it."} Anything feel off physically, or just going off the numbers?`;
        } else {
          next = "No recovery data (sleep/HRV/resting HR) logged yet — add that and this read gets a lot sharper. How's the body feel otherwise?";
        }
        return `${read} ${why}\n\n${next}`;
      }
      case 'Injury risk check': {
        if (!acwr) return "Not enough history yet for a workload ratio — needs a few weeks of sessions.";
        const read = `Acute:Chronic ratio is ${acwr.ratio} — acute load ${acwr.acuteLoad} vs a chronic weekly average of ${acwr.chronicWeeklyAvg}.`;
        const why = acwr.zone === 'high' ? "That's the range where soft-tissue niggles start showing up if it holds for another week." : acwr.zone === 'caution' ? "Not dangerous yet, but it's the zone to watch — a couple more hard sessions and it tips over." : acwr.zone === 'low' ? "You've got real headroom here if you want to push a training block." : "That's the sustainable range — load and recovery are roughly matched.";
        const next = acwr.zone === 'high' ? "I'd pull your next session back to a light drill day or rest entirely rather than stacking another match." : acwr.zone === 'caution' ? "Worth making your next session technical/low-intensity rather than another match." : "Anything feel tight or sore, or is this just a quiet stretch?";
        return `${read} ${why}\n\n${next}`;
      }
      case 'Am I improving?': {
        if (!thenVsNow) return "Log more sessions — need a longer history to split then-vs-now meaningfully.";
        const read = `Comparing your first half of logged sessions to the most recent half: load is ${pct(thenVsNow.loadDelta)}, time in Threshold+Peak zones is ${thenVsNow.pctPeakDelta >= 0 ? '+' : ''}${Math.round(thenVsNow.pctPeakDelta)} points, and you're playing ${thenVsNow.freqDelta >= 0 ? '+' : ''}${thenVsNow.freqDelta.toFixed(1)} sessions/week differently.`;
        const why = thenVsNow.pctPeakDelta > 5 ? "Tolerating more time at high intensity than you used to is a real fitness signal, not just accumulated hours." : thenVsNow.pctPeakDelta < -5 ? "Less time in the hard zones lately — could be a deliberate lighter block, or intensity quietly dropping off." : "Your intensity distribution has stayed fairly consistent across the period.";
        const next = vo2Trend?.latest ? `Your VO2max reading is ${vo2Trend.latest} — worth checking that against this pattern over the next few months.` : "Want me to break this down by match vs drill instead of the full mix?";
        return `${read} ${why}\n\n${next}`;
      }
      case 'Vs competitive benchmark': {
        if (!hrBenchmark) return "No sessions yet to benchmark.";
        const read = `Your ${hrBenchmark.usedMatchesOnly ? 'match' : 'session'} average sits at ${hrBenchmark.avgPct}% of max HR, against a ${hrBenchmark.bandLow}–${hrBenchmark.bandHigh}% norm for competitive singles.`;
        const why = hrBenchmark.position === 'within' ? "That's right where competitive play should sit — you're working at genuine match intensity, not coasting." : hrBenchmark.position === 'below' ? "That's a notch below typical competitive intensity — could mean matches aren't fully live, or your max HR reference needs revisiting." : "You're pushing above the typical band — either your matches are genuinely intense, or your max HR setting is set too low.";
        const next = hrBenchmark.usedMatchesOnly ? "Want to see how this compares session-by-session?" : "Tag a few sessions as Match specifically and this comparison gets a lot more accurate — want to do that now?";
        return `${read} ${why}\n\n${next}`;
      }
      case 'Show my streak':
        return streak > 0
          ? `${streak} week streak going. ${streak >= 6 ? "That's a real season-length block of consistency — the kind that actually moves fitness, not just keeps it maintained." : streak >= 3 ? "Solid run — this is where base fitness starts compounding." : "Early days, but it's a start."} What's the plan for keeping it alive through the next tough week?`
          : "No active streak right now — get a session in this week and we'll start counting.";
      case 'Personal bests': {
        if (!bests) return `No sessions in this ${tab} yet — try a wider tab or log one.`;
        const read = `Best this ${tab === 'all' ? 'all-time' : tab}: ${bests.longest.duration_min} min longest (${bests.longest.date}), ${Math.round(bests.highestLoad.load)} highest load (${bests.highestLoad.date}), ${bests.mostPeak.zones[4]} min deepest Peak-zone effort (${bests.mostPeak.date}).`;
        const why = "Three different kinds of best — endurance, total output, and pure intensity. Worth knowing which one you're actually chasing next.";
        return `${read} ${why}\n\nWhich of those do you want to try to break next?`;
      }
      default:
        return "I can talk trend, readiness, injury risk, progress, competitive benchmarks, streaks, or personal bests — tap a chip or ask about one of those directly.";
    }
  }

  // Offline fallback when the LLM call fails (no API key configured, network
  // down, upstream error) — keeps the coach usable, just less flexible.
  function localFallback(text) {
    if (DEFAULT_CHIPS.includes(text)) return coachAnswer(text);
    const low = text.toLowerCase();
    if (low.includes('trend')) return coachAnswer('How am I trending?');
    if (low.includes('ready') || low.includes('recover')) return coachAnswer('Am I ready today?');
    if (low.includes('streak')) return coachAnswer('Show my streak');
    if (low.includes('best') || low.includes('pr')) return coachAnswer('Personal bests');
    if (low.includes('injury') || low.includes('risk') || low.includes('acwr') || low.includes('workload')) return coachAnswer('Injury risk check');
    if (low.includes('improv') || low.includes('progress') || low.includes('better')) return coachAnswer('Am I improving?');
    if (low.includes('benchmark') || low.includes('competitive') || low.includes('compare to')) return coachAnswer('Vs competitive benchmark');
    return "I can talk trend, readiness, injury risk, progress, benchmarks, streaks, and bests right now — or tap a chip below.";
  }

  async function askCoach(question) {
    setCoachLoading(true);
    const digest = buildDataDigest({ enriched, tab, totals, readiness, streak, acwr, trend, thenVsNow, hrBenchmark, bests, typeBreakdown, settings, sleepTrend, hrvTrend, rhrTrend, vo2Trend, weightTrend, bodyFatTrend });
    // Keep history short — a longer prompt means longer Claude generation time,
    // and Netlify's function execution limit is a hard 10s ceiling.
    const history = messages.slice(-6).map((m) => ({ role: m.role, text: m.text }));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ system: COURTIQ_SYSTEM_PROMPT, digest, messages: history, question }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`coach endpoint returned ${res.status}`);
      const data = await res.json();
      if (!data.text) throw new Error('empty coach response');
      pushBot(data.text);
    } catch (e) {
      pushBot(localFallback(question));
    } finally {
      clearTimeout(timeout);
      setCoachLoading(false);
    }
  }

  function handleChip(chip) {
    // flows
    if (flow === 'tagLast') {
      if (chip === 'Cancel') { pushUser(chip); pushBot('No changes made.'); setFlow(null); return; }
      const last = enriched[enriched.length - 1];
      pushUser(chip);
      if (last) { setType(last.id, chip.toLowerCase()); pushBot(`Tagged ${last.date} as ${chip}.`); }
      setFlow(null); return;
    }
    if (flow === 'quickAddDuration') {
      if (chip === 'Cancel') { pushUser(chip); pushBot('Cancelled.'); setFlow(null); setPending({}); return; }
      pushUser(chip);
      const mins = parseInt(chip, 10);
      setPending((p) => ({ ...p, duration: mins }));
      pushBot('How hard did it feel?');
      setFlow('quickAddIntensity'); return;
    }
    if (flow === 'quickAddIntensity') {
      if (chip === 'Cancel') { pushUser(chip); pushBot('Cancelled.'); setFlow(null); setPending({}); return; }
      pushUser(chip);
      setPending((p) => ({ ...p, intensity: chip }));
      pushBot('Match, drill, or social?');
      setFlow('quickAddType'); return;
    }
    if (flow === 'quickAddType') {
      if (chip === 'Cancel') { pushUser(chip); pushBot('Cancelled.'); setFlow(null); setPending({}); return; }
      pushUser(chip);
      const type = chip.toLowerCase();
      const w = buildQuickWorkout(pending.duration, pending.intensity, type);
      setWorkouts((ws) => [...ws, w]);
      pushBot(`Logged: ${pending.duration} min, ${pending.intensity.toLowerCase()} ${type}, session load ${Math.round(sessionLoad(w.zones))}.`);
      setFlow(null); setPending({}); return;
    }
    // top-level actions
    if (chip === 'Tag last session') {
      pushUser(chip);
      if (enriched.length === 0) { pushBot('No sessions logged yet.'); return; }
      pushBot(`Last session was ${enriched[enriched.length - 1].date}. What type was it?`);
      setFlow('tagLast'); return;
    }
    if (chip === 'Log a quick session') {
      pushUser(chip); pushBot('How long was it?'); setFlow('quickAddDuration'); return;
    }
    if (chip === 'Load sample sessions') { pushUser(chip); addSample(); pushBot('Loaded 12 sample sessions so you can see the engine in action.'); return; }
    pushUser(chip); askCoach(chip);
  }

  function handleTextSubmit() {
    const text = inputText.trim();
    if (!text) return;
    setInputText('');
    pushUser(text);
    askCoach(text);
  }


  const currentChips = flow === 'tagLast' ? ['Match', 'Drill', 'Social', 'Cancel']
    : flow === 'quickAddDuration' ? ['30 min', '45 min', '60 min', '90 min', 'Cancel']
    : flow === 'quickAddIntensity' ? ['Easy', 'Moderate', 'Hard', 'Cancel']
    : flow === 'quickAddType' ? ['Match', 'Drill', 'Social', 'Cancel']
    : enriched.length === 0 ? ['Load sample sessions', 'Log a quick session']
    : DEFAULT_CHIPS;

  return (
    <div style={{ minHeight: '100vh', background: COL.court, color: COL.ink, fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .disp { font-family: 'Barlow Condensed', sans-serif; text-transform: uppercase; letter-spacing: 0.02em; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        button { font-family: inherit; cursor: pointer; }
        .rowfade:hover { background: ${COL.panelAlt} !important; }
        .heatcell { transition: transform 0.15s ease; }
        .heatcell:hover { transform: scale(1.25); }
        .chip { background: ${COL.panelAlt}; border: 1px solid ${COL.inkDim}44; color: ${COL.ink}; border-radius: 999px; padding: 7px 13px; font-size: 12.5px; white-space: nowrap; transition: all 0.15s ease; }
        .chip:hover { border-color: ${COL.shuttle}; color: ${COL.shuttle}; }
        .bubble-user { background: ${COL.shuttle}22; border: 1px solid ${COL.shuttle}55; align-self: flex-end; }
        .bubble-bot { background: ${COL.panelAlt}; border: 1px solid ${COL.net}; align-self: flex-start; }
        ::-webkit-scrollbar { height: 6px; width: 6px; }
      `}</style>

      <div style={{ borderBottom: `2px solid ${COL.net}`, padding: '20px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 10, height: 34, background: COL.shuttle, borderRadius: 2 }} />
          <div>
            <div className="disp" style={{ fontSize: 28, fontWeight: 700, lineHeight: 1 }}>Sachin's CourtIQ</div>
            <div style={{ fontSize: 12, color: COL.inkDim, marginTop: 2 }}>Personal coach & holistic performance analytics · structured data, not screenshots</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setShowImport(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: COL.panelAlt, border: `1px solid ${COL.inkDim}33`, color: COL.ink, padding: '9px 14px', borderRadius: 6, fontSize: 13, fontWeight: 500 }}>
            <Upload size={15} /> Workouts
          </button>
          <button onClick={() => setShowHealthImport(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: COL.panelAlt, border: `1px solid ${COL.inkDim}33`, color: COL.ink, padding: '9px 14px', borderRadius: 6, fontSize: 13, fontWeight: 500 }}>
            <Heart size={15} /> Health data
          </button>
        </div>
      </div>

      <div style={{ padding: 24, maxWidth: 1040, margin: '0 auto' }}>

        {/* coach chat */}
        <div style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 8, marginBottom: 20, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'bubble-user' : 'bubble-bot'} style={{ maxWidth: '80%', borderRadius: 10, padding: '8px 12px', fontSize: 13, lineHeight: 1.4 }}>{m.text}</div>
            ))}
            <div ref={chatEndRef} />
          </div>
          {coachLoading && (
            <div style={{ padding: '0 16px 8px', display: 'flex' }}>
              <div className="bubble-bot" style={{ borderRadius: 10, padding: '8px 12px', fontSize: 12.5, color: COL.inkDim, fontStyle: 'italic' }}>CourtIQ is reviewing the data…</div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, padding: '10px 16px', flexWrap: 'wrap', borderTop: `1px solid ${COL.net}` }}>
            {currentChips.map((c) => (<button key={c} className="chip" disabled={coachLoading} onClick={() => handleChip(c)} style={{ opacity: coachLoading ? 0.5 : 1 }}>{c}</button>))}
          </div>
          <div style={{ display: 'flex', gap: 8, padding: '0 16px 14px' }}>
            <input value={inputText} disabled={coachLoading} onChange={(e) => setInputText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleTextSubmit()} placeholder="Ask your coach…" style={{ flex: 1, background: COL.court, border: `1px solid ${COL.net}`, borderRadius: 6, padding: '8px 10px', color: COL.ink, fontSize: 13 }} />
            <button onClick={handleTextSubmit} disabled={coachLoading} style={{ background: COL.shuttle, border: 'none', borderRadius: 6, padding: '0 12px', color: '#fff', display: 'flex', alignItems: 'center', opacity: coachLoading ? 0.6 : 1 }}><Send size={15} /></button>
          </div>
        </div>

        {enriched.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 8, padding: 4, width: 'fit-content' }}>
            {[['week', 'Week'], ['month', 'Month'], ['year', 'Year'], ['all', 'All time']].map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)} style={{ padding: '7px 16px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, border: 'none', background: tab === key ? COL.shuttle : 'transparent', color: tab === key ? '#fff' : COL.inkDim }}>{label}</button>
            ))}
          </div>
        )}

        {hasHealthData && (
          <div style={{ marginBottom: 16 }}>
            <div className="disp" style={{ fontSize: 15, color: COL.inkDim, letterSpacing: '0.03em', marginBottom: 8 }}>Recovery & health</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              <HealthCard label="Sleep" unit="hrs/night" trend={sleepTrend} goodDirection="up" />
              <HealthCard label="HRV" unit="ms" trend={hrvTrend} goodDirection="up" />
              <HealthCard label="Resting HR" unit="bpm" trend={rhrTrend} goodDirection="down" />
              <HealthCard label="VO2max" unit="ml/kg/min" trend={vo2Trend} goodDirection="up" />
              <HealthCard label="Weight" unit="kg" trend={weightTrend} goodDirection="neutral" />
              <HealthCard label="Body fat" unit="%" trend={bodyFatTrend} goodDirection="down" />
            </div>
          </div>
        )}

        {enriched.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: COL.inkDim }}>
            <Activity size={40} style={{ margin: '0 auto 16px', opacity: 0.5 }} />
            <div className="disp" style={{ fontSize: 22, color: COL.ink }}>No sessions on court yet</div>
            <div style={{ fontSize: 14, marginTop: 8, maxWidth: 440, marginLeft: 'auto', marginRight: 'auto' }}>Use the chips above to load sample sessions or log a quick one — or import a real export.</div>
          </div>
        ) : totals === null ? (
          <div style={{ textAlign: 'center', padding: '50px 20px', color: COL.inkDim }}>
            <div className="disp" style={{ fontSize: 20, color: COL.ink }}>No sessions in this period</div>
            <div style={{ fontSize: 13, marginTop: 6 }}>Try a wider tab, like Year or All time.</div>
          </div>
        ) : (
          <>
            <div style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 8, padding: 20, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ width: 64, height: 64, borderRadius: '50%', border: `3px solid ${readiness.score >= 75 ? COL.zone[1] : readiness.score >= 45 ? COL.zone[3] : COL.shuttle}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{readiness.score}</span>
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: COL.inkDim, fontSize: 11 }}><Gauge size={13} /> READINESS</div>
                  <div className="disp" style={{ fontSize: 20, fontWeight: 700 }}>{readiness.label}</div>
                  <div style={{ fontSize: 12, color: COL.inkDim }}>{readiness.detail}</div>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 200, borderLeft: `1px solid ${COL.net}`, paddingLeft: 20 }}>
                <div style={{ color: COL.inkDim, fontSize: 11, marginBottom: 4 }}>TREND</div>
                <div style={{ fontSize: 13.5, lineHeight: 1.4 }}>{trend ? trendCallout(trend.delta) : 'Not enough sessions yet to spot a trend.'}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: COL.panelAlt, borderRadius: 8, padding: '10px 16px' }}>
                <Flame size={20} color={COL.shuttle} />
                <div><div className="mono" style={{ fontSize: 20, fontWeight: 600, lineHeight: 1 }}>{streak}</div><div style={{ fontSize: 10, color: COL.inkDim }}>week streak</div></div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
              <Tile label={`Sessions this ${tab === 'all' ? 'span' : tab}`} value={totals.sessions} icon={<Activity size={16} />} />
              <Tile label="Total minutes on court" value={totals.totalMin} icon={<Heart size={16} />} />
              <Tile label="Avg session load" value={Math.round(totals.avgLoad)} icon={<Gauge size={16} />} />
            </div>

            <div style={{ marginBottom: 16 }}>
              <div className="disp" style={{ fontSize: 15, color: COL.inkDim, letterSpacing: '0.03em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}><Award size={15} /> Best this {tab === 'all' ? 'all-time' : tab}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                <BestCard label="Longest on court" value={`${bests.longest.duration_min} min`} date={bests.longest.date} onClick={() => setSelected(bests.longest)} />
                <BestCard label="Highest session load" value={Math.round(bests.highestLoad.load)} date={bests.highestLoad.date} onClick={() => setSelected(bests.highestLoad)} />
                <BestCard label="Most time in Peak zone" value={`${bests.mostPeak.zones[4]} min`} date={bests.mostPeak.date} onClick={() => setSelected(bests.mostPeak)} />
              </div>
            </div>

            <div style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <div className="disp" style={{ fontSize: 15, color: COL.inkDim, letterSpacing: '0.03em', display: 'flex', alignItems: 'center', gap: 6 }}><Tag size={14} /> Load by session type</div>
                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: COL.inkDim }}>
                  {['match', 'drill', 'social'].map((t) => (<div key={t} style={{ display: 'flex', alignItems: 'center', gap: 4 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: TYPE_COLOR[t] }} />{TYPE_LABEL[t]}</div>))}
                </div>
              </div>
              <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden' }}>
                {['match', 'drill', 'social'].map((t) => (typeBreakdown[t] > 0 && <div key={t} style={{ width: `${(typeBreakdown[t] / typeTotal) * 100}%`, background: TYPE_COLOR[t] }} />))}
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div className="disp" style={{ fontSize: 15, color: COL.inkDim, letterSpacing: '0.03em', marginBottom: 8 }}>Benchmarks & comparisons</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>

                {/* ACWR injury-risk gauge */}
                <div style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 8, padding: 14 }}>
                  <div style={{ fontSize: 11, color: COL.inkDim, marginBottom: 8 }}>WORKLOAD RATIO (injury risk)</div>
                  {acwr ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span className="mono" style={{ fontSize: 24, fontWeight: 600, color: acwr.zone === 'sweet' ? COL.zone[1] : acwr.zone === 'low' ? COL.zone[3] : acwr.zone === 'caution' ? COL.zone[3] : COL.shuttle }}>{acwr.ratio}</span>
                        <span style={{ fontSize: 12, color: COL.inkDim }}>{acwr.label}</span>
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: `linear-gradient(90deg, ${COL.zone[3]} 0%, ${COL.zone[1]} 30%, ${COL.zone[1]} 65%, ${COL.zone[3]} 80%, ${COL.shuttle} 100%)`, marginTop: 8, marginBottom: 6, position: 'relative' }}>
                        <div style={{ position: 'absolute', left: `${Math.min(100, (acwr.ratio / 2) * 100)}%`, top: -3, width: 2, height: 12, background: COL.ink, borderRadius: 1 }} />
                      </div>
                      <div style={{ fontSize: 11.5, color: COL.inkDim, lineHeight: 1.4 }}>{acwr.detail}</div>
                    </>
                  ) : <div style={{ fontSize: 12, color: COL.inkDim }}>Not enough history yet.</div>}
                </div>

                {/* Then vs Now */}
                <div style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 8, padding: 14 }}>
                  <div style={{ fontSize: 11, color: COL.inkDim, marginBottom: 8 }}>THEN VS NOW</div>
                  {thenVsNow ? (
                    <>
                      <div style={{ fontSize: 12.5, marginBottom: 4 }}>Load: <span className="mono" style={{ color: thenVsNow.loadDelta >= 0 ? COL.zone[1] : COL.shuttle }}>{thenVsNow.loadDelta >= 0 ? '+' : ''}{Math.round(thenVsNow.loadDelta)}%</span></div>
                      <div style={{ fontSize: 12.5, marginBottom: 4 }}>Threshold+Peak time: <span className="mono" style={{ color: thenVsNow.pctPeakDelta >= 0 ? COL.zone[1] : COL.shuttle }}>{thenVsNow.pctPeakDelta >= 0 ? '+' : ''}{Math.round(thenVsNow.pctPeakDelta)}pts</span></div>
                      <div style={{ fontSize: 12.5 }}>Sessions/week: <span className="mono" style={{ color: thenVsNow.freqDelta >= 0 ? COL.zone[1] : COL.shuttle }}>{thenVsNow.freqDelta >= 0 ? '+' : ''}{thenVsNow.freqDelta.toFixed(1)}</span></div>
                    </>
                  ) : <div style={{ fontSize: 12, color: COL.inkDim }}>Log more sessions for a then-vs-now read.</div>}
                </div>

                {/* HR benchmark band */}
                <div style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 8, padding: 14 }}>
                  <div style={{ fontSize: 11, color: COL.inkDim, marginBottom: 8 }}>VS COMPETITIVE BADMINTON HR NORM</div>
                  {hrBenchmark ? (
                    <>
                      <div style={{ position: 'relative', height: 8, borderRadius: 4, background: COL.court, marginBottom: 8, marginTop: 4 }}>
                        <div style={{ position: 'absolute', left: `${hrBenchmark.bandLow}%`, width: `${hrBenchmark.bandHigh - hrBenchmark.bandLow}%`, height: '100%', background: `${COL.zone[1]}66`, borderRadius: 4 }} />
                        <div style={{ position: 'absolute', left: `${Math.min(100, hrBenchmark.avgPct)}%`, top: -3, width: 2, height: 14, background: COL.shuttle, borderRadius: 1 }} />
                      </div>
                      <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{hrBenchmark.avgPct}%</div>
                      <div style={{ fontSize: 11, color: COL.inkDim }}>your avg vs {hrBenchmark.bandLow}–{hrBenchmark.bandHigh}% norm ({hrBenchmark.usedMatchesOnly ? 'matches only' : 'all sessions'})</div>
                    </>
                  ) : <div style={{ fontSize: 12, color: COL.inkDim }}>No sessions to benchmark.</div>}
                </div>
              </div>
            </div>

            <div style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 8, padding: 16, marginBottom: 16, overflowX: 'auto' }}>
              <div className="disp" style={{ fontSize: 15, color: COL.inkDim, letterSpacing: '0.03em', marginBottom: 10 }}>Training density · last {heatmapWeeks} weeks</div>
              <div style={{ display: 'flex', gap: 3 }}>
                {heatmap.cols.map((col, ci) => (
                  <div key={ci} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {col.map((cell) => {
                      const intensity = cell.load === 0 ? -1 : Math.min(4, Math.floor((cell.load / heatmap.maxLoad) * 4));
                      return (<div key={cell.date} className="heatcell" title={`${cell.date}${cell.load ? ` · load ${Math.round(cell.load)}` : ''}`} style={{ width: 12, height: 12, borderRadius: 2, background: intensity < 0 ? COL.net : COL.zone[intensity], opacity: intensity < 0 ? 0.5 : 1 }} />);
                    })}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 10, color: COL.inkDim, marginTop: 8 }}>Mon–Sun columns, darker = higher load day</div>
            </div>

            <div style={{ background: COL.panel, borderRadius: 8, padding: '18px 18px 6px', marginBottom: 16, border: `1px solid ${COL.net}` }}>
              <div className="disp" style={{ fontSize: 16, marginBottom: 8, color: COL.inkDim, letterSpacing: '0.03em' }}>Session load over time</div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={filtered} margin={{ left: -10, right: 10 }}>
                  <CartesianGrid stroke={COL.net} strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fill: COL.inkDim, fontSize: 11 }} tickFormatter={(d) => d.slice(tab === 'year' || tab === 'all' ? 2 : 5)} />
                  <YAxis tick={{ fill: COL.inkDim, fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: COL.panelAlt, border: `1px solid ${COL.net}`, borderRadius: 6, fontSize: 12 }} labelStyle={{ color: COL.ink }} />
                  <Line type="monotone" dataKey="load" stroke={COL.shuttle} strokeWidth={2.5} dot={{ r: 3, fill: COL.shuttle }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background: COL.panel, borderRadius: 8, padding: 18, marginBottom: 16, border: `1px solid ${COL.net}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                <div className="disp" style={{ fontSize: 16, color: COL.inkDim, letterSpacing: '0.03em' }}>Rallies — minutes per HR zone</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button onClick={() => { setCompareMode((v) => !v); setCompareIds([]); }} style={{ fontSize: 11, padding: '5px 10px', borderRadius: 5, border: `1px solid ${compareMode ? COL.shuttle : COL.inkDim + '55'}`, background: compareMode ? COL.shuttle : 'transparent', color: compareMode ? '#fff' : COL.inkDim, fontWeight: 600 }}>{compareMode ? 'Exit compare' : 'Compare'}</button>
                  <div style={{ display: 'flex', gap: 12, fontSize: 11, color: COL.inkDim }}>
                    {ZONE_LABELS.map((l, i) => (<div key={l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}><div style={{ width: 8, height: 8, background: COL.zone[i], borderRadius: 2 }} />{l}</div>))}
                  </div>
                </div>
              </div>

              {compareMode && (
                <div style={{ fontSize: 11.5, color: COL.inkDim, marginBottom: 10 }}>Tap up to 2 sessions below to compare them side by side.</div>
              )}

              {compareMode && compareSessions.length === 2 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16, background: COL.court, border: `1px solid ${COL.net}`, borderRadius: 8, padding: 12 }}>
                  {compareSessions.map((w) => (
                    <div key={w.id}>
                      <div className="mono" style={{ fontSize: 12, color: COL.inkDim, marginBottom: 6 }}>{w.date}</div>
                      <div style={{ fontSize: 11, marginBottom: 4 }}>Duration: <span className="mono">{w.duration_min}m</span></div>
                      <div style={{ fontSize: 11, marginBottom: 4 }}>Load: <span className="mono">{Math.round(w.load)}</span></div>
                      <div style={{ fontSize: 11, marginBottom: 8 }}>Avg/Peak HR: <span className="mono">{w.avg_hr}/{w.max_hr}</span></div>
                      <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden', marginBottom: 4 }}>
                        {w.zones.map((mins, i) => (mins > 0 && <div key={i} style={{ width: `${(mins / w.duration_min) * 100}%`, background: COL.zone[i] }} />))}
                      </div>
                      <div style={{ fontSize: 10, color: TYPE_COLOR[w.type] }}>{TYPE_LABEL[w.type]}</div>
                    </div>
                  ))}
                </div>
              )}

              <div>
                {filtered.slice(-15).map((w) => (
                  <div key={w.id} className="rowfade" onClick={() => (compareMode ? toggleCompare(w.id) : setSelected(w))} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 6px', borderRadius: 6, cursor: 'pointer', outline: compareMode && compareIds.includes(w.id) ? `2px solid ${COL.shuttle}` : 'none' }}>
                    <div className="mono" style={{ fontSize: 11, color: COL.inkDim, width: 66, flexShrink: 0 }}>{w.date.slice(5)}</div>
                    <div title={TYPE_LABEL[w.type]} style={{ width: 6, height: 16, borderRadius: 2, background: TYPE_COLOR[w.type], flexShrink: 0 }} />
                    <ZoneBadge source={w.zonesSource} />
                    <div style={{ flex: 1, display: 'flex', height: 16, borderRadius: 3, overflow: 'hidden' }}>
                      {w.zones.map((mins, i) => (mins > 0 && <div key={i} style={{ width: `${(mins / w.duration_min) * 100}%`, background: COL.zone[i] }} title={`${ZONE_LABELS[i]}: ${mins}m`} />))}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: COL.inkDim, width: 50, textAlign: 'right' }}>{w.duration_min}m</div>
                    <ChevronRight size={14} color={COL.inkDim} />
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background: COL.panel, borderRadius: 8, padding: '18px 18px 6px', marginBottom: 16, border: `1px solid ${COL.net}` }}>
              <div className="disp" style={{ fontSize: 16, marginBottom: 8, color: COL.inkDim, letterSpacing: '0.03em' }}>Avg vs peak HR per session</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={filtered} margin={{ left: -10, right: 10 }}>
                  <CartesianGrid stroke={COL.net} strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fill: COL.inkDim, fontSize: 11 }} tickFormatter={(d) => d.slice(tab === 'year' || tab === 'all' ? 2 : 5)} />
                  <YAxis tick={{ fill: COL.inkDim, fontSize: 11 }} domain={[settings.restingHR, 'dataMax + 10']} />
                  <Tooltip contentStyle={{ background: COL.panelAlt, border: `1px solid ${COL.net}`, borderRadius: 6, fontSize: 12 }} labelStyle={{ color: COL.ink }} />
                  <Bar dataKey="max_hr" fill={COL.zone[4]} radius={[3, 3, 0, 0]} barSize={14} />
                  <Bar dataKey="avg_hr" fill={COL.zone[1]} radius={[3, 3, 0, 0]} barSize={14} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div style={{ textAlign: 'right' }}>
              <button onClick={removeAll} style={{ background: 'transparent', border: 'none', color: COL.inkDim, fontSize: 12, textDecoration: 'underline' }}>Clear all sessions</button>
            </div>
          </>
        )}
      </div>

      {showImport && (
        <div style={{ position: 'fixed', inset: 0, background: '#000000aa', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 10 }}>
          <div style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 10, padding: 22, maxWidth: 520, width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div className="disp" style={{ fontSize: 18 }}>Import workout export</div>
              <button onClick={() => setShowImport(false)} style={{ background: 'none', border: 'none', color: COL.inkDim }}><X size={18} /></button>
            </div>
            <div style={{ fontSize: 12, color: COL.inkDim, marginBottom: 10 }}>Choose the JSON file directly, or paste its contents below. Structured fields only — no screenshots to parse.</div>
            <div style={{ fontSize: 11, color: COL.inkDim, background: COL.court, border: `1px solid ${COL.net}`, borderRadius: 6, padding: 10, marginBottom: 10 }}>
              For real HR-zone minutes: enable <strong style={{ color: COL.ink }}>Heart Rate</strong> per-sample detail in Health Auto Export's Workouts export. The engine looks for a <code>heartRateData</code> array.
            </div>
            <input ref={fileInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={handleFileSelect} />
            <button onClick={() => fileInputRef.current?.click()} style={{ width: '100%', background: COL.panelAlt, border: `1px dashed ${COL.inkDim}66`, color: COL.ink, padding: '12px 14px', borderRadius: 6, fontSize: 13, fontWeight: 500, marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <Upload size={15} /> {fileName || 'Choose JSON file from your phone'}
            </button>
            <div style={{ fontSize: 11, color: COL.inkDim, textAlign: 'center', marginBottom: 10 }}>— or paste manually —</div>
            <textarea value={importText} onChange={(e) => { setImportText(e.target.value); setFileName(''); }} placeholder='{"workouts": [{"date": "2026-07-05", "duration": 3720, "avgHeartRate": 132, "maxHeartRate": 171, "activeEnergy": 540}]}' style={{ width: '100%', height: 120, background: COL.court, border: `1px solid ${COL.net}`, borderRadius: 6, color: COL.ink, padding: 10, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", resize: 'vertical' }} />
            {importError && <div style={{ color: COL.shuttle, fontSize: 12, marginTop: 8 }}>{importError}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowImport(false)} style={{ background: 'transparent', border: `1px solid ${COL.inkDim}55`, color: COL.inkDim, padding: '8px 14px', borderRadius: 6, fontSize: 13 }}>Cancel</button>
              <button onClick={doImport} style={{ background: COL.shuttle, border: 'none', color: '#fff', padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600 }}>Import</button>
            </div>
          </div>
        </div>
      )}

      {showHealthImport && (
        <div style={{ position: 'fixed', inset: 0, background: '#000000aa', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 10 }}>
          <div style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 10, padding: 22, maxWidth: 520, width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div className="disp" style={{ fontSize: 18 }}>Import health data</div>
              <button onClick={() => setShowHealthImport(false)} style={{ background: 'none', border: 'none', color: COL.inkDim }}><X size={18} /></button>
            </div>
            <div style={{ fontSize: 12, color: COL.inkDim, marginBottom: 10 }}>Export from Health Auto Export's <strong style={{ color: COL.ink }}>Health Metrics</strong> tab (not Workouts) — select Sleep, HRV, Resting Heart Rate, VO2 Max, Weight, and Body Fat.</div>
            <div style={{ fontSize: 11, color: COL.inkDim, background: COL.court, border: `1px solid ${COL.net}`, borderRadius: 6, padding: 10, marginBottom: 10 }}>
              This merges into what's already stored — importing overlapping dates just updates those days, nothing is duplicated.
            </div>
            <input ref={healthFileInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={handleHealthFileSelect} />
            <button onClick={() => healthFileInputRef.current?.click()} style={{ width: '100%', background: COL.panelAlt, border: `1px dashed ${COL.inkDim}66`, color: COL.ink, padding: '12px 14px', borderRadius: 6, fontSize: 13, fontWeight: 500, marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <Upload size={15} /> {healthFileName || 'Choose JSON file from your phone'}
            </button>
            <div style={{ fontSize: 11, color: COL.inkDim, textAlign: 'center', marginBottom: 10 }}>— or paste manually —</div>
            <textarea value={healthImportText} onChange={(e) => { setHealthImportText(e.target.value); setHealthFileName(''); }} placeholder='{"sleepTime": [{"date":"2026-07-05","unit":"min","value":420}], "heartRateVariability": [...], "restingHeartRate": [...], "vo2Max": [...], "weight": [...], "bodyFat": [...]}' style={{ width: '100%', height: 120, background: COL.court, border: `1px solid ${COL.net}`, borderRadius: 6, color: COL.ink, padding: 10, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", resize: 'vertical' }} />
            {healthImportError && <div style={{ color: COL.shuttle, fontSize: 12, marginTop: 8 }}>{healthImportError}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowHealthImport(false)} style={{ background: 'transparent', border: `1px solid ${COL.inkDim}55`, color: COL.inkDim, padding: '8px 14px', borderRadius: 6, fontSize: 13 }}>Cancel</button>
              <button onClick={doHealthImport} style={{ background: COL.shuttle, border: 'none', color: '#fff', padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600 }}>Import</button>
            </div>
          </div>
        </div>
      )}

      {selected && (
        <div style={{ position: 'fixed', inset: 0, background: '#000000aa', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 10 }} onClick={() => setSelected(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 10, padding: 22, maxWidth: 420, width: '100%' }}>
            <div className="disp" style={{ fontSize: 20, marginBottom: 4 }}>{selected.date}</div>
            <div style={{ fontSize: 12, color: COL.inkDim, marginBottom: 4 }}>Session load {Math.round(sessionLoad(selected.zones))} · {selected.duration_min} min on court</div>
            <div style={{ marginBottom: 10 }}><ZoneBadge source={selected.zonesSource} verbose /></div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
              {['match', 'drill', 'social'].map((t) => (<button key={t} onClick={() => setType(selected.id, t)} style={{ fontSize: 11, padding: '5px 10px', borderRadius: 5, border: `1px solid ${TYPE_COLOR[t]}`, background: (selected.type || 'drill') === t ? TYPE_COLOR[t] : 'transparent', color: (selected.type || 'drill') === t ? COL.net : TYPE_COLOR[t], fontWeight: 600 }}>{TYPE_LABEL[t]}</button>))}
            </div>
            {ZONE_LABELS.map((l, i) => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 13 }}>
                <div style={{ width: 10, height: 10, background: COL.zone[i], borderRadius: 2 }} />
                <div style={{ width: 90, color: COL.inkDim }}>{l}</div>
                <div className="mono">{selected.zones[i]} min</div>
              </div>
            ))}
            <div style={{ marginTop: 12, fontSize: 12, color: COL.inkDim }}>Avg HR {selected.avg_hr} · Peak HR {selected.max_hr} · {selected.calories} kcal</div>
          </div>
        </div>
      )}
    </div>
  );
}

function ZoneBadge({ source, verbose }) {
  const map = {
    measured: { text: verbose ? 'Zones measured from HR samples' : 'measured', color: COL.zone[1] },
    estimated: { text: verbose ? 'Zones estimated from avg/max HR only — not real sample data' : 'estimated', color: COL.shuttle },
    sample: { text: verbose ? 'Fabricated demo data — not a real workout' : 'demo', color: COL.inkDim },
  };
  const m = map[source] || map.estimated;
  return (<div title={m.text} style={{ fontSize: 9, color: m.color, border: `1px solid ${m.color}66`, borderRadius: 4, padding: verbose ? '3px 8px' : '1px 6px', flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{m.text}</div>);
}
function Tile({ label, value, icon }) {
  return (<div style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 8, padding: 14 }}><div style={{ display: 'flex', alignItems: 'center', gap: 6, color: COL.inkDim, fontSize: 11, marginBottom: 6 }}>{icon}{label}</div><div className="mono" style={{ fontSize: 26, fontWeight: 600 }}>{value}</div></div>);
}
function BestCard({ label, value, date, onClick }) {
  return (<div onClick={onClick} className="rowfade" style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 8, padding: 14, cursor: 'pointer' }}><div style={{ fontSize: 11, color: COL.inkDim, marginBottom: 6 }}>{label}</div><div className="mono" style={{ fontSize: 22, fontWeight: 600, color: COL.shuttle }}>{value}</div><div style={{ fontSize: 10, color: COL.inkDim, marginTop: 4 }}>{date}</div></div>);
}
function HealthCard({ label, unit, trend, goodDirection }) {
  if (!trend) return (<div style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 8, padding: 14 }}><div style={{ fontSize: 11, color: COL.inkDim, marginBottom: 6 }}>{label}</div><div style={{ fontSize: 12, color: COL.inkDim }}>No data</div></div>);
  const delta = trend.delta;
  let deltaColor = COL.inkDim;
  if (delta != null && goodDirection !== 'neutral') {
    const improving = goodDirection === 'up' ? delta > 0 : delta < 0;
    deltaColor = Math.abs(delta) < 2 ? COL.inkDim : improving ? COL.zone[1] : COL.shuttle;
  }
  return (
    <div style={{ background: COL.panel, border: `1px solid ${COL.net}`, borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 11, color: COL.inkDim, marginBottom: 6 }}>{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{Math.round(trend.latest * 10) / 10} <span style={{ fontSize: 11, color: COL.inkDim, fontWeight: 400 }}>{unit}</span></div>
      {delta != null && <div style={{ fontSize: 11, color: deltaColor, marginTop: 4 }}>{delta > 0 ? '+' : ''}{Math.round(delta * 10) / 10}% (14d)</div>}
    </div>
  );
}
