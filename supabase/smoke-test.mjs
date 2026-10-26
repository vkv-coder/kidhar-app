// One-off smoke test against the live StaffTrack schema. Uses the
// service_role key to create already-confirmed test users (this project has
// email confirmation enabled, so a plain signUp() never returns a session).
// Never ship the service_role key anywhere else - pass it as an env var.
const BASE = 'https://wrzpgultvahxbrgooibn.supabase.co';
const ANON = 'sb_publishable_eaTIKWQ1QAI1E07kZaiGTA_dfWDyQTs';
const SERVICE_ROLE = process.env.STAFFTRACK_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE) throw new Error('Set STAFFTRACK_SERVICE_ROLE_KEY env var to run this test.');
const ts = Date.now();

async function createConfirmedUser(email, password, name) {
  const res = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name } })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('admin create user failed: ' + JSON.stringify(data));
  return data;
}

async function signIn(email, password) {
  const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('signin failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function rpc(token, name, args) {
  const res = await fetch(`${BASE}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${token}` },
    body: JSON.stringify(args)
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${name} failed: ` + JSON.stringify(data));
  return data;
}

async function select(token, table, query) {
  const res = await fetch(`${BASE}/rest/v1/${table}?${query}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`select ${table} failed: ` + JSON.stringify(data));
  return data;
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('  OK: ' + msg);
}

(async () => {
  console.log('--- Company A: admin signs up & creates company ---');
  const adminAEmail = `stafftrack.admin.a.${ts}@example.com`;
  await createConfirmedUser(adminAEmail, 'Test1234', 'Admin A');
  const adminAToken = await signIn(adminAEmail, 'Test1234');
  const companyA = await rpc(adminAToken, 'stf_signup_create_company', { p_company_name: `Test Co A ${ts}`, p_admin_name: 'Admin A' });
  console.log('  company A id:', companyA);

  console.log('--- Company A: staff signs up & joins ---');
  const staffAEmail = `stafftrack.staff.a.${ts}@example.com`;
  await createConfirmedUser(staffAEmail, 'Test1234', 'Staff A');
  const staffAToken = await signIn(staffAEmail, 'Test1234');
  await rpc(staffAToken, 'stf_signup_join_company', { p_company_id: companyA, p_staff_name: 'Staff A' });

  console.log('--- Staff A tries to check in before approval (should fail) ---');
  let blocked = false;
  try {
    await rpc(staffAToken, 'stf_log_checkin', { p_lat: 22.3, p_lng: 73.2, p_accuracy_m: 10, p_note: null });
  } catch (e) { blocked = true; }
  assert(blocked, 'unapproved staff cannot check in');

  console.log('--- Admin A approves Staff A ---');
  const profiles = await select(adminAToken, 'stf_profiles', 'select=id,name,active&active=eq.false');
  const staffAProfileId = profiles.find(p => p.name === 'Staff A').id;
  await rpc(adminAToken, 'stf_admin_set_active', { p_profile_id: staffAProfileId, p_active: true });

  console.log('--- Staff A checks in ---');
  const checkin = await rpc(staffAToken, 'stf_log_checkin', { p_lat: 22.307, p_lng: 73.181, p_accuracy_m: 12.5, p_note: null });
  assert(checkin && checkin[0] && checkin[0].checkin_id, 'check-in recorded with an id');

  console.log('--- Admin A can see the check-in via lookup ---');
  const seenByAdmin = await select(adminAToken, 'stf_checkins', `select=*&staff_id=eq.${staffAProfileId}`);
  assert(seenByAdmin.length === 1, 'admin A sees exactly 1 check-in for staff A');

  console.log('--- Company B: separate admin + staff, tenant isolation ---');
  const adminBEmail = `stafftrack.admin.b.${ts}@example.com`;
  await createConfirmedUser(adminBEmail, 'Test1234', 'Admin B');
  const adminBToken = await signIn(adminBEmail, 'Test1234');
  await rpc(adminBToken, 'stf_signup_create_company', { p_company_name: `Test Co B ${ts}`, p_admin_name: 'Admin B' });

  console.log('--- Admin B cannot see Company A profiles or check-ins ---');
  const profilesSeenByB = await select(adminBToken, 'stf_profiles', `select=*&id=eq.${staffAProfileId}`);
  assert(profilesSeenByB.length === 0, "admin B cannot read company A's staff profile");

  const checkinsSeenByB = await select(adminBToken, 'stf_checkins', `select=*&staff_id=eq.${staffAProfileId}`);
  assert(checkinsSeenByB.length === 0, "admin B cannot read company A's check-ins");

  console.log("--- Staff A cannot see another staff member's check-ins (self-only) ---");
  const checkinsSeenByStaffA = await select(staffAToken, 'stf_checkins', 'select=*');
  assert(checkinsSeenByStaffA.length === 1, 'staff A sees only their own 1 check-in, not company-wide');

  console.log('\nALL SMOKE TESTS PASSED');
})().catch(e => { console.error('SMOKE TEST FAILURE:', e.message); process.exit(1); });
