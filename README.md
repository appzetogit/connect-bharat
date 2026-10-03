# Connect Bharat

Taxi platform plus the Connect Bharat marketing site, in one repo.

```
Backend/                    Express + MongoDB + Socket.IO API (also serves the CMS settings)
frontend/                   React 19 + Vite + Tailwind 4 single-page app
  src/modules/landing/      the Connect Bharat marketing site
  src/modules/{user,driver,admin,shared}/   the taxi product
```

## Running it

Mongo first — anything reachable works, this is just the quickest:

```bash
docker run -d --name connect-bharat-mongo -p 27017:27017 mongo:7
```

Backend:

```bash
cp Backend/.env.example Backend/.env
```

```bash
npm install --prefix Backend && npm run dev --prefix Backend
```

Only `MONGODB_URI` and `JWT_SECRET` are required to boot. The rest degrade
gracefully: Redis falls back to in-memory rate limiting, and unconfigured
integrations (Cloudinary, Firebase, Razorpay, PhonePe, SMTP) stay off.

Keep `PORT=5000` — the frontend defaults its API base to
`http://localhost:5000/api/v1`, overridable with `VITE_API_BASE_URL`.

After any deploy that changes a schema index, build the indexes:

```bash
node scripts/ensureIndexes.js
```

`config/database.js` connects with `autoIndex: false` in production, so Mongoose
never creates indexes there. Nothing else in the repo did it either, which left
every declared index missing — dispatch failed with "unable to find index for
$geoNear query". The script uses `createIndexes()` (adds what is missing) rather
than `syncIndexes()` (drops anything not in the schema).

Frontend:

```bash
cp frontend/.env.production.example frontend/.env.production
```

```bash
npm install --prefix frontend && npm run dev --prefix frontend
```

Vite compiles every `VITE_*` value into the browser bundle, so only public values
belong in that file. Web push needs all seven `VITE_FIREBASE_*` vars set at
**build** time — miss any one and `registerBrowserFcmToken()` returns
`firebase-web-config-missing` and push silently does nothing. `VITE_FIREBASE_VAPID_KEY`
is the *public* half of the Web Push key pair; the private half is server-side only
and the client SDK never needs it.

`VITE_GOOGLE_MAPS_API_KEY` drives the admin panel maps. Beyond setting it, the
Google Cloud project needs **billing enabled** and the **Maps JavaScript API**
turned on — without billing the map still renders but greyed out, stamped "For
development purposes only", with a "This page can't load Google Maps correctly"
dialog. Restrict the key by HTTP referrer, since it ships in the bundle.

It runs standalone too. Without the backend the CMS-driven values (app name,
logo, favicon) fall back to their defaults.

## Branding

Lives in the CMS, under `taxiadminbusinesssettings.general`. `app_name` drives
the document title.

`logo` and `favicon` there are resolved against the **backend** origin, because
the CMS serves uploaded assets — pointing them at a frontend-bundled path such as
`/connect-bharat-logo.jpg` produces a 404. Leave them empty to use the static favicon in
`frontend/index.html`, or upload through the CMS.

## Routes

| Path | Owner |
|---|---|
| `/`, `/about`, `/services`, `/corporate`, `/partner`, `/drive-with-us`, `/advertise`, `/contact` | landing |
| `/faq`, `/support`, `/blog`, `/careers`, `/links`, `/terms`, `/privacy` | taxi static pages |
| `/login`, `/signup`, `/ride/*`, `/cab/*`, `/bus/*`, `/parcel/*`, `/rental/*` | taxi user app |
| `/taxi/driver/*`, `/taxi/owner/*`, `/admin/*` | driver, owner and admin apps |

Landing paths live in `frontend/src/modules/landing/landingTabs.js` — the router
and the navbar highlighting both read from it, so they cannot drift apart.

## Two things to know before editing the landing

**Its CSS is scoped.** Everything in `landing.css` and in each page's `<style>`
block is nested under `.connect-bharat-landing`, applied by `LandingShell`. Both codebases
use names like `container`, `btn` and `section-title`, and the taxi side is
Tailwind — unscoped landing rules would restyle the whole product. Keyframes are
the exception: they are invalid inside a nested rule and their names are global
either way, so they sit at the top level with a `zc-` prefix.

The taxi app enforces its font with `* { font-family: ... !important }`, so the
landing's font rules carry `!important` too. Higher specificity settles it
between them, and all of it stays inside `.connect-bharat-landing`.

**Reveals must never strand content.** Elements are visible by default and only
hidden once `useReveal` confirms it can animate them, and a backstop writes the
visible end state directly if the observer never fires. Keep that property — a
throttled tab freezes the animation clock, and anything depending on a tween or
transition completing will otherwise stay invisible.

## Client-supplied values still outstanding

`frontend/src/modules/landing/siteConfig.js` — official email, WhatsApp number
and toll-free number.

Photos: `frontend/public/drivers/` and `frontend/public/founders/` (see the
README in each). `frontend/public/vehicles/` currently holds Creative Commons
photos that require attribution (`ATTRIBUTION.md`) until they are replaced with
Connect Bharat's own fleet shots.
