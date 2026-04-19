# furnitureguild-api

Cloudflare Worker API gateway for the Furniture Guild storefront. Proxies public HTTP requests into a **private ERPNext** instance running on Compute Engine in `africa-south1`, reached via a Cloudflare Tunnel.

## The request path

```
Customer browser (furnitureguild.pages.dev)
    → POST /quotes
        → this Worker (validates input, CORS-gates origin)
            → Authorization: token <api_key>:<api_secret>
            → https://erp-fg.2nth.ai (Cloudflare Tunnel)
                → ERPNext backend on Cloud Run / GCE in africa-south1
                → Creates Customer (upsert) + Quotation
                ← returns quote doc
            ← returns { quote_number, grand_total }
```

## Endpoints

| Method | Path | Purpose |
|--------|------|--------|
| GET    | `/health` | Liveness + auth check (ping ERPNext as the API user) |
| POST   | `/quotes` | Create a Quotation from storefront submission. Upserts Customer. |
| GET    | `/quotes` | List recent 20 Quotations (for workshop dashboard) |
| GET    | `/quotes/:name` | Fetch one Quotation |

### POST `/quotes` request shape

```json
{
  "customer": {
    "name": "Craig Leppan",
    "email": "craig@2nth.ai",
    "city": "Cape Town",
    "notes": "Delivery after 15 May preferred"
  },
  "items": [
    { "code": "FG-TBL-OAK6", "qty": 2 },
    { "code": "FG-CHR-OAK",  "qty": 8 }
  ]
}
```

### Response

```json
{
  "quote_number": "SAL-QTN-2026-00001",
  "grand_total": 38400,
  "customer": "Craig Leppan"
}
```

## Secrets + vars

Set once via `wrangler secret put`:

| Name | Type | Example |
|------|------|---------|
| `ERP_URL` | secret | `https://erp-fg.2nth.ai` |
| `ERP_API_KEY` | secret | `71bec4c8734862e` |
| `ERP_API_SECRET` | secret | `1fe53bc4bf23c3d` |
| `ERP_COMPANY` | secret | `Furniture Guild` |
| `ALLOWED_ORIGINS` | var (wrangler.toml) | `https://furnitureguild.pages.dev,http://localhost:8788` |

The API user is a dedicated `storefront-api@furnitureguild.local` ERPNext user with `Sales User` + `Sales Manager` roles. Never the Administrator.

## Development

```bash
npm install

# Set secrets (first time only)
wrangler secret put ERP_URL
wrangler secret put ERP_API_KEY
wrangler secret put ERP_API_SECRET
wrangler secret put ERP_COMPANY

# Local dev (uses .dev.vars if you've set them locally)
npm run dev

# Deploy
npm run deploy

# Live tail logs
npm run tail
```

## Local dev against a local ERPNext

If you're running ERPNext on `localhost:8080` (via `gcloud start-iap-tunnel`), create `.dev.vars`:

```
ERP_URL=http://localhost:8080
ERP_API_KEY=...
ERP_API_SECRET=...
ERP_COMPANY=Furniture Guild
```

`.dev.vars` is gitignored. The Worker at `localhost:8787` will hit your local ERPNext directly — no Cloudflare Tunnel needed for dev.

## Deployed at

- `https://furnitureguild-api.<your-cf-subdomain>.workers.dev` — Workers default subdomain
- Configure a custom domain (e.g. `api.furnitureguild.pages.dev` or `fg-api.2nth.ai`) via the Cloudflare dashboard if you need one

## What this Worker is **not**

- Not a full auth layer — the API key here is shared, not per-customer. For customer logins use Cloudflare Access on a separate route.
- Not a webhook receiver — payment confirmations would live in a separate Worker.
- Not a caching proxy — `/quotes` list is read-through. Add KV or D1 if you need offline/cache for the workshop dashboard.

## License

MIT.
