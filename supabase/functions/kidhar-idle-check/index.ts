// Kidhar - periodic idle/shift check. Triggered by a GitHub Actions cron
// roughly every 15 minutes. Has no end-user auth context of its own, so
// it's protected by a shared secret header instead.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN = Deno.env.get('KIDHAR_TELEGRAM_BOT_TOKEN')!;
const CRON_SECRET = Deno.env.get('KIDHAR_CRON_SECRET')!;

interface OverdueRow {
  alert_kind: 'shift' | 'rolling';
  window_id: string | null;
  staff_id: string;
  staff_name: string;
  admin_chat_id: string;
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

function hhmm(t: string | null) {
  return t ? t.slice(0, 5) : '';
}

function buildMessage(row: OverdueRow): string {
  if (row.alert_kind === 'rolling') {
    return `⚠️ ${row.staff_name} hasn't checked in for a while (past their allowed gap). Please follow up.`;
  }
  const start = hhmm(row.window_start);
  const end = hhmm(row.window_end);
  return row.checkpoint === 'entry'
    ? `⚠️ ${row.staff_name} hasn't checked in yet for their ${start}-${end} shift today.`
    : `⚠️ ${row.staff_name} hasn't completed their check-out for the ${start}-${end} shift today.`;
}

Deno.serve(async (req) => {
  if (req.headers.get('X-Cron-Secret') !== CRON_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  const overdue: OverdueRow[] = (await callRpc('stf_find_overdue_alerts', {})) || [];
  let sent = 0;

  for (const row of overdue) {
    const ok = await sendTelegramMessage(row.admin_chat_id, buildMessage(row));
    if (ok) {
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
