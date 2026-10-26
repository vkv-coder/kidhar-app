// ==========================================
// STAFFTRACK - Supabase Configuration
// ==========================================

const SUPABASE_URL = 'https://wrzpgultvahxbrgooibn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_eaTIKWQ1QAI1E07kZaiGTA_dfWDyQTs';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
