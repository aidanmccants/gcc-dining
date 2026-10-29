/* MCP server (Streamable HTTP, stateless, no auth) for AI agents.
 *
 * Every request is a single JSON-RPC message POSTed to the endpoint; replies are plain
 * application/json (no SSE stream, no sessions). Data loading is injected so this stays
 * testable without network access.
 */

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "gcc-dining", title: "Grove City College Dining", version: "1.1.0" };
const MAX_TOOL_BYTES = 300 * 1024; // keep results small enough for an agent's context

const INSTRUCTIONS =
  "Menus, hours, and open/closed status for Grove City College dining locations, from Nutrislice. " +
  "The main halls are MAP Cafe (map-cafe, alias map) and Hicks Cafe (hicks-cafe, alias hicks); " +
  "call get_locations for every location, its hours, and which meals it serves. " +
  "Dates are YYYY-MM-DD and default to today in US Eastern time. Items may carry dietary/allergen " +
  "icons; a missing icons field means unknown, an empty list means none listed.";

const TOOLS = [
  {
    name: "get_menu",
    title: "Get dining menus",
    description:
      "Menus by day, location, meal, and station. Defaults: today, MAP Cafe and Hicks Cafe, every meal they serve. " +
      'Each meal has state "menu" (stations listed), "closed" (a posted closure notice, in notice), or ' +
      '"none" (nothing posted, which may mean closed or not published yet). ' +
      "Set details=true for nutrition, ingredients, serving size, and category per item.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "First day, YYYY-MM-DD. Defaults to today (America/New_York)." },
        days: { type: "integer", minimum: 1, maximum: 7, description: "Number of consecutive days. Default 1." },
        location: {
          type: "string",
          description:
            'Location slug, comma-separated slugs, or "all". Aliases: map, hicks. Default: map-cafe,hicks-cafe.',
        },
        meal: {
          type: "string",
          description: "Menu type slug, e.g. breakfast, lunch, dinner, late-night-bite. Default: all.",
        },
        details: { type: "boolean", description: "Include nutrition, ingredients, serving size. Default false." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "get_locations",
    title: "Get dining locations and hours",
    description:
      "Every Grove City College dining location: slug, name, current open/closed status, weekly hours, " +
      "hours per meal, building, and season dates. Hours are local (US Eastern), HH:MM, null = closed that day. " +
      "Status and hours follow the regular weekly schedule and do not reflect break closures; " +
      'check get_menu for "closed" notices.',
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "nutrislice_raw",
    title: "Raw Nutrislice API request",
    description:
      "Escape hatch: GET any path under https://gcc.api.nutrislice.com/menu/api/ and return the raw JSON. " +
      'Examples: "schools/", "weeks/school/map-cafe/menu-type/lunch/2026/10/28/". ' +
      "Week responses are large (~700 KB) and usually exceed the size limit; prefer get_menu with details=true.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to /menu/api/, with trailing slash." } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
const UPSTREAM_DOWN = "Couldn't reach Nutrislice right now. Try again later.";
const TOO_LARGE = "Result too large; narrow location, meal, or days, or turn off details.";

function toolResult(data) {
  const text = JSON.stringify(data);
  if (new TextEncoder().encode(text).length > MAX_TOOL_BYTES) return toolError(TOO_LARGE);
  return { content: [{ type: "text", text }], structuredContent: data };
}

// deps: menuData(args) -> { data } | { error, status }; locationsData() throws on failure;
// rawFetch(path) -> { status, body }.
async function callTool(name, args, deps) {
  if (name === "get_menu") {
    const { data, error, status } = await deps.menuData(args || {});
    if (error) return toolError(status === 502 ? UPSTREAM_DOWN : error);
    return toolResult(data);
  }
  if (name === "get_locations") {
    try {
      return toolResult(await deps.locationsData());
    } catch {
      return toolError(UPSTREAM_DOWN);
    }
  }
  // nutrislice_raw
  const { status, body } = await deps.rawFetch((args || {}).path);
  if (status !== 200) return toolError(`Nutrislice returned HTTP ${status}: ${body.slice(0, 300)}`);
  if (new TextEncoder().encode(body).length > MAX_TOOL_BYTES)
    return toolError("Raw response too large for this tool; use get_menu or the /raw/ HTTP endpoint instead.");
  return { content: [{ type: "text", text: body }] };
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
      if (!TOOLS.some((t) => t.name === params.name)) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      return rpcResult(id, await callTool(params.name, params.arguments, deps));
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
