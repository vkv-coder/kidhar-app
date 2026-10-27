// Kidhar - Telegram webhook receiver.
// Links an admin's Telegram chat by matching the one-time code they send
// (via a t.me deep link, or typed manually) to their
// stf_profiles.telegram_link_code. Verified via Telegram's secret_token
// header so only Telegram's own servers can reach this.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN = Deno.env.get('KIDHAR_TELEGRAM_BOT_TOKEN')!;
const WEBHOOK_SECRET = Deno.env.get('KIDHAR_TELEGRAM_WEBHOOK_SECRET')!;

async function sendTelegramMessage(chatId: number | string, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function linkTelegram(code: string, chatId: number): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/stf_link_telegram`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_code: code, p_chat_id: String(chatId) }),
  });
  return (await res.json()) === true;
}

Deno.serve(async (req) => {
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  const update = await req.json().catch(() => null);
  const message = update?.message;
  if (!message?.chat?.id || typeof message.text !== 'string') {
    return new Response('ok');
  }

  const chatId = message.chat.id;
  const text = message.text.trim();
  const code = text.startsWith('/start') ? text.replace('/start', '').trim() : text;

  if (!code) {
    await sendTelegramMessage(chatId, '👋 Welcome! Go to Kidhar’s Settings page, tap "Connect Telegram", and tap the link it gives you to finish connecting.');
    return new Response('ok');
  }

  const matched = await linkTelegram(code, chatId);
  await sendTelegramMessage(
    chatId,
    matched
      ? '✅ Connected! You will now get Kidhar alerts here.'
      : '❌ That code wasn’t recognized or was already used. Go back to Kidhar’s Settings page and tap "Connect Telegram" for a fresh code.'
  );
  return new Response('ok');
});
