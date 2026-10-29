import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import { fakeNutrislice, section, holiday, food } from "./fake-nutrislice.js";
import { clipHours } from "../normalize.js";

afterEach(() => vi.unstubAllGlobals());
const get = (path) => worker.fetch(new Request("https://menu.internal" + path), {});

describe("GET /locations.json", () => {
  it("returns every location with status, hours, and per-meal hours", async () => {
    fakeNutrislice();
    const res = await get("/locations.json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const { locations } = await res.json();
    expect(locations.map((l) => l.slug)).toEqual(["map-cafe", "hicks-cafe", "map-market"]);
    const map = locations[0];
    expect(map.status).toBe("closed");
    expect(map.season).toEqual({ start: "2025-08-27" });
    expect(map.hours.mon).toEqual({ open: "07:00", close: "20:00" });
    expect(map.hours.sat).toBeNull();
    expect(map.meals.find((m) => m.slug === "lunch").hours.fri).toEqual({ open: "11:00", close: "16:29" });
    expect("hours" in map.meals.find((m) => m.slug === "dinner")).toBe(false);
    expect("building" in map).toBe(false); // empty strings are dropped
    expect(locations[2].building).toBe("Mary Anderson Pew West Hall");
    expect(locations[2].hours.mon).toEqual({ open: "00:00", close: "24:00", all_day: true });
  });
  it("trims meal hours to the location's hours", () => {
    const loc = { mon: { open: "07:00", close: "19:00" }, tue: null, wed: { open: "00:00", close: "24:00", all_day: true },
      thu: { open: "07:00", close: "19:00" }, fri: { open: "07:00", close: "14:30" }, sat: { open: "07:00", close: "19:00" }, sun: null };
    const dinner = { mon: { open: "16:30", close: "21:00" }, tue: { open: "16:30", close: "21:00" },
      wed: { open: "16:30", close: "21:00" }, thu: { open: "06:00", close: "08:00" }, fri: { open: "16:30", close: "20:00" },
      sat: null, sun: { open: "16:30", close: "21:00" } };
    expect(clipHours(dinner, loc)).toEqual({
      mon: { open: "16:30", close: "19:00" }, // overrun clipped to closing time
      tue: null, // location closed
      wed: { open: "16:30", close: "21:00" }, // 24-hour location doesn't clip
      thu: { open: "07:00", close: "08:00" }, // early start clipped to opening time
      fri: null, // no overlap
      sat: null,
      sun: null,
    });
  });
  it("applies the trim in /locations.json", async () => {
    fakeNutrislice();
    const { locations } = await (await get("/locations.json")).json();
    // fake MAP: open 07:00-20:00 weekdays; lunch 11:00-16:29 fits inside, so it is unchanged
    expect(locations[0].meals.find((m) => m.slug === "lunch").hours.mon).toEqual({ open: "11:00", close: "16:29" });
  });
  it("502s when Nutrislice is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    expect((await get("/locations.json")).status).toBe(502);
  });
});

describe("GET /menu.json", () => {
  it("defaults to MAP and Hicks, all their meals, one day", async () => {
    fakeNutrislice({ "map-cafe|lunch|2026-10-14": [section("GRILL"), food("Burger")] });
    const body = await (await get("/menu.json?date=2026-10-14")).json();
    expect(body.start).toBe("2026-10-14");
    expect(body.days).toHaveLength(1);
    expect(body.days[0].weekday).toBe("Wednesday");
    const locs = body.days[0].locations;
    expect(Object.keys(locs)).toEqual(["map-cafe", "hicks-cafe"]);
    expect(locs["map-cafe"].name).toBe("MAP Café");
    expect(Object.keys(locs["map-cafe"].meals)).toEqual(["breakfast", "lunch", "dinner"]);
    expect(locs["map-cafe"].meals.lunch).toEqual({
      state: "menu",
      stations: [{ name: "GRILL", items: [{ name: "Burger", icons: [{ name: "Vegan", slug: "vegan" }] }] }],
    });
    expect(locs["hicks-cafe"].meals.lunch).toEqual({ state: "none" });
  });
  it("reports posted closures as state closed with the notice", async () => {
    fakeNutrislice({ "map-cafe|lunch|2026-10-15": [holiday("Closed for Fall Break")] });
    const body = await (await get("/menu.json?date=2026-10-15&location=map&meal=lunch")).json();
    expect(body.days[0].locations["map-cafe"].meals).toEqual({
      lunch: { state: "closed", notice: "Closed for Fall Break" },
    });
  });
  it("adds nutrition, ingredients, and serving size with details=1", async () => {
    fakeNutrislice({ "hicks-cafe|dinner|2026-10-14": [section("S"), food("Pasta")] });
    const body = await (await get("/menu.json?date=2026-10-14&location=hicks&meal=dinner&details=1")).json();
    expect(body.days[0].locations["hicks-cafe"].meals.dinner.stations[0].items[0]).toEqual({
      name: "Pasta",
      icons: [{ name: "Vegan", slug: "vegan" }],
      id: 42,
      category: "entree",
      serving_size: { amount: "1", unit: "each" },
      nutrition: { calories: 300, g_protein: 20 },
      ingredients: "Bread, Cheese",
    });
  });
  it("spans weeks with one upstream request per location, meal, and week", async () => {
    const calls = fakeNutrislice({ "map-cafe|dinner|2026-10-18": [section("S"), food("Soup")] });
    const body = await (await get("/menu.json?date=2026-10-16&days=4&location=map-cafe&meal=dinner")).json();
    expect(body.days.map((d) => d.date)).toEqual(["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]);
    expect(body.days[2].locations["map-cafe"].meals.dinner.state).toBe("menu");
    expect(calls.filter((u) => u.includes("/weeks/"))).toHaveLength(2);
  });
  it("supports location=all and other menu types", async () => {
    fakeNutrislice();
    const body = await (await get("/menu.json?date=2026-10-14&location=all")).json();
    expect(Object.keys(body.days[0].locations)).toEqual(["map-cafe", "hicks-cafe", "map-market"]);
    expect(Object.keys(body.days[0].locations["map-market"].meals)).toEqual(["retail-menu"]);
  });
  it("400s on bad input", async () => {
    fakeNutrislice();
    for (const q of ["date=2026-13-01", "days=8", "days=0", "location=nope", "meal=brunch"]) {
      const res = await get(`/menu.json?${q}`);
      expect(res.status, q).toBe(400);
      expect((await res.json()).error, q).toBeTruthy();
    }
  });
});

describe("GET /raw/*", () => {
  it("proxies Nutrislice with the trailing slash and query intact", async () => {
    const calls = fakeNutrislice();
    const res = await get("/raw/schools/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await res.json())[0].slug).toBe("map-cafe");
    expect(calls).toEqual(["https://gcc.api.nutrislice.com/menu/api/schools/"]);
  });
  it("rejects path traversal", async () => {
    fakeNutrislice();
    expect((await get("/raw/schools/..%2F..%2Fadmin/")).status).toBe(400);
  });
});

describe("closure notices in existing outputs", () => {
  it("compare.json keeps state none but adds the notice", async () => {
    fakeNutrislice({ "map-cafe|lunch|2026-10-15": [holiday("Closed for Fall Break")] });
    const body = await (await get("/lunch/compare.json?date=2026-10-15")).json();
    expect(body.halls.map).toEqual({ state: "none", notice: "Closed for Fall Break", stations: [] });
    expect(body.halls.hicks).toEqual({ state: "none", stations: [] });
  });
  it("text endpoint shows the notice instead of (no menu posted)", async () => {
    fakeNutrislice({ "map-cafe|lunch|2026-10-15": [holiday("Closed for Fall Break")] });
    const text = await (await get("/lunch/map?date=2026-10-15")).text();
    expect(text).toContain("Closed for Fall Break");
    expect(text).not.toContain("no menu posted");
  });
  it("browsers can preflight the JSON endpoints", async () => {
    const res = await worker.fetch(new Request("https://menu.internal/menu.json", { method: "OPTIONS" }), {});
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});
