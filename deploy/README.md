# Deployment

A record of how Connect Bharat runs in production, so the box can be rebuilt
to the same state. Nothing here is applied automatically.

Live at **https://bharat.buytogetherindia.com** on a shared VPS
(`145.223.21.188`) that also hosts many unrelated apps. Everything below is
namespaced so a deploy here cannot touch them.

| What | Where |
|---|---|
| Backend code | `/var/www/connect-bharat/Backend` |
| Backend env | `/var/www/connect-bharat/Backend/.env` (root-only) |
| Process | PM2 app `bharat-api`, port 5150 (`/var/www/connect-bharat/bharat-ecosystem.config.cjs`) |
| Web build | `/var/www/connect-bharat-web` |
| Database | MongoDB `connect_bharat` on the box's main mongod (127.0.0.1:27017) |
| nginx | `nginx/bharat.buytogetherindia.com.conf` → `/etc/nginx/sites-available/`, symlinked into `sites-enabled` |
| TLS | Let's Encrypt via certbot (`--nginx`), auto-renewed |
| Uploads | on disk under the backend's `uploads/`, served at `/uploads/` |

Redis is deliberately off (`REDIS_ENABLED=false`): the box's Redis is shared,
and this app's keys are not prefixed. That limits the app to one instance - see
`Backend/ecosystem.config.cjs`.

## Backend deploys

From the repo root on a dev machine:

```
git archive --format=tar HEAD Backend | ssh root@145.223.21.188 'tar -x -C /var/www/connect-bharat'
```

Then on the server:

```
cd /var/www/connect-bharat/Backend && npm ci --omit=dev
node scripts/ensureIndexes.js
pm2 restart bharat-api --update-env
```

`git archive` never includes `.env` or `uploads/`, so neither is overwritten.
`ensureIndexes.js` matters after any schema index change: `config/database.js`
connects with `autoIndex: false` in production, so Mongoose never creates
indexes there.

## Frontend deploys

Build with the production origins baked in, then replace the web root:

```
cd frontend
VITE_API_BASE_URL=https://bharat.buytogetherindia.com/api/v1 \
VITE_BACKEND_ORIGIN=https://bharat.buytogetherindia.com \
VITE_SOCKET_URL=https://bharat.buytogetherindia.com \
npm run build
rsync -a --delete dist/ root@145.223.21.188:/var/www/connect-bharat-web/
```

`--delete` is deliberate: it clears the previous build's hashed asset files so
they do not accumulate.

### Why `index.html` must not be cached

`index.html` names the hashed chunks, and each deploy replaces them and removes
the previous set. A browser holding a stale `index.html` requests chunk
filenames that no longer exist, gets 404s, and renders a blank page. The nginx
config therefore splits the two:

- `location = /index.html` → `no-cache, must-revalidate`
- `location /assets/` → `public, immutable`, one year

Keep that split if the config is ever rewritten.

## Changing nginx

The box serves dozens of other sites from the same nginx. Always:

```
nginx -t && systemctl reload nginx
```

never a bare reload or restart - a syntax error would take every site down.
