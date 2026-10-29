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
 * JSON endpoint (read by the Plate app, includes allergen icons):
 *   GET /lunch/compare.json?date=2026-10-01
 *
 * MCP server for AI agents (Streamable HTTP, no auth, tool: get_menu):
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

import { stationEntries, buildCompareJson, validMeal, validDate, MAX_BYTES } from "./menu-json.js";
import { handleMcp } from "./mcp.js";

const API = "https://gcc.api.nutrislice.com/menu/api";
const LOCATIONS = { map: "map-cafe", hicks: "hicks-cafe" };
const NAMES = { map: "MAP Cafe", hicks: "Hicks Cafe" };
const MEALS = ["breakfast", "lunch", "dinner"];
const TARGETS = ["map", "hicks", "compare"];
const API_CHANGED_MSG =
  "Couldn't load the menu — Nutrislice's API may have changed. The worker needs an update.";
const JSON_CACHE_SECONDS = 600;
const MCP_HOST = "gccdining-mcp.mccants.link";

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ttl > 0 lets Cloudflare cache the upstream response (used only by the JSON endpoint).
async function dayItems(slug, meal, ymd, ttl = 0) {
  const [y, m, d] = ymd.split("-");
  const url = `${API}/weeks/school/${slug}/menu-type/${meal}/${y}/${m}/${d}/`;
  const init = { headers: { "User-Agent": "gcc-menus-worker/1.0" } };
  if (ttl > 0) init.cf = { cacheEverything: true, cacheTtl: ttl };
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`menu API HTTP ${res.status}`);
  const week = await res.json();
  if (!week || !Array.isArray(week.days)) throw new Error("menu API shape changed");
  const day = week.days.find((x) => x.date === ymd);
  return day ? day.menu_items || [] : null;
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

// Fetch one cafe's menu for one meal. Returns { groups } or { error }.
async function cafeMenu(meal, loc, ymd) {
  try {
    const items = await dayItems(LOCATIONS[loc], meal, ymd);
    return { groups: items === null ? [] : stationGroups(items) };
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
  if (!menu.groups.length) return `${head}\n\n(no menu posted)`;
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
    headers: { "Content-Type": "application/json", ...extra },
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
    return new Response(body, { headers: { "Content-Type": "application/json" } });
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
      return handleMcp(req, { loadMeal: mealJson, today: todayET });
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
