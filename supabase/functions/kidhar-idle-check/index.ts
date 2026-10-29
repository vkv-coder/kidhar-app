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

  return new Response(JSON.stringify({ checked: overdue.length, sent }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
