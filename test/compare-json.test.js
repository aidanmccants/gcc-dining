import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import { buildCompareJson, validDate, stationEntries } from "../menu-json.js";

const section = (text) => ({ is_section_title: true, text });
const food = (name, icons) => ({
  is_section_title: false,
  text: "",
  food: { name, ...(icons === undefined ? {} : { icons: { food_icons: icons } }) },
});
const pork = { id: 1, name: "Pork", slug: "pork", synced_name: "Pork", extra: "x" };

const lunchItems = [
  section("MAP INSPIRED EATS"),
  food("Brown Sugar BBQ Pork", [pork]),
  food("Brown Rice", []),
  food("Mystery Stew"),
];

const week = (ymd, items) => ({ days: [{ date: ymd, menu_items: items }] });

function mockUpstream(fn) {
  vi.stubGlobal("fetch", vi.fn(async (url) => fn(String(url))));
}
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
const get = (path) => worker.fetch(new Request("https://menu.internal" + path), {});

afterEach(() => vi.unstubAllGlobals());

describe("buildCompareJson", () => {
  const out = buildCompareJson("lunch", "2026-09-29", lunchItems, null);
  it("echoes date and meal and has both halls", () => {
    expect(out.date).toBe("2026-09-29");
    expect(out.meal).toBe("lunch");
    expect(Object.keys(out.halls).sort()).toEqual(["hicks", "map"]);
  });
  it("passes icons through raw as {name, slug} only", () => {
    expect(out.halls.map.stations[0].items[0]).toEqual({
      name: "Brown Sugar BBQ Pork",
      icons: [{ name: "Pork", slug: "pork" }],
    });
  });
  it("keeps icons: [] when the source lists none", () => {
    expect(out.halls.map.stations[0].items[1]).toEqual({ name: "Brown Rice", icons: [] });
  });
  it("omits icons entirely when the source has no icon field", () => {
    const item = out.halls.map.stations[0].items[2];
    expect(item).toEqual({ name: "Mystery Stew" });
    expect("icons" in item).toBe(false);
  });
  it("treats malformed icon data as unknown, not empty", () => {
    const o = buildCompareJson("lunch", "2026-09-29", [section("S"), food("X", [{ name: "Pork" }])], []);
    expect("icons" in o.halls.map.stations[0].items[0]).toBe(false);
  });
  it("reports state none for null, empty, or item-less menus", () => {
    expect(out.halls.hicks).toEqual({ state: "none", stations: [] });
    expect(buildCompareJson("lunch", "2026-09-29", [], [section("S")]).halls.hicks.state).toBe("none");
  });
});

describe("station walk matches the original text-endpoint logic", () => {
  it("same stations and names as the original stationGroups", () => {
    const items = [food("Orphan"), section("A"), food("a1"), food("  "), section(" "), food("a2"), section("B")];
    const original = [];
    let cur = null;
    for (const it of items) {
      if (it.is_section_title || it.is_station_header) {
        const name = (it.text || "").trim();
        if (name) { cur = { station: name, names: [] }; original.push(cur); }
      } else {
        const name = ((it.food && it.food.name) || it.text || "").trim();
        if (name && cur) cur.names.push(name);
      }
    }
    const mine = stationEntries(items).map((g) => ({ station: g.station, names: g.entries.map((e) => e.name) }));
    expect(mine).toEqual(original.filter((g) => g.names.length));
  });
});

describe("validDate", () => {
  it("rejects impossible calendar dates", () => {
    expect(validDate("2026-02-30")).toBe(false);
    expect(validDate("2026-13-01")).toBe(false);
    expect(validDate("2026-9-29")).toBe(false);
    expect(validDate("2026-09-29")).toBe(true);
  });
});

describe("GET /{meal}/compare.json", () => {
  it("returns the contract for a valid request", async () => {
    mockUpstream((u) => ok(week("2026-09-29", u.includes("map-cafe") ? lunchItems : [])));
    const res = await get("/lunch/compare.json?date=2026-09-29");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body.date).toBe("2026-09-29");
    expect(body.meal).toBe("lunch");
    expect(body.halls.map.state).toBe("menu");
    expect(body.halls.hicks.state).toBe("none");
  });
  it("reports none when upstream has no day for the requested date", async () => {
    mockUpstream(() => ok(week("2026-09-30", lunchItems)));
    const body = await (await get("/lunch/compare.json?date=2026-09-29")).json();
    expect(body.date).toBe("2026-09-29");
    expect(body.halls.map.state).toBe("none");
  });
  it("400 on bad meal without calling upstream", async () => {
    mockUpstream(() => { throw new Error("should not fetch"); });
    const res = await get("/brunch/compare.json?date=2026-09-29");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });
  it("400 on bad date without calling upstream", async () => {
    mockUpstream(() => { throw new Error("should not fetch"); });
    expect((await get("/lunch/compare.json?date=2026-02-30")).status).toBe(400);
    expect((await get("/lunch/compare.json?date=../../x")).status).toBe(400);
  });
  it("405 for non-GET", async () => {
    const res = await worker.fetch(new Request("https://menu.internal/lunch/compare.json", { method: "POST" }), {});
    expect(res.status).toBe(405);
  });
  it("502 when either hall's upstream fails (no partial menu)", async () => {
    mockUpstream((u) => (u.includes("hicks-cafe") ? new Response("boom secret", { status: 500 }) : ok(week("2026-09-29", lunchItems))));
    const res = await get("/lunch/compare.json?date=2026-09-29");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "upstream_unavailable" });
    expect(text).not.toContain("secret");
  });
  it("502 when upstream shape changes", async () => {
    mockUpstream(() => ok({ nope: true }));
    expect((await get("/lunch/compare.json?date=2026-09-29")).status).toBe(502);
  });
});

describe("existing plain-text endpoint", () => {
  it("still renders the same text", async () => {
    mockUpstream(() => ok(week("2026-09-29", lunchItems)));
    const res = await get("/lunch/map?date=2026-09-29");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      "MAP Cafe — Lunch\nTuesday, September 29, 2026\n\nMAP INSPIRED EATS\n- Brown Sugar BBQ Pork\n- Brown Rice\n- Mystery Stew"
    );
  });
  it("still 400s on a missing option", async () => {
    mockUpstream(() => ok(week("2026-09-29", lunchItems)));
    expect((await get("/lunch")).status).toBe(400);
  });
});
