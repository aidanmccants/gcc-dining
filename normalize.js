/* Pure helpers for /locations.json and /menu.json (and the matching MCP tools). No I/O. */

import { stationEntries, iconsField, holidayNotice } from "./menu-json.js";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// Drop null, undefined, "", {} and [] so responses only carry real data.
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) continue;
    out[k] = v;
  }
  return out;
}

const hhmm = (t) => (typeof t === "string" ? t.slice(0, 5) : null);

// Nutrislice's mon_enabled/mon_start/mon_end/mon_is_24_hours... -> { mon: { open, close } | null, ... }
export function weekHours(src) {
  if (!src) return undefined;
  const out = {};
  for (const d of DAYS) {
    if (!src[`${d}_enabled`]) out[d] = null;
    else if (src[`${d}_is_24_hours`]) out[d] = { open: "00:00", close: "24:00", all_day: true };
    else out[d] = { open: hhmm(src[`${d}_start`]), close: hhmm(src[`${d}_end`]) };
  }
  return out;
}

// Location hours win: each meal window is trimmed to the location's hours that day, and dropped
// (null) if the location is closed or the windows don't overlap. Nutrislice's per-meal hours are
// sometimes stale, e.g. Hicks lists dinner until 21:00 on Saturdays while Hicks closes at 19:00.
export function clipHours(meal, location) {
  if (!meal || !location) return meal;
  const out = {};
  for (const d of DAYS) {
    const m = meal[d], l = location[d];
    if (!m || !l) { out[d] = null; continue; }
    const open = m.open > l.open ? m.open : l.open;
    const close = m.close < l.close ? m.close : l.close;
    if (open >= close) out[d] = null;
    else if (m.all_day && l.all_day) out[d] = m;
    else out[d] = { open, close };
  }
  return out;
}

// One entry of GET /schools/.
export function locationJson(s) {
  const mealHours = new Map((s.operating_days_by_menu_type || []).map((o) => [o.menu_type_id, o]));
  const hours = weekHours(s);
  return compact({
    slug: s.slug,
    name: s.name,
    // Nutrislice's own open/closed flag. It follows the weekly schedule, not break closures.
    status: s.operating_status,
    building: s.wayfinding_note,
    phone: s.phone_number,
    address: s.address,
    geolocation: s.geolocation,
    season: compact({ start: s.operating_start_date, end: s.operating_end_date }),
    hours,
    meals: (s.active_menu_types || []).map((t) =>
      compact({ slug: t.slug, name: t.name, hours: clipHours(weekHours(mealHours.get(t.id)), hours) })
    ),
  });
}

function nutrition(info) {
  if (!info || typeof info !== "object") return undefined;
  const out = {};
  for (const [k, v] of Object.entries(info)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export function itemJson({ name, item }, details) {
  const icons = iconsField(item);
  const base = icons === undefined ? { name } : { name, icons };
  const f = item.food;
  if (!details || !f) return base;
  const size = f.serving_size_info || {};
  return {
    ...base,
    ...compact({
      id: f.id,
      category: f.food_category,
      description: f.description,
      subtext: f.subtext,
      highlight: f.food_highlight_message,
      price: f.price,
      serving_size: compact({ amount: size.serving_size_amount, unit: size.serving_size_unit }),
      nutrition: nutrition(f.rounded_nutrition_info),
      ingredients: f.ingredients,
      image_url: f.image_url,
    }),
  };
}

// One location + meal + day. state: "menu" | "closed" (posted closure notice) | "none" (nothing posted).
export function dayJson(items, details) {
  if (!Array.isArray(items)) return { state: "none" };
  const notice = holidayNotice(items);
  const groups = stationEntries(items);
  if (groups.length) {
    return {
      state: "menu",
      ...(notice ? { notice } : {}),
      stations: groups.map((g) => ({ name: g.station, items: g.entries.map((e) => itemJson(e, details)) })),
    };
  }
  return notice ? { state: "closed", notice } : { state: "none" };
}
