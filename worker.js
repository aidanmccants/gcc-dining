/* Cloudflare Worker: Grove City dining rundown.
 *
 * Telegram commands (DM or group chat):
 *   /breakfast map      /breakfast hicks      /breakfast compare
 *   /lunch map          /lunch hicks          /lunch compare
 *   /dinner map         /dinner hicks         /dinner compare
 *   (an option is required; without one the bot replies with an error)
 *
 * Plain-text endpoints (curl / testing):
 *   GET /dinner/compare          -> both, side by side
 *   GET /lunch/map               -> MAP lunch
 *   GET /breakfast/hicks?date=2026-10-01
 *
 * JSON endpoints (read by the Plate app; all send CORS headers):
 *   GET /lunch/compare.json?date=2026-10-01      MAP vs Hicks, allergen icons
 *   GET /locations.json                          every location: hours, open/closed, meals
 *   GET /menu.json?location=all&days=7&details=1 any location/meal/days, closures, nutrition
 *   GET /raw/schools/                            cached passthrough to the Nutrislice API
 *
 * MCP server for AI agents (Streamable HTTP, no auth; tools: get_menu, get_locations, nutrislice_raw):
 *   https://gccdining-mcp.mccants.link   (also POST /mcp on any host)
 *
 * Setup:
 *   1. Talk to @BotFather, create a bot, copy the token.
 *   2. Worker dashboard -> Settings -> Variables -> add secret BOT_TOKEN.
 *   3. Deploy, then register the webhook once:
 *      curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/tg"
 *   4. Add the bot to a DM or group chat and send e.g. /dinner compare
 *      (optional: @BotFather -> /setcommands to register the command list)
 *
 * Deploy: npx wrangler deploy   (worker.js imports ./menu-json.js, so it must be bundled;
 * pasting worker.js alone into the dashboard editor will not work)
 */

import { stationEntries, holidayNotice, buildCompareJson, validMeal, validDate, MAX_BYTES } from "./menu-json.js";
import { locationJson, dayJson } from "./normalize.js";
import { handleMcp, CORS_HEADERS } from "./mcp.js";

const API = "https://gcc.api.nutrislice.com/menu/api";
const LOCATIONS = { map: "map-cafe", hicks: "hicks-cafe" };
const NAMES = { map: "MAP Cafe", hicks: "Hicks Cafe" };
const MEALS = ["breakfast", "lunch", "dinner"];
const TARGETS = ["map", "hicks", "compare"];
const API_CHANGED_MSG =
  "Couldn't load the menu — Nutrislice's API may have changed. The worker needs an update.";
const JSON_CACHE_SECONDS = 600;
const MCP_HOST = "gccdining-mcp.mccants.link";
const DEFAULT_LOCATIONS = ["map-cafe", "hicks-cafe"];
const MAX_DAYS = 7;
const MAX_UPSTREAM = 40; // stay under Cloudflare's per-request subrequest limit
const MENU_MAX_BYTES = 1024 * 1024;
const RAW_PATH = /^[A-Za-z0-9_\-./]*$/;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ttl > 0 lets Cloudflare cache the upstream response (used by the JSON endpoints and MCP).
function upstream(path, ttl = 0) {
  const init = { headers: { "User-Agent": "gcc-menus-worker/1.0" } };
  if (ttl > 0) init.cf = { cacheEverything: true, cacheTtl: ttl };
  return fetch(`${API}${path}`, init);
}

// The whole Sunday-Saturday week containing ymd.
async function fetchWeek(slug, meal, ymd, ttl = 0) {
  const [y, m, d] = ymd.split("-");
  const res = await upstream(`/weeks/school/${slug}/menu-type/${meal}/${y}/${m}/${d}/`, ttl);
  if (!res.ok) throw new Error(`menu API HTTP ${res.status}`);
  const week = await res.json();
  if (!week || !Array.isArray(week.days)) throw new Error("menu API shape changed");
  return week;
}

async function dayItems(slug, meal, ymd, ttl = 0) {
  const week = await fetchWeek(slug, meal, ymd, ttl);
  const day = week.days.find((x) => x.date === ymd);
  return day ? day.menu_items || [] : null;
}

async function fetchSchools() {
  const res = await upstream("/schools/", JSON_CACHE_SECONDS);
  if (!res.ok) throw new Error(`schools API HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error("schools API shape changed");
  return list;
}

const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const weekday = (ymd) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
// Sunday of ymd's week: one Nutrislice request covers all seven days.
const weekStart = (ymd) => addDays(ymd, -new Date(`${ymd}T00:00:00Z`).getUTCDay());

// GET /locations.json and the get_locations tool. Throws on upstream failure.
async function locationsData() {
  return { locations: (await fetchSchools()).map(locationJson) };
}

// GET /menu.json and the get_menu tool. Returns { data } or { error, status }.
async function menuData(args = {}) {
  const date = args.date || todayET();
  const days = args.days === undefined || args.days === "" ? 1 : Number(args.days);
  const meal = args.meal ? String(args.meal).toLowerCase() : undefined;
  const details = args.details === true || ["1", "true", "yes"].includes(String(args.details).toLowerCase());
  if (!validDate(date)) return { error: "invalid date, use YYYY-MM-DD", status: 400 };
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS)
    return { error: `days must be 1-${MAX_DAYS}`, status: 400 };

  let schools;
  try {
    schools = await fetchSchools();
  } catch {
    return { error: "upstream_unavailable", status: 502 };
  }
  const bySlug = new Map(schools.map((s) => [s.slug, s]));
  const wanted = String(args.location || "").trim().toLowerCase();
  const slugs = !wanted
    ? DEFAULT_LOCATIONS
    : wanted === "all"
      ? schools.map((s) => s.slug)
      : wanted.split(",").map((s) => LOCATIONS[s.trim()] || s.trim()).filter(Boolean);
  const unknown = slugs.filter((s) => !bySlug.has(s));
  if (unknown.length)
    return { error: `unknown location ${unknown.join(", ")}; valid: ${[...bySlug.keys()].join(", ")}`, status: 400 };

  // Every (location, meal) pair to show; meals come from each location's active menu types.
  const pairs = [];
  for (const slug of slugs) {
    for (const t of bySlug.get(slug).active_menu_types || []) {
      if (!meal || t.slug === meal) pairs.push({ slug, meal: t.slug });
    }
  }
  if (meal && !pairs.length) return { error: `no selected location serves "${meal}"`, status: 400 };

  const dates = Array.from({ length: days }, (_, i) => addDays(date, i));
  const starts = [...new Set(dates.map(weekStart))];
  if (pairs.length * starts.length > MAX_UPSTREAM)
    return { error: "request too large; narrow location, meal, or days", status: 400 };

  const weeks = new Map();
  try {
    await Promise.all(
      pairs.flatMap((p) =>
        starts.map(async (ws) => {
          weeks.set(`${p.slug}|${p.meal}|${ws}`, await fetchWeek(p.slug, p.meal, ws, JSON_CACHE_SECONDS));
        })
      )
    );
  } catch {
    return { error: "upstream_unavailable", status: 502 };
  }

  const out = {
    start: dates[0],
    end: dates[dates.length - 1],
    days: dates.map((ymd) => {
      const locations = {};
      for (const p of pairs) {
        const day = weeks.get(`${p.slug}|${p.meal}|${weekStart(ymd)}`).days.find((x) => x.date === ymd);
        const loc = (locations[p.slug] ||= { name: bySlug.get(p.slug).name, meals: {} });
        loc.meals[p.meal] = dayJson(day ? day.menu_items || [] : null, details);
      }
      return { date: ymd, weekday: weekday(ymd), locations };
    }),
  };
  return { data: out };
}

// GET /raw/<path> and the nutrislice_raw tool: <path> is relative to the Nutrislice /menu/api base.
async function rawFetch(path, search = "") {
  const clean = String(path || "").replace(/^\/+/, "");
  if (!RAW_PATH.test(clean) || clean.split("/").includes(".."))
    return { status: 400, body: JSON.stringify({ error: "invalid path" }) };
  try {
    const res = await upstream(`/${clean}${search}`, JSON_CACHE_SECONDS);
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: 502, body: JSON.stringify({ error: "upstream_unavailable" }) };
  }
}

function stationGroups(items) {
  return stationEntries(items).map((g) => ({
    station: g.station,
    names: g.entries.map((e) => e.name),
  }));
}

function prettyDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "UTC",
  });
}

function todayET() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Fetch one cafe's menu for one meal. Returns { groups, notice } or { error }.
async function cafeMenu(meal, loc, ymd) {
  try {
    const items = await dayItems(LOCATIONS[loc], meal, ymd);
    return { groups: items === null ? [] : stationGroups(items), notice: holidayNotice(items) };
  } catch {
    return { error: API_CHANGED_MSG };
  }
}

// One cafe -> one message. html=true for Telegram, false for plain text.
function renderCafe(meal, loc, ymd, menu, html) {
  const title = `${NAMES[loc]} — ${cap(meal)}`;
  const date = prettyDate(ymd);
  const head = html ? `<b>${esc(title)}</b>\n<i>${esc(date)}</i>` : `${title}\n${date}`;
  if (menu.error) return `${head}\n\n${html ? esc(menu.error) : menu.error}`;
  if (!menu.groups.length) {
    if (menu.notice) return `${head}\n\n${html ? esc(menu.notice) : menu.notice}`;
    return `${head}\n\n(no menu posted)`;
  }
  const blocks = menu.groups.map((g) => {
    const label = html ? `<b>${esc(g.station)}</b>` : g.station.toUpperCase();
    const lines = g.names.map((n) => (html ? `• ${esc(n)}` : `- ${n}`));
    return `${label}\n${lines.join("\n")}`;
  });
  return `${head}\n\n${blocks.join("\n\n")}`;
}

// Error reply for a missing or unrecognized option.
function usageError(meal, arg, html) {
  const problem = arg
    ? `"${arg}" isn't a valid option for /${meal}.`
    : `/${meal} needs an option.`;
  const examples = TARGETS.map((t) => `• /${meal} ${t}`).join("\n");
  const note = "map = MAP Cafe, hicks = Hicks Cafe, compare = both";
  const title = arg ? "Invalid option" : "Missing option";
  return html
    ? `<b>${title}</b>\n${esc(problem)}\n\nTry one of these:\n${examples}\n\n<i>${esc(note)}</i>`
    : `${title}\n${problem}\n\nTry one of these:\n${examples}\n\n${note}`;
}

// Returns an array of messages: one per cafe ("compare" gives two).
async function handleCommand(meal, target, ymd, html) {
  if (!MEALS.includes(meal)) return [];
  if (!TARGETS.includes(target)) return [usageError(meal, target, html)];
  const locs = target === "compare" ? ["map", "hicks"] : [target];
  const menus = await Promise.all(locs.map((loc) => cafeMenu(meal, loc, ymd)));
  return locs.map((loc, i) => renderCafe(meal, loc, ymd, menus[i], html));
}

const jsonResponse = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  });

// Both halls for one meal as JSON (shared by compare.json and the MCP server). Throws on upstream failure.
async function mealJson(meal, ymd) {
  const [mapItems, hicksItems] = await Promise.all([
    dayItems(LOCATIONS.map, meal, ymd, JSON_CACHE_SECONDS),
    dayItems(LOCATIONS.hicks, meal, ymd, JSON_CACHE_SECONDS),
  ]);
  return buildCompareJson(meal, ymd, mapItems, hicksItems);
}

// GET /{meal}/compare.json: never returns a partial menu; any upstream problem is a 502.
async function compareJson(meal, ymd) {
  try {
    const body = JSON.stringify(await mealJson(meal, ymd));
    if (new TextEncoder().encode(body).length > MAX_BYTES) throw new Error("response too large");
    return new Response(body, { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  } catch {
    return jsonResponse({ error: "upstream_unavailable" }, 502);
  }
}

async function tgSend(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

const HELP =
  "Grove City dining rundown\n\nCommands:\n/breakfast, /lunch, /dinner\n\nAdd map, hicks, or compare (required).\n\nExamples:\n/dinner compare\n/lunch map\n/breakfast hicks";

// Sent on /start: a friendly intro for first-time users (Telegram HTML).
const WELCOME = [
  "<b>Welcome to the Grove City dining bot!</b>",
  "",
  "I show today's menus for the Grove City College dining halls: MAP Cafe and Hicks Cafe.",
  "",
  "<b>How to use it</b>",
  "Send a meal command followed by an option:",
  "• /breakfast",
  "• /lunch",
  "• /dinner",
  "",
  "<b>Options</b>",
  "• map: MAP Cafe only",
  "• hicks: Hicks Cafe only",
  "• compare: both cafes",
  "",
  "<b>Examples</b>",
  "/dinner compare",
  "/lunch map",
  "/breakfast hicks",
  "",
  "<i>The option is required. Send /help any time for a quick reminder.</i>",
].join("\n");

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // --- MCP server: POST /mcp on any host, or / on the dedicated MCP domain ---
    if (path === "/mcp" || (url.hostname === MCP_HOST && path === "/")) {
      return handleMcp(req, { menuData, locationsData, rawFetch });
    }

    // --- Browser preflight for the JSON endpoints ---
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    // --- Raw Nutrislice passthrough: /raw/schools/ -> {API}/schools/ (keeps trailing slash) ---
    if (req.method === "GET" && url.pathname.startsWith("/raw/")) {
      const { status, body } = await rawFetch(url.pathname.slice("/raw/".length), url.search);
      return new Response(body, { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
    }

    // --- /locations.json: hours, open/closed, meals for every location ---
    if (req.method === "GET" && path === "/locations.json") {
      try {
        return jsonResponse(await locationsData());
      } catch {
        return jsonResponse({ error: "upstream_unavailable" }, 502);
      }
    }

    // --- /menu.json: any locations, meals, and days, with closures and optional nutrition ---
    if (req.method === "GET" && path === "/menu.json") {
      const q = Object.fromEntries(url.searchParams);
      const { data, error, status } = await menuData(q);
      if (error) return jsonResponse({ error }, status);
      const body = JSON.stringify(data);
      if (new TextEncoder().encode(body).length > MENU_MAX_BYTES)
        return jsonResponse({ error: "response too large; narrow location, meal, or days" }, 400);
      return new Response(body, { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
    }

    // --- Telegram webhook ---
    if (req.method === "POST" && (path === "/tg" || path === "/webhook")) {
      if (!env.BOT_TOKEN) return new Response("BOT_TOKEN not set", { status: 500 });
      const update = await req.json().catch(() => ({}));
      const msg = update.message || {};
      if (msg.chat) {
        // "/dinner@MyBot compare" -> ["dinner", "compare"]; works in groups
        const parts = (msg.text || "").trim().split(/\s+/);
        const cmd = parts[0].replace(/@.*$/, "").toLowerCase();
        const arg = (parts[1] || "").toLowerCase();
        if (cmd === "/start") {
          await tgSend(env, msg.chat.id, WELCOME);
        } else if (cmd === "/help") {
          await tgSend(env, msg.chat.id, HELP);
        } else if (MEALS.includes(cmd.slice(1))) {
          const msgs = await handleCommand(cmd.slice(1), arg, todayET(), true);
          for (const text of msgs) await tgSend(env, msg.chat.id, text);
        } else if (cmd.startsWith("/")) {
          await tgSend(env, msg.chat.id, HELP);
        }
      }
      return new Response("ok");
    }

    // --- JSON endpoint: /lunch/compare.json ---
    const jm = path.match(/^\/([^/]+)\/compare\.json$/);
    if (jm) {
      if (req.method !== "GET") {
        return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "GET" });
      }
      const meal = jm[1].toLowerCase();
      const ymd = url.searchParams.get("date") || todayET();
      if (!validMeal(meal)) return jsonResponse({ error: "invalid meal" }, 400);
      if (!validDate(ymd)) return jsonResponse({ error: "invalid date, use YYYY-MM-DD" }, 400);
      return compareJson(meal, ymd);
    }

    // --- Plain-text endpoints: /dinner/compare, /lunch/map, ... ---
    if (req.method === "GET") {
      const m = path.match(/^\/(breakfast|lunch|dinner)(?:\/([^/]+))?$/);
      if (m) {
        const ymd = url.searchParams.get("date") || todayET();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd))
          return new Response("bad date, use YYYY-MM-DD", { status: 400 });
        const msgs = await handleCommand(m[1], (m[2] || "").toLowerCase(), ymd, false);
        const bad = m[2] === undefined || !TARGETS.includes(m[2].toLowerCase());
        return new Response(msgs.join("\n\n----------------------------\n\n"), {
          status: bad ? 400 : 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    }

    return new Response(
      "Grove City dining rundown\n\nGET /{breakfast|lunch|dinner}/{map|hicks|compare}\nGET /dinner/compare?date=YYYY-MM-DD\n\nTelegram: set BOT_TOKEN secret, point webhook at /tg",
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  },
};
