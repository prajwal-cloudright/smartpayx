# SmartPayX theme extension

## Layout
- `src/widget/main.jsx` — tiny loader (entry `widget.js`): interception, resume detection, lazy `import()` of the app
- `src/widget/app.jsx` + screens — the checkout app (auto-split chunk, loads on demand)
- `src/thankyou/` — order confirmation app block (entry `thankyou.js`)
- `src/shared/` — API client, design tokens, UI primitives, shadow-mount helper
- `liquid/` — copy into `extensions/smartpayx/blocks/`

## Build
    npm install
    npm run build        # emits into ../extensions/smartpayx/assets (flat, hashed chunks)

## Wiring into the Shopify extension
1. `shopify app generate extension` → Theme app extension → name `smartpayx` (once).
2. Copy `liquid/smartpayx-widget.liquid` and `liquid/smartpayx-thankyou.liquid` into `extensions/smartpayx/blocks/`.
3. `npm run build` here, then `shopify app dev` at the app root.
4. In the theme editor: App embeds → enable "SmartPayX Checkout".
5. Create a page with handle `spx-thank-you`, add the "SmartPayX Thank You" block to its template.

## Chunk strategy (deliberate)
Entries are stable names (`widget.js`, `thankyou.js`) referenced by liquid.
Shared/lazy code is emitted as hashed `spx-*-[hash].js` chunks FLAT in assets —
the browser's ES-module loader resolves them relative to the entry's CDN URL,
so liquid never references a hash. If chunk 404s ever appear after deploys
(stale entry + purged chunk), the fallback plan is disabling splitting:
`manualChunks: undefined` + duplicate the shared code into both entries.

## Dev harness
`npm run dev` serves a plain Vite page — add an `index.html` mounting the app
with a mocked API module to iterate on screens without the Shopify loop.
