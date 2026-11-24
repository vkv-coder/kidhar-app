// Kidhar - PIN-based staff login (for staff with no email, e.g. peons).
//
// Staying inside real Supabase Auth rather than a parallel session
// system: each PIN staff member still has a genuine (synthetic-email)
// auth.users row. Login mints a real session via the Admin API's
// magic-link token, exchanged client-side with verifyOtp - so auth.uid()
// and every existing RLS policy keep working completely unchanged.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { action?: string; admin_token?: string; name?: string; pin?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { action, admin_token, name, pin } = body;
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  if (action === "create_staff") {
    if (!admin_token) return json({ error: "Not logged in" }, 401);
    if (!name || !name.trim()) return json({ error: "Staff name is required." }, 400);
    if (!pin || pin.trim().length < 6) return json({ error: "PIN must be at least 6 characters." }, 400);

    // Verifies admin_token is a real, currently-valid Supabase session -
    // never trust a client-supplied user id directly.
    const { data: adminUserRes, error: adminErr } = await db.auth.getUser(admin_token);
    if (adminErr || !adminUserRes?.user) return json({ error: "Session expired. Please log in again." }, 401);

    const syntheticEmail = `staff-${crypto.randomUUID()}@kidhar-staff.internal`;
    const randomPassword = crypto.randomUUID() + crypto.randomUUID();
    const { data: created, error: createErr } = await db.auth.admin.createUser({
      email: syntheticEmail,
      password: randomPassword,
      email_confirm: true,
    });
    if (createErr || !created?.user) return json({ error: createErr?.message || "Could not create staff account." }, 500);

    const { error: profileErr } = await db.rpc("stf_admin_create_pin_staff", {
      p_admin_profile_id: adminUserRes.user.id,
      p_new_user_id: created.user.id,
      p_name: name.trim(),
      p_pin: pin.trim(),
    });
    if (profileErr) {
      await db.auth.admin.deleteUser(created.user.id); // roll back the orphaned auth user
      const msg = profileErr.message.includes("duplicate") || profileErr.message.includes("unique")
        ? "That PIN is already in use - try a different one."
        : profileErr.message;
      return json({ error: msg }, 400);
    }

    return json({ ok: true });
  }

  if (action === "login") {
    if (!pin || !pin.trim()) return json({ error: "Enter your PIN." }, 400);

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const { data: attemptCount } = await db.rpc("stf_record_pin_attempt", { p_ip: ip });
    if (typeof attemptCount === "number" && attemptCount > 10) {
      return json({ error: "Too many attempts. Please wait a few minutes and try again." }, 429);
    }

    const { data: staffId } = await db.rpc("stf_find_staff_by_pin", { p_pin: pin.trim() });
    if (!staffId) return json({ error: "Incorrect PIN." }, 401);

    const { data: userRes, error: userErr } = await db.auth.admin.getUserById(staffId);
    if (userErr || !userRes?.user?.email) return json({ error: "Account error. Contact your admin." }, 500);

    const { data: linkData, error: linkErr } = await db.auth.admin.generateLink({
      type: "magiclink",
      email: userRes.user.email,
    });
    if (linkErr || !linkData?.properties?.hashed_token) {
      return json({ error: linkErr?.message || "Could not start session." }, 500);
    }

    return json({ email: userRes.user.email, token_hash: linkData.properties.hashed_token });
  }

  return json({ error: "Unknown action" }, 400);
});
