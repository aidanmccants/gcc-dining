/* MCP server (Streamable HTTP, stateless, no auth) for AI agents.
 *
 * Every request is a single JSON-RPC message POSTed to the endpoint; replies are plain
 * application/json (no SSE stream, no sessions). Data loading is injected so this stays
 * testable without network access.
 */

import { validMeal, validDate } from "./menu-json.js";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "gcc-dining", title: "Grove City College Dining", version: "1.0.0" };
const MEALS = ["breakfast", "lunch", "dinner"];
const HALLS = ["map", "hicks"];

const INSTRUCTIONS =
  "Menus for the Grove City College dining halls: MAP Cafe (map) and Hicks Cafe (hicks). " +
  "Dates are YYYY-MM-DD and default to today in US Eastern time. Items may carry Nutrislice " +
  "dietary/allergen icons; a missing icons field means unknown, an empty list means none listed.";

const TOOLS = [
  {
    name: "get_menu",
    title: "Get dining hall menu",
    description:
      "Get the Grove City College dining menu for a date, grouped by hall and station. " +
      "Omit meal to get breakfast, lunch, and dinner; omit hall to get both MAP Cafe and Hicks Cafe. " +
      'A hall with state "none" has no menu posted for that meal.',
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today (America/New_York)." },
        meal: { type: "string", enum: MEALS, description: "Defaults to all three meals." },
        hall: { type: "string", enum: [...HALLS, "both"], description: "Defaults to both." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Protocol-Version, Mcp-Session-Id",
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  });
const rpcResult = (id, result) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message, status = 200) =>
  json({ jsonrpc: "2.0", id, error: { code, message } }, status);
const toolError = (text) => ({ content: [{ type: "text", text }], isError: true });

// loadMeal(meal, ymd) -> { date, meal, halls: { map, hicks } }, throws on upstream failure.
async function getMenu(args, { loadMeal, today }) {
  const { date = today(), meal, hall = "both" } = args || {};
  if (!validDate(date)) return toolError("Invalid date, use YYYY-MM-DD.");
  if (meal !== undefined && !validMeal(meal)) return toolError("meal must be breakfast, lunch, or dinner.");
  if (![...HALLS, "both"].includes(hall)) return toolError("hall must be map, hicks, or both.");

  const meals = meal ? [meal] : MEALS;
  let results;
  try {
    results = await Promise.all(meals.map((m) => loadMeal(m, date)));
  } catch {
    return toolError("Couldn't load the menu from Nutrislice right now. Try again later.");
  }
  const out = { date, meals: {} };
  for (const r of results) {
    out.meals[r.meal] = hall === "both" ? r.halls : { [hall]: r.halls[hall] };
  }
  return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
}

export async function handleMcp(req, deps) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response("MCP endpoint: POST JSON-RPC here (no SSE stream).", {
      status: 405,
      headers: { Allow: "POST, OPTIONS", ...CORS_HEADERS },
    });
  }

  let msg;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
    return rpcError(null, -32600, "Invalid Request", 400);
  }

  // Notifications and client responses carry no id and get no reply.
  if (msg.id === undefined || msg.id === null) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }

  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call":
      if (params.name !== "get_menu") return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      return rpcResult(id, await getMenu(params.arguments, deps));
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
