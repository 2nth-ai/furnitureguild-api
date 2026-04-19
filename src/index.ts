/**
 * Furniture Guild API gateway.
 *
 * Sits between the public Cloudflare Pages storefront and a private
 * ERPNext instance on GCE in africa-south1. The ERPNext instance is
 * reached via a Cloudflare Tunnel (erp-fg.2nth.ai). This Worker never
 * exposes the API key to the browser.
 *
 * Routes:
 *   GET  /health              — cheap liveness + ERPNext ping
 *   POST /quotes              — create a Quotation from a storefront request
 *   GET  /quotes              — list recent Quotations (for workshop dashboard)
 *   GET  /quotes/:name        — fetch one Quotation
 *
 * All routes enforce a CORS allow-list configured via ALLOWED_ORIGINS.
 */

export interface Env {
  // Public (set in wrangler.toml [vars])
  ALLOWED_ORIGINS: string;

  // Secrets (set via `wrangler secret put`)
  ERP_URL: string;         // e.g. https://erp-fg.2nth.ai
  ERP_API_KEY: string;     // storefront-api user api_key
  ERP_API_SECRET: string;  // storefront-api user api_secret
  ERP_COMPANY: string;     // e.g. "Furniture Guild"
}

interface QuoteRequest {
  customer: {
    name: string;
    email: string;
    city?: string;
    notes?: string;
  };
  items: Array<{ code: string; qty: number }>;
}

// ────────────────────────────────── handler ──────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") ?? "";
    const cors = buildCors(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return await handleHealth(env, cors);
      }

      if (url.pathname === "/quotes" && request.method === "POST") {
        return await handleCreateQuote(request, env, cors);
      }

      if (url.pathname === "/quotes" && request.method === "GET") {
        return await handleListQuotes(env, cors);
      }

      const quoteMatch = url.pathname.match(/^\/quotes\/([^/]+)$/);
      if (quoteMatch && request.method === "GET") {
        return await handleGetQuote(quoteMatch[1], env, cors);
      }

      return json({ error: "not_found" }, 404, cors);
    } catch (err) {
      console.error("handler error", err);
      return json(
        { error: "internal_error", message: (err as Error).message },
        500,
        cors
      );
    }
  },
} satisfies ExportedHandler<Env>;

// ────────────────────────────────── CORS ──────────────────────────────────

function buildCors(origin: string, env: Env): Record<string, string> {
  const allow = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).includes(origin);
  return {
    "Access-Control-Allow-Origin": allow ? origin : "null",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

// ────────────────────────────────── helpers ──────────────────────────────────

function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

async function erp(
  env: Env,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set(
    "Authorization",
    `token ${env.ERP_API_KEY}:${env.ERP_API_SECRET}`
  );
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${env.ERP_URL}${path}`, { ...init, headers });
}

// ────────────────────────────────── routes ──────────────────────────────────

async function handleHealth(env: Env, cors: Record<string, string>): Promise<Response> {
  const r = await erp(env, "/api/method/frappe.auth.get_logged_user");
  if (!r.ok) {
    return json(
      { ok: false, erp_status: r.status },
      502,
      cors
    );
  }
  const body = (await r.json()) as { message: string };
  return json({ ok: true, erp_user: body.message, company: env.ERP_COMPANY }, 200, cors);
}

async function handleCreateQuote(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  const body = (await request.json()) as QuoteRequest;

  // ── Validate input ──
  if (!body?.customer?.name || !body?.customer?.email) {
    return json({ error: "customer_name_and_email_required" }, 400, cors);
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return json({ error: "items_required" }, 400, cors);
  }
  for (const it of body.items) {
    if (!it.code || !Number.isFinite(it.qty) || it.qty <= 0) {
      return json({ error: "invalid_item", item: it }, 400, cors);
    }
  }

  // ── Upsert Customer ──
  const customerName = await upsertCustomer(env, body.customer);

  // ── Create Quotation ──
  const payload = {
    doctype: "Quotation",
    quotation_to: "Customer",
    party_name: customerName,
    company: env.ERP_COMPANY,
    currency: "ZAR",
    selling_price_list: "Standard Selling",
    terms:
      body.customer.notes ||
      `Delivery to ${body.customer.city ?? "South Africa"}. Valid 14 days.`,
    items: body.items.map((it) => ({
      item_code: it.code,
      qty: it.qty,
    })),
  };

  const r = await erp(env, "/api/resource/Quotation", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const text = await r.text();
    console.error("ERPNext Quotation create failed", r.status, text.slice(0, 300));
    return json({ error: "erp_create_failed", status: r.status, detail: text.slice(0, 400) }, 502, cors);
  }

  const created = (await r.json()) as { data: { name: string; grand_total: number } };
  return json(
    {
      quote_number: created.data.name,
      grand_total: created.data.grand_total,
      customer: customerName,
    },
    201,
    cors
  );
}

async function upsertCustomer(
  env: Env,
  c: QuoteRequest["customer"]
): Promise<string> {
  // Look up by exact name first
  const qs = new URLSearchParams({
    filters: JSON.stringify([["customer_name", "=", c.name]]),
    fields: JSON.stringify(["name"]),
    limit_page_length: "1",
  });
  const lookup = await erp(env, `/api/resource/Customer?${qs}`);
  if (lookup.ok) {
    const j = (await lookup.json()) as { data: Array<{ name: string }> };
    if (j.data.length > 0) return j.data[0].name;
  }

  // Create new
  const created = await erp(env, "/api/resource/Customer", {
    method: "POST",
    body: JSON.stringify({
      customer_name: c.name,
      customer_group: "Commercial",
      territory: "South Africa",
      customer_type: "Individual",
      email_id: c.email,
    }),
  });

  if (!created.ok) {
    const text = await created.text();
    throw new Error(`Customer upsert failed: ${created.status} ${text.slice(0, 200)}`);
  }

  const j = (await created.json()) as { data: { name: string } };
  return j.data.name;
}

async function handleListQuotes(
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  const qs = new URLSearchParams({
    fields: JSON.stringify([
      "name",
      "customer_name",
      "transaction_date",
      "grand_total",
      "status",
      "docstatus",
    ]),
    order_by: "creation desc",
    limit_page_length: "20",
  });
  const r = await erp(env, `/api/resource/Quotation?${qs}`);
  if (!r.ok) {
    return json({ error: "erp_list_failed", status: r.status }, 502, cors);
  }
  const j = (await r.json()) as { data: unknown[] };
  return json({ quotes: j.data }, 200, cors);
}

async function handleGetQuote(
  name: string,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  const r = await erp(
    env,
    `/api/resource/Quotation/${encodeURIComponent(name)}`
  );
  if (!r.ok) {
    return json({ error: "not_found_or_forbidden", status: r.status }, r.status, cors);
  }
  const body = (await r.json()) as { data: unknown };
  return json(body.data, 200, cors);
}
