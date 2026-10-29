import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";

const section = (text) => ({ is_section_title: true, text });
const food = (name) => ({ is_section_title: false, text: "", food: { name } });
const week = (ymd, items) => ({ days: [{ date: ymd, menu_items: items }] });
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

function mockUpstream(fn) {
  vi.stubGlobal("fetch", vi.fn(async (url) => fn(String(url))));
}
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
  it("lists the get_menu tool", async () => {
    const body = await (await rpc("tools/list", {})).json();
    expect(body.result.tools.map((t) => t.name)).toEqual(["get_menu"]);
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

describe("get_menu tool", () => {
  it("returns one meal for one hall", async () => {
    mockUpstream((url) =>
      ok(week("2026-09-29", url.includes("map-cafe") ? [section("GRILL"), food("Burger")] : []))
    );
    const { result } = await (await call({ date: "2026-09-29", meal: "lunch", hall: "map" })).json();
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      date: "2026-09-29",
      meals: { lunch: { map: { state: "menu", stations: [{ name: "GRILL", items: [{ name: "Burger" }] }] } } },
    });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });
  it("returns all meals and both halls by default", async () => {
    mockUpstream(() => ok(week("2026-09-29", [])));
    const { result } = await (await call({ date: "2026-09-29" })).json();
    expect(Object.keys(result.structuredContent.meals)).toEqual(["breakfast", "lunch", "dinner"]);
    expect(Object.keys(result.structuredContent.meals.dinner).sort()).toEqual(["hicks", "map"]);
  });
  it("reports bad arguments and upstream failures as tool errors", async () => {
    expect((await (await call({ date: "2026-02-30" })).json()).result.isError).toBe(true);
    expect((await (await call({ meal: "brunch" })).json()).result.isError).toBe(true);
    mockUpstream(() => new Response("down", { status: 503 }));
    expect((await (await call({ date: "2026-09-29" })).json()).result.isError).toBe(true);
  });
  it("rejects unknown tools", async () => {
    const body = await (await rpc("tools/call", { name: "nope", arguments: {} })).json();
    expect(body.error.code).toBe(-32602);
  });
});
