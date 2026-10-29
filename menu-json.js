/* Pure helpers for GET /{meal}/compare.json. No I/O here so they can be unit tested. */

const MEAL_SET = new Set(["breakfast", "lunch", "dinner"]);
export const MAX_BYTES = 200 * 1024;

export function validMeal(meal) {
  return MEAL_SET.has(meal);
}

export function validDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// Same station/item walk as the plain-text endpoint (worker.js stationGroups uses this too).
export function stationEntries(items) {
  const groups = [];
  let current = null;
  for (const it of items) {
    if (it.is_holiday) continue; // closure notices, see holidayNotice()
    if (it.is_section_title || it.is_station_header) {
      const name = (it.text || "").trim();
      if (name) {
        current = { station: name, entries: [] };
        groups.push(current);
      }
    } else {
      const name = ((it.food && it.food.name) || it.text || "").trim();
      if (name && current) current.entries.push({ name, item: it });
    }
  }
  return groups.filter((g) => g.entries.length);
}

// Nutrislice marks closures with is_holiday rows, e.g. "Closed for Fall Break". Not every hall posts them.
export function holidayNotice(items) {
  if (!Array.isArray(items)) return undefined;
  const texts = [...new Set(items.filter((it) => it.is_holiday).map((it) => (it.text || "").trim()).filter(Boolean))];
  return texts.length ? texts.join(" / ") : undefined;
}

// absent = unknown, [] = source says none, [{name, slug}] = raw icons.
export function iconsField(item) {
  const list = item && item.food && item.food.icons && item.food.icons.food_icons;
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (const i of list) {
    if (!i || typeof i.name !== "string" || typeof i.slug !== "string") return undefined;
    out.push({ name: i.name, slug: i.slug });
  }
  return out;
}

// state stays "menu" | "none" for existing clients (Plate); a closure only adds `notice`.
export function hallJson(items) {
  if (items === null || items === undefined) return { state: "none", stations: [] };
  const notice = holidayNotice(items);
  const groups = stationEntries(items);
  if (!groups.length) return notice ? { state: "none", notice, stations: [] } : { state: "none", stations: [] };
  return {
    state: "menu",
    ...(notice ? { notice } : {}),
    stations: groups.map((g) => ({
      name: g.station,
      items: g.entries.map(({ name, item }) => {
        const icons = iconsField(item);
        return icons === undefined ? { name } : { name, icons };
      }),
    })),
  };
}

export function buildCompareJson(meal, ymd, mapItems, hicksItems) {
  return { date: ymd, meal, halls: { map: hallJson(mapItems), hicks: hallJson(hicksItems) } };
}
