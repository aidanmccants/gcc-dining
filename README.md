# gcc-dining

Menus, hours, and open/closed status for every Grove City College dining location, served from a single Cloudflare Worker.

The Worker is a thin, cached layer over Grove City's public Nutrislice API. It has no database. Dates default to today in US Eastern time.

This API powers apps such as [Plate](https://plate.mccants.link).

## Why use this instead of Nutrislice directly?

- **Browsers can call it.** Nutrislice sends no CORS headers, so a web app can't read it directly. Every JSON endpoint here sends `Access-Control-Allow-Origin: *`.
- **It's small.** One Nutrislice week is about 700 KB. A full day of MAP and Hicks menus from this API is about 20 KB.
- **It's cached.** Upstream responses are cached for 10 minutes, so apps don't hammer the college's menu service.
- **The quirks are handled once.** That covers stations mixed into a flat list, closure rows, whole-week responses, and the trailing slash.

Anything this API doesn't reshape is still available through the [raw passthrough](#get-raw).

## Endpoints

Every endpoint works on any host the Worker serves, for example `https://gccdining-mcp.mccants.link/locations.json`.

| Endpoint | What it returns | For |
| --- | --- | --- |
| [`GET /locations.json`](#get-locationsjson) | Every location: open/closed now, weekly hours, hours per meal | Apps |
| [`GET /menu.json`](#get-menujson) | Menus for any locations, meals, and up to 7 days, with closures and optional nutrition | Apps |
| [`GET /{meal}/compare.json`](#get-mealcomparejson) | MAP vs Hicks for one meal, with allergen icons | Plate (original endpoint) |
| [`GET /raw/...`](#get-raw) | Any Nutrislice API response, unchanged | Anything else |
| [MCP server](#mcp-server-for-ai-agents) | The same data as tools | AI agents |
| [`GET /{meal}/{hall}`](#plain-text-endpoints) | Plain-text menus | curl, quick checks |
| [Telegram bot](#telegram-bot) | Menus in chat | People |

Bad input gets a 400 with `{ "error": "..." }`. If Nutrislice is down, you get a 502 rather than a partial menu.

### `GET /locations.json`

This returns every location Nutrislice lists, including the main halls, the Garage Café, both markets, and Chick-fil-A.

```json
{
  "locations": [
    {
      "slug": "map-cafe",
      "name": "MAP Café",
      "status": "closed",
      "season": { "start": "2025-08-27" },
      "hours": {
        "mon": { "open": "07:00", "close": "20:00" },
        "fri": { "open": "07:00", "close": "14:30" },
        "sat": null,
        "sun": null
      },
      "meals": [
        { "slug": "breakfast", "name": "Breakfast", "hours": { "mon": { "open": "07:00", "close": "10:59" } } },
        { "slug": "lunch", "name": "Lunch", "hours": { "fri": { "open": "11:00", "close": "14:30" } } },
        { "slug": "dinner", "name": "Dinner", "hours": { "fri": null } }
      ]
    }
  ]
}
```

The example is trimmed. Real responses list all seven days.

| Field | Meaning |
| --- | --- |
| `status` | `"open"` or `"closed"` right now, according to Nutrislice |
| `hours` | The regular weekly schedule in local time (US Eastern). `null` means closed that day. 24-hour days are `{ "open": "00:00", "close": "24:00", "all_day": true }`. |
| `meals[]` | Each menu type the location serves. `slug` is the `meal` value for `/menu.json`. `hours` gives that meal's serving times when Nutrislice lists them, always within the location's `hours` (see below). |
| `season` | `start` and `end` dates for the operating season, when set |
| `building`, `phone`, `address`, `geolocation` | Included only when Nutrislice has a value, e.g. `"building": "Hicks Hall"` |

**Location hours win.** Nutrislice's per-meal hours are sometimes stale. For example, it lists Hicks dinner until 9pm on Saturdays, but Hicks closes at 7pm. So each meal's hours are trimmed to fit inside the location's hours for that day. A meal is `null` on days the location is closed or the two don't overlap. The raw passthrough still returns Nutrislice's untrimmed values.

> **Breaks aren't in the hours.** `hours` and `status` follow the regular weekly schedule only. During fall break, for example, MAP's hours still say it's open. Check `/menu.json` for `"state": "closed"`.

### `GET /menu.json`

| Query parameter | Values | Default |
| --- | --- | --- |
| `date` | First day, `YYYY-MM-DD` | today |
| `days` | `1`–`7` consecutive days | `1` |
| `location` | A slug, comma-separated slugs, or `all`. Aliases: `map`, `hicks`. | `map-cafe,hicks-cafe` |
| `meal` | A menu-type slug (`breakfast`, `lunch`, `dinner`, `late-night-bite`, ...) | every meal each location serves |
| `details` | `1` adds nutrition, ingredients, serving size, and category to each item | off |

```
GET /menu.json?date=2026-10-15&meal=lunch
```

```json
{
  "start": "2026-10-15",
  "end": "2026-10-15",
  "days": [
    {
      "date": "2026-10-15",
      "weekday": "Thursday",
      "locations": {
        "map-cafe": {
          "name": "MAP Café",
          "meals": { "lunch": { "state": "closed", "notice": "Closed for Fall Break" } }
        },
        "hicks-cafe": {
          "name": "Hicks Café",
          "meals": { "lunch": { "state": "none" } }
        }
      }
    }
  ]
}
```

Each meal has a `state`:

| `state` | Meaning |
| --- | --- |
| `"menu"` | `stations[]` holds `{ name, items[] }`. A `notice` may also be present. |
| `"closed"` | The location posted a closure. The text is in `notice`, e.g. `"Closed for Fall Break"`. |
| `"none"` | Nothing is posted. The location may be closed without a notice (Hicks doesn't post them), or the menu isn't published yet. |

Each item is `{ name, icons? }`. With `details=1` it also gets whichever of these Nutrislice provides:

```json
{
  "name": "Italian Seasoned Chicken",
  "icons": [{ "name": "Gluten Friendly", "slug": "gluten-friendly" }],
  "id": 2066478,
  "category": "entree",
  "serving_size": { "amount": "0.5", "unit": "oz piece" },
  "nutrition": { "calories": 348, "g_protein": 63, "g_fat": 11, "g_carbs": 1, "mg_sodium": 744 },
  "ingredients": "Chicken Breast, Extra Virgin Olive Oil, Black Pepper, ..."
}
```

The `nutrition` object above is trimmed. Real items carry every non-null field Nutrislice has, such as `g_saturated_fat`, `g_sugar`, `g_fiber` and `mg_calcium`. Possible extras are `description`, `subtext`, `highlight`, `price`, and `image_url`. Fields that are empty upstream are left out.

`icons` follows the same rule everywhere. If the field is missing, the tags are unknown. An empty list means Nutrislice listed none.

**Limits:**
- A request may make at most 40 upstream fetches. That's one per location, meal, and Sunday-to-Saturday week.
- Responses are capped at 1 MB.

For scale, 7 days of MAP and Hicks with `details=1` is about 560 KB.

### `GET /{meal}/compare.json`

```
GET /{breakfast|lunch|dinner}/compare.json?date=YYYY-MM-DD
```

This returns `{ date, meal, halls: { map, hicks } }`. Each hall is `{ state: "menu" | "none", stations, notice? }`.

It's kept as-is for Plate. A closure shows up as `state: "none"` plus a `notice`, never as a new state value. New code should use `/menu.json`.

### `GET /raw/...`

```
GET /raw/{path}  ->  https://gcc.api.nutrislice.com/menu/api/{path}
```

The response comes back unchanged, but cached for 10 minutes and with CORS headers. Keep Nutrislice's trailing slash. Examples:

```
GET /raw/schools/
GET /raw/weeks/school/map-cafe/menu-type/lunch/2026/10/28/
```

See [Using the Nutrislice API directly](#using-the-nutrislice-api-directly) for what's in these responses.

## MCP server (for AI agents)

This is a public MCP server with no authentication. It uses Streamable HTTP and is stateless, returning JSON responses with no sessions or SSE stream.

**URL:** `https://gccdining-mcp.mccants.link`. It also answers at `/mcp` on any host the Worker serves.

Connect from Claude Code:

```sh
claude mcp add --transport http gcc-dining https://gccdining-mcp.mccants.link
```

Other clients that support remote MCP servers take the same URL.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_menu` | `date`, `days`, `location`, `meal`, `details` (all optional) | The same JSON as `/menu.json` |
| `get_locations` | none | The same JSON as `/locations.json` |
| `nutrislice_raw` | `path`, e.g. `"schools/"` | Raw Nutrislice JSON, like `/raw/` |

Results come back twice: as `structuredContent`, and as JSON text in `content`. Results over 300 KB return an error asking the agent to narrow the request. Raw week responses (about 700 KB) are always too big for `nutrislice_raw`, so agents should use `get_menu` with `details: true` instead.

```sh
curl -X POST https://gccdining-mcp.mccants.link \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_menu","arguments":{"meal":"dinner"}}}'
```

## Plain-text endpoints

```
GET /{breakfast|lunch|dinner}/{map|hicks|compare}?date=YYYY-MM-DD
```

Example: `GET /dinner/compare` prints both halls' dinner menus side by side. If a hall posted a closure, its notice is printed in place of the menu.

## Telegram bot

Commands work in a DM or a group chat. Each one takes a meal and an option:

```
/breakfast map      /lunch hicks      /dinner compare
```

`map` means MAP Cafe, `hicks` means Hicks Cafe, and `compare` shows both. The option is required. `/help` lists the commands.

### Setup

1. Create a bot with @BotFather and copy its token.
2. Add the token as a Worker secret named `BOT_TOKEN` (`npx wrangler secret put BOT_TOKEN`).
3. Deploy, then register the webhook once:
   ```sh
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/tg"
   ```

## Using the Nutrislice API directly

Everything above comes from Grove City's public Nutrislice API, which needs no key or login. It's unofficial and undocumented, so its shape could change without notice.

You can call it directly from a server or native app. Browsers block it, because it sends no CORS headers. Use [`/raw/`](#get-raw) from a web page instead.

Base URL: `https://gcc.api.nutrislice.com/menu/api`

### Locations, hours, and status

```
GET /schools/
```

This returns one object per location. As of October 2026:

| Location slug | Name | Menu type slugs |
| --- | --- | --- |
| `map-cafe` | MAP Café | `breakfast`, `lunch`, `dinner` |
| `hicks-cafe` | Hicks Café | `breakfast`, `lunch`, `dinner` |
| `the-garage-cafe` | The Garage Café | `the-garage-cafe-brunch`, `late-night-bite` |
| `map-market` | MAP Market | `retail-menu` |
| `hicks-market` | Hicks Market | `retail-menu` |
| `chick-fil-a` | Chick-fil-A | `retail-menu` |

Useful fields on each location:

| Field | Contents |
| --- | --- |
| `slug`, `name` | Identifier and display name |
| `operating_status` | `"open"` or `"closed"` right now |
| `{day}_enabled`, `{day}_start`, `{day}_end`, `{day}_is_24_hours` | Weekly hours, with `day` being `mon` to `sun` and times as `HH:MM:SS` local |
| `operating_days_by_menu_type[]` | The same per-day fields for each meal, keyed by `menu_type_id` |
| `active_menu_types[]` | `id`, `slug`, `name`, and URL templates for each menu |
| `operating_start_date`, `operating_end_date` | Season dates, or `null` |
| `wayfinding_note`, `phone_number`, `address`, `geolocation` | Often empty |

### A week of menus

```
GET /weeks/school/{location}/menu-type/{menu-type}/{YYYY}/{MM}/{DD}/
```

```sh
curl https://gcc.api.nutrislice.com/menu/api/weeks/school/map-cafe/menu-type/lunch/2026/10/28/
```

This returns the whole Sunday–Saturday week that contains the date, not just that day. The trailing slash is required. Pick your day out of `days[]` by its `date`:

```js
const week = await (await fetch(url)).json();
const day = week.days.find((d) => d.date === "2026-10-28");
const items = day ? day.menu_items : [];
```

### Reading `menu_items`

`menu_items` is one flat, ordered list. Station headers and closure notices are mixed in with the foods:

- **Closure notice:** has `is_holiday` set to `true`, with the message in `text`, e.g. `"Closed for Fall Break"`. It usually appears alone on the day. Not every location posts these.
- **Station header:** has `is_section_title` or `is_station_header` set to `true`, and the station name in `text`.
- **Food:** a non-null `food` object. It belongs to the most recent header above it.
- Skip any other rows, such as blank lines and spacers.

`stationEntries()` and `holidayNotice()` in [menu-json.js](menu-json.js) do this walk.

An empty `menu_items` doesn't tell you whether the location is closed or the menu just isn't published yet.

Useful fields on `food`:

| Field | Contents |
| --- | --- |
| `name`, `description` | Display name and blurb |
| `icons.food_icons[]` | Dietary and allergen tags: `name`, `slug` (e.g. `gluten-friendly`), and icon image URLs |
| `rounded_nutrition_info` | `calories`, `g_protein`, `g_carbs`, `g_fat`, `mg_sodium`, `g_sugar`, `g_fiber`, and more. A value can be `null`. |
| `serving_size_info` | `serving_size_amount`, `serving_size_unit` |
| `ingredients` | Ingredient text, when provided |
| `food_category` | e.g. `entree` |

### Being a good citizen

This is the college's production menu service. Cache responses: the Worker caches for 10 minutes, and menus rarely change within a day. Since one request covers a whole week, fetch once per week rather than once per day. Send a descriptive `User-Agent`.

## Development

```sh
npm install
npm test          # vitest
npm run deploy    # wrangler deploy
```

`worker.js` imports other modules, so it must be bundled with wrangler. Pasting it into the dashboard editor won't work.

| File | Purpose |
| --- | --- |
| `worker.js` | Routing, Nutrislice fetching, the JSON endpoints, raw passthrough, Telegram bot, and text endpoints |
| `mcp.js` | MCP server (JSON-RPC handling and the three tools) |
| `normalize.js` | Pure helpers that shape `/locations.json` and `/menu.json` |
| `menu-json.js` | Pure helpers for `compare.json`, the station walk, and closure notices |
| `wrangler.jsonc` | Worker config, including the `gccdining-mcp.mccants.link` custom domain |
| `test/` | Vitest suites, with a fake Nutrislice in `fake-nutrislice.js` |

The custom domain only attaches if `mccants.link` is in the same Cloudflare account as the Worker. The `workers.dev` URL stays enabled because the Telegram webhook points there.
