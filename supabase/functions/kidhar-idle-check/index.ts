// Kidhar - periodic idle/shift check. Triggered by a GitHub Actions cron
// roughly every 15 minutes. Has no end-user auth context of its own, so
// it's protected by a shared secret header instead.
//
// Two independent notification channels per overdue row: Telegram to the
// company's admin (if connected), and a Web Push buzz straight to the
// staff member's own phone (if subscribed). Either, both, or neither may
// be available for a given row - each is attempted independently.

import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN = Deno.env.get('KIDHAR_TELEGRAM_BOT_TOKEN')!;
const CRON_SECRET = Deno.env.get('KIDHAR_CRON_SECRET')!;
const VAPID_PUBLIC_KEY = Deno.env.get('KIDHAR_VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('KIDHAR_VAPID_PRIVATE_KEY')!;
// The Kidhar app operator's own chat (not any company's admin) - set once
// by messaging the bot and taking the chat id it reports, then
// `supabase secrets set KIDHAR_APP_ADMIN_CHAT_ID=...`. New-company
// approval pings go here; if unset, that loop below is just skipped.
const APP_ADMIN_CHAT_ID = Deno.env.get('KIDHAR_APP_ADMIN_CHAT_ID');

webpush.setVapidDetails('mailto:info.anyapps@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

interface OverdueRow {
  alert_kind: 'shift' | 'rolling';
  window_id: string | null;
  staff_id: string;
  staff_name: string;
  admin_chat_id: string | null;
  push_endpoint: string | null;
  push_p256dh: string | null;
  push_auth: string | null;
  checkpoint: 'entry' | 'exit' | 'rolling';
  window_start: string | null;
  window_end: string | null;
}

async function callRpc(name: string, body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${name} failed: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sendTelegramMessage(chatId: string, text: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return res.ok;
}

// Returns true if sent, false if failed-but-ignorable, or throws
// 'EXPIRED' if the subscription is dead and should be cleared.
async function sendPush(row: OverdueRow, title: string, body: string): Promise<boolean> {
  const subscription = {
    endpoint: row.push_endpoint!,
    keys: { p256dh: row.push_p256dh!, auth: row.push_auth! },
  };
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body }));
    return true;
  } catch (e) {
    const statusCode = (e as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      await callRpc('stf_clear_push_subscription', { p_staff_id: row.staff_id });
    }
    return false;
  }
}

function hhmm(t: string | null) {
  return t ? t.slice(0, 5) : '';
}

function buildAdminMessage(row: OverdueRow): string {
  if (row.alert_kind === 'rolling') {
    return `⚠️ ${row.staff_name} hasn't checked in for a while (past their allowed gap). Please follow up.`;
  }
  const start = hhmm(row.window_start);
  const end = hhmm(row.window_end);
  return row.checkpoint === 'entry'
    ? `⚠️ ${row.staff_name} hasn't checked in yet for their ${start}-${end} shift today.`
    : `⚠️ ${row.staff_name} hasn't completed their check-out for the ${start}-${end} shift today.`;
}

function buildStaffMessage(row: OverdueRow): { title: string; body: string } {
  if (row.alert_kind === 'rolling') {
    return { title: '📍 Kidhar', body: "Time to check in - tap Share My Location." };
  }
  return row.checkpoint === 'entry'
    ? { title: '📍 Kidhar', body: `Please check in for your ${hhmm(row.window_start)}-${hhmm(row.window_end)} shift.` }
    : { title: '📍 Kidhar', body: `Please check out for your ${hhmm(row.window_start)}-${hhmm(row.window_end)} shift.` };
}

Deno.serve(async (req) => {
  if (req.headers.get('X-Cron-Secret') !== CRON_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  const overdue: OverdueRow[] = (await callRpc('stf_find_overdue_alerts', {})) || [];
  let sent = 0;

  for (const row of overdue) {
    let delivered = false;

    if (row.admin_chat_id) {
      if (await sendTelegramMessage(row.admin_chat_id, buildAdminMessage(row))) delivered = true;
    }
    if (row.push_endpoint && row.push_p256dh && row.push_auth) {
      const { title, body } = buildStaffMessage(row);
      if (await sendPush(row, title, body)) delivered = true;
    }

    if (delivered) {
      await callRpc('stf_record_alert_sent', {
        p_alert_kind: row.alert_kind,
        p_window_id: row.window_id,
        p_staff_id: row.staff_id,
        p_checkpoint: row.checkpoint,
      });
      sent++;
    }
  }

  // ── New-company approvals: ping the app operator (not a company admin -
  // no company exists yet for this one) once per pending company. ──
  let companyApprovalsSent = 0;
  if (APP_ADMIN_CHAT_ID) {
    const pendingCompanies: { company_id: string; company_name: string; admin_name: string; admin_email: string }[] =
      (await callRpc('stf_find_pending_company_approvals', {})) || [];
    for (const c of pendingCompanies) {
      const ok = await sendTelegramMessage(
        APP_ADMIN_CHAT_ID,
        `🏢 New Kidhar company awaiting your approval:\n"${c.company_name}" - admin ${c.admin_name} (${c.admin_email})\n\nApprove via: supabase db query --linked (select stf_app_admin_approve_company('${c.company_id}'))`
      );
      if (ok) {
        await callRpc('stf_mark_company_approval_notified', { p_company_id: c.company_id });
        companyApprovalsSent++;
      }
    }
  }

  // ── New staff approvals: ping that staff member's own company admin,
  // if the admin has Telegram connected. ──
  let staffApprovalsSent = 0;
  const pendingStaff: { staff_id: string; staff_name: string; admin_chat_id: string }[] =
    (await callRpc('stf_find_pending_staff_approvals', {})) || [];
  for (const s of pendingStaff) {
    const ok = await sendTelegramMessage(
      s.admin_chat_id,
      `🧑‍💼 ${s.staff_name} has requested to join your company on Kidhar. Approve them from the Staff section of the app.`
    );
    if (ok) {
      await callRpc('stf_mark_staff_approval_notified', { p_staff_id: s.staff_id });
      staffApprovalsSent++;
    }
  }

  // ── One-time tasks past their deadline+grace with no check-in logged.
  // Independent of the recurring shift/rolling alerts above - a staff
  // member can have both an ongoing schedule and occasional one-off
  // tasks. ──
  let tasksSent = 0;
  const overdueTasks: { task_id: string; staff_name: string; label: string | null; due_at: string; admin_chat_id: string }[] =
    (await callRpc('stf_find_overdue_tasks', {})) || [];
  for (const t of overdueTasks) {
    const dueStr = new Date(t.due_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
    const what = t.label ? `"${t.label}"` : 'their assigned task';
    const ok = await sendTelegramMessage(
      t.admin_chat_id,
      `⚠️ ${t.staff_name} has not reached/checked in for ${what} (due ${dueStr}).`
    );
    if (ok) {
      await callRpc('stf_mark_task_alerted', { p_task_id: t.task_id });
      tasksSent++;
    }
  }

  return new Response(JSON.stringify({ checked: overdue.length, sent, companyApprovalsSent, staffApprovalsSent, tasksSent }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
