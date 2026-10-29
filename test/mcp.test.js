import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import { fakeNutrislice, section, holiday, food } from "./fake-nutrislice.js";

afterEach(() => vi.unstubAllGlobals());

let nextId = 1;
const rpc = (method, params, host = "gccdining-mcp.mccants.link", path = "/") =>
  worker.fetch(
    new Request(`https://${host}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
    {}
  );
const call = (args) => rpc("tools/call", { name: "get_menu", arguments: args });

describe("MCP handshake", () => {
  it("initializes and echoes a supported protocol version", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const body = await res.json();
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe("gcc-dining");
  });
  it("falls back to its latest version for unknown ones", async () => {
    const body = await (await rpc("initialize", { protocolVersion: "1999-01-01" })).json();
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });
  it("accepts notifications with 202 and no body", async () => {
    const res = await worker.fetch(
      new Request("https://gccdining-mcp.mccants.link/", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
      {}
    );
    expect(res.status).toBe(202);
  });
  it("is also reachable at /mcp on other hosts", async () => {
    const body = await (await rpc("ping", {}, "gcc-dining.example.workers.dev", "/mcp")).json();
    expect(body.result).toEqual({});
  });
  it("rejects GET, unknown methods, and bad JSON", async () => {
    const get = await worker.fetch(new Request("https://gccdining-mcp.mccants.link/"), {});
    expect(get.status).toBe(405);
    expect((await (await rpc("resources/list", {})).json()).error.code).toBe(-32601);
    const bad = await worker.fetch(
      new Request("https://gccdining-mcp.mccants.link/", { method: "POST", body: "{nope" }),
      {}
    );
    expect(bad.status).toBe(400);
  });
});

describe("MCP tools", () => {
  const tool = (name, args) => rpc("tools/call", { name, arguments: args });

  it("lists all three tools", async () => {
    const body = await (await rpc("tools/list", {})).json();
    expect(body.result.tools.map((t) => t.name)).toEqual(["get_menu", "get_locations", "nutrislice_raw"]);
  });
  it("get_menu matches /menu.json, including closures", async () => {
    fakeNutrislice({
      "map-cafe|lunch|2026-10-14": [section("GRILL"), food("Burger")],
      "hicks-cafe|lunch|2026-10-14": [holiday("Closed for Fall Break")],
    });
    const { result } = await (await call({ date: "2026-10-14", meal: "lunch" })).json();
    expect(result.isError).toBeUndefined();
    const locs = result.structuredContent.days[0].locations;
    expect(locs["map-cafe"].meals.lunch.stations[0].items[0].name).toBe("Burger");
    expect(locs["hicks-cafe"].meals.lunch).toEqual({ state: "closed", notice: "Closed for Fall Break" });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    const rest = await (await worker.fetch(new Request("https://x/menu.json?date=2026-10-14&meal=lunch"), {})).json();
    expect(rest).toEqual(result.structuredContent);
  });
  it("get_locations returns hours and status", async () => {
    fakeNutrislice();
    const { result } = await (await tool("get_locations", {})).json();
    expect(result.structuredContent.locations[1]).toMatchObject({ slug: "hicks-cafe", status: "open" });
  });
  it("nutrislice_raw returns raw JSON text and rejects bad paths", async () => {
    fakeNutrislice();
    const ok = (await (await tool("nutrislice_raw", { path: "schools/" })).json()).result;
    expect(JSON.parse(ok.content[0].text)[0].slug).toBe("map-cafe");
    const bad = (await (await tool("nutrislice_raw", { path: "../x" })).json()).result;
    expect(bad.isError).toBe(true);
  });
  it("reports bad arguments and upstream failures as tool errors", async () => {
    fakeNutrislice();
    expect((await (await call({ date: "2026-02-30" })).json()).result.isError).toBe(true);
    expect((await (await call({ meal: "brunch" })).json()).result.isError).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const down = (await (await call({ date: "2026-09-29" })).json()).result;
    expect(down.isError).toBe(true);
    expect(down.content[0].text).toContain("Nutrislice");
  });
  it("rejects unknown tools", async () => {
    const body = await (await rpc("tools/call", { name: "nope", arguments: {} })).json();
    expect(body.error.code).toBe(-32602);
  });
});
