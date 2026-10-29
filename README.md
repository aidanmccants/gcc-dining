# gcc-dining

Menus for the Grove City College dining halls, **MAP Cafe** and **Hicks Cafe**, served from a single Cloudflare Worker.

The Worker pulls live data from Nutrislice on each request. It has no database. Dates default to today in US Eastern time. 

This api is used to power apps such as [Plate](https://plate.mccants.link).

The same menus are available four ways:

| Interface | Where | For |
| --- | --- | --- |
| MCP server | `https://gccdining-mcp.mccants.link` | AI agents |
| JSON endpoint | `GET /{meal}/compare.json` | Apps (e.g. Plate) |
| Plain-text endpoints | `GET /{meal}/{hall}` | curl, quick checks |
| Telegram bot | webhook at `/tg` | Chat |

## MCP server (for AI agents)

This is a public MCP server with no authentication. It uses Streamable HTTP and is stateless, returning JSON responses with no sessions or SSE stream.

**URL:** `https://gccdining-mcp.mccants.link`. It also answers at `/mcp` on any host the Worker serves.

Connect from Claude Code:

```sh
claude mcp add --transport http gcc-dining https://gccdining-mcp.mccants.link
```

Other clients that support remote MCP servers take the same URL.

### Tool: `get_menu`

Every argument is optional.

| Argument | Values | Default |
| --- | --- | --- |
| `date` | `YYYY-MM-DD` | today (America/New_York) |
| `meal` | `breakfast`, `lunch`, `dinner` | all three |
| `hall` | `map`, `hicks`, `both` | `both` |

Example result for `{"meal": "lunch", "hall": "map"}`:

```json
{
  "date": "2026-10-28",
  "meals": {
    "lunch": {
      "map": {
        "state": "menu",
        "stations": [
          { "name": "GRILL", "items": [{ "name": "Burger", "icons": [{ "name": "Gluten", "slug": "gluten" }] }] }
        ]
      }
    }
  }
}
```

The result comes back twice: as `structuredContent`, and as JSON text in `content`.

### Raw request

```sh
curl -X POST https://gccdining-mcp.mccants.link \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_menu","arguments":{"meal":"dinner"}}}'
```

## JSON endpoint

```
GET /{breakfast|lunch|dinner}/compare.json?date=YYYY-MM-DD
```

This returns `{ date, meal, halls: { map, hicks } }`. Bad input gets a 400. If Nutrislice fails, the response is a 502 rather than a partial menu.

## Data notes

These apply to both the MCP server and the JSON endpoint:

- A hall with `"state": "none"` has no menu posted for that meal.
- `icons` holds Nutrislice's dietary and allergen tags. If the field is missing, the tags are unknown. An empty list means Nutrislice listed none.
- Upstream responses are cached for 10 minutes.

## Plain-text endpoints

```
GET /{breakfast|lunch|dinner}/{map|hicks|compare}?date=YYYY-MM-DD
```

Example: `GET /dinner/compare` prints both halls' dinner menus side by side.

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

## Development

```sh
npm install
npm test          # vitest
npm run deploy    # wrangler deploy
```

`worker.js` imports other modules, so it must be bundled with wrangler. Pasting it into the dashboard editor won't work.

| File | Purpose |
| --- | --- |
| `worker.js` | Routing, Nutrislice fetching, the Telegram bot, and the text endpoints |
| `mcp.js` | MCP server (JSON-RPC handling and the `get_menu` tool) |
| `menu-json.js` | Pure helpers that shape menu JSON (unit tested) |
| `wrangler.jsonc` | Worker config, including the `gccdining-mcp.mccants.link` custom domain |
| `test/` | Vitest suites |

The custom domain only attaches if `mccants.link` is in the same Cloudflare account as the Worker. The `workers.dev` URL stays enabled because the Telegram webhook points there.
