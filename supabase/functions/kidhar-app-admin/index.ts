// Kidhar - app-admin tool backend (not any company's admin - the Kidhar
// operator). PIN checked here server-side, never shipped to the client;
// a correct PIN issues a short-lived opaque session token (stf_app_admin_tokens),
// which every other action re-verifies before touching anything. Mirrors
// SEATBOOK's kh-admin-auth pattern used elsewhere in this portfolio.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_ADMIN_PIN = Deno.env.get("KIDHAR_APP_ADMIN_PIN")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function tokenValid(db: ReturnType<typeof createClient>, token: string | undefined) {
  if (!token) return false;
  const { data } = await db
    .from("stf_app_admin_tokens")
    .select("token")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return !!data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { action?: string; pin?: string; token?: string; company_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { action, pin, token, company_id } = body;
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  if (action === "login") {
    if (pin !== APP_ADMIN_PIN) return json({ error: "Wrong PIN" }, 401);
    const newToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    const { error } = await db.from("stf_app_admin_tokens").insert({ token: newToken, expires_at: expiresAt });
    if (error) return json({ error: error.message }, 500);
    return json({ token: newToken });
  }

  if (action === "verify") {
    return json({ valid: await tokenValid(db, token) });
  }

  if (!(await tokenValid(db, token))) {
    return json({ error: "Not logged in" }, 401);
  }

  if (action === "list_pending") {
    const { data, error } = await db.rpc("stf_find_pending_company_approvals");
    if (error) return json({ error: error.message }, 400);
    return json({ companies: data ?? [] });
  }

  if (action === "approve") {
    if (!company_id) return json({ error: "company_id required" }, 400);
    const { error } = await db.rpc("stf_app_admin_approve_company", { p_company_id: company_id });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
});
