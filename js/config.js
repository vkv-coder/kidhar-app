// ==========================================
// STAFFTRACK - Supabase Configuration
// ==========================================

const SUPABASE_URL = 'https://wrzpgultvahxbrgooibn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_eaTIKWQ1QAI1E07kZaiGTA_dfWDyQTs';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Auth on this project is shared across many apps on the same Supabase
// instance, so the same bare email can only ever have one password total.
// We silently tag the local part with +kidhar (Gmail and most providers
// deliver mail to foo+anything@gmail.com straight to foo@gmail.com) so each
// app gets its own independent account/password on the same inbox, without
// the user ever having to type or remember a tag themselves.
const TELEGRAM_BOT_USERNAME = 'kidharalertsbot';

const APP_EMAIL_TAG = 'kidhar';
function tagEmail(rawEmail) {
  const email = (rawEmail || '').trim();
  const at = email.indexOf('@');
  if (at === -1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.toLowerCase().endsWith('+' + APP_EMAIL_TAG)) return email;
  return local + '+' + APP_EMAIL_TAG + domain;
}
