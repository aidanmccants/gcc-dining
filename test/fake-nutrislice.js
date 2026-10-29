/* A tiny fake of the Nutrislice API for tests: /schools/ plus week menus. */
import { vi } from "vitest";

const days = (on, start, end) =>
  Object.fromEntries(
    ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].flatMap((d) => [
      [`${d}_enabled`, on.includes(d)],
      [`${d}_start`, start],
      [`${d}_end`, end],
      [`${d}_is_24_hours`, false],
    ])
  );
const weekdays = ["mon", "tue", "wed", "thu", "fri"];
const type = (id, slug, name) => ({ id, slug, name });

export const SCHOOLS = [
  {
    slug: "map-cafe", name: "MAP Café", operating_status: "closed", wayfinding_note: "", phone_number: "",
    address: "", geolocation: null, operating_start_date: "2025-08-27", operating_end_date: null,
    ...days(weekdays, "07:00:00", "20:00:00"),
    active_menu_types: [type(1, "breakfast", "Breakfast"), type(2, "lunch", "Lunch"), type(3, "dinner", "Dinner")],
    operating_days_by_menu_type: [
      { menu_type_id: 2, menu_type_name: "Lunch", ...days(weekdays, "11:00:00", "16:29:00") },
    ],
  },
  {
    slug: "hicks-cafe", name: "Hicks Café", operating_status: "open", wayfinding_note: "",
    ...days([...weekdays, "sat", "sun"], "07:00:00", "21:00:00"),
    active_menu_types: [type(1, "breakfast", "Breakfast"), type(2, "lunch", "Lunch"), type(3, "dinner", "Dinner")],
    operating_days_by_menu_type: [],
  },
  {
    slug: "map-market", name: "MAP Market", operating_status: "open", wayfinding_note: "Mary Anderson Pew West Hall",
    ...days([], "00:00:00", "23:59:00"), mon_enabled: true, mon_is_24_hours: true,
    active_menu_types: [type(9, "retail-menu", "Retail Menu")],
  },
];

export const section = (text) => ({ is_section_title: true, text });
export const holiday = (text) => ({ is_section_title: false, is_holiday: true, text, food: null });
export const food = (name, extra = {}) => ({
  is_section_title: false,
  text: "",
  food: {
    id: 42, name, food_category: "entree", description: "", price: null, image_url: null,
    icons: { food_icons: [{ id: 1, name: "Vegan", slug: "vegan", help_text: "Vegan" }] },
    rounded_nutrition_info: { calories: 300, g_protein: 20, mg_vitamin_c: null },
    serving_size_info: { serving_size_amount: "1", serving_size_unit: "each" },
    ingredients: "Bread, Cheese",
    ...extra,
  },
});

// menus: { "map-cafe|lunch|2026-10-15": [items...] }; any other day is empty.
export function fakeNutrislice(menus = {}) {
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/menu/api/schools/")) return new Response(JSON.stringify(SCHOOLS));
      const m = u.match(/weeks\/school\/([^/]+)\/menu-type\/([^/]+)\/(\d{4})\/(\d{2})\/(\d{2})\/$/);
      if (!m) return new Response("not found", { status: 404 });
      const [, slug, meal, y, mo, d] = m;
      const start = new Date(Date.UTC(+y, +mo - 1, +d));
      start.setUTCDate(start.getUTCDate() - start.getUTCDay());
      const week = Array.from({ length: 7 }, (_, i) => {
        const date = new Date(start.getTime() + i * 864e5).toISOString().slice(0, 10);
        return { date, menu_items: menus[`${slug}|${meal}|${date}`] || [] };
      });
      return new Response(JSON.stringify({ days: week }));
    })
  );
  return calls;
}
