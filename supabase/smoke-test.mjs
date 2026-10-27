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

  console.log('--- Admin A sets a 50m zone around the earlier check-in point ---');
  await rpc(adminAToken, 'stf_set_zone', { p_lat: 22.307, p_lng: 73.181, p_radius_m: 50 });

  console.log('--- Staff A checks in ~5m away (should succeed, inside zone) ---');
  const insideCheckin = await rpc(staffAToken, 'stf_log_checkin', { p_lat: 22.30705, p_lng: 73.18101, p_accuracy_m: 8, p_note: null });
  assert(insideCheckin && insideCheckin[0] && insideCheckin[0].checkin_id, 'check-in inside zone succeeds');

  console.log('--- Staff A checks in ~1km away (should be blocked, outside zone) ---');
  let blockedByZone = false;
  try {
    await rpc(staffAToken, 'stf_log_checkin', { p_lat: 22.316, p_lng: 73.181, p_accuracy_m: 8, p_note: null });
  } catch (e) { blockedByZone = /outside the zone/.test(e.message); }
  assert(blockedByZone, 'check-in far outside the zone is blocked with a clear message');

  console.log('--- Admin A sets shift windows for Staff A ---');
  await rpc(adminAToken, 'stf_set_shift_windows', {
    p_staff_id: staffAProfileId,
    p_windows: [{ start_time: '08:00', end_time: '10:00', grace_minutes: 20 }, { start_time: '17:00', end_time: '19:00', grace_minutes: 20 }]
  });
  const windows = await select(adminAToken, 'stf_shift_windows', `select=*&staff_id=eq.${staffAProfileId}&order=start_time`);
  assert(windows.length === 2, 'both shift windows were saved');

  console.log('--- A separate Company B admin cannot read Company A staff shift windows ---');
  const adminBEmailEarly = `stafftrack.admin.b.${ts}@example.com`;
  await createConfirmedUser(adminBEmailEarly, 'Test1234', 'Admin B');
  const adminBTokenEarly = await signIn(adminBEmailEarly, 'Test1234');
  await rpc(adminBTokenEarly, 'stf_signup_create_company', { p_company_name: `Test Co B ${ts}`, p_admin_name: 'Admin B' });
  const windowsSeenByB = await select(adminBTokenEarly, 'stf_shift_windows', `select=*&staff_id=eq.${staffAProfileId}`);
  assert(windowsSeenByB.length === 0, "admin B cannot read company A's shift windows");

  console.log('--- Switching Staff A to rolling idle-hours mode clears shift windows ---');
  await rpc(adminAToken, 'stf_set_idle_alert_hours', { p_staff_id: staffAProfileId, p_hours: 2 });
  await rpc(adminAToken, 'stf_set_shift_windows', { p_staff_id: staffAProfileId, p_windows: [] });
  const windowsAfter = await select(adminAToken, 'stf_shift_windows', `select=*&staff_id=eq.${staffAProfileId}`);
  assert(windowsAfter.length === 0, 'shift windows cleared after switching to rolling mode');
  const profileAfter = await select(adminAToken, 'stf_profiles', `select=idle_alert_hours&id=eq.${staffAProfileId}`);
  assert(profileAfter[0].idle_alert_hours === 2, 'idle_alert_hours set to 2');

  console.log('--- Admin A generates a Telegram link code ---');
  const linkCode = await rpc(adminAToken, 'stf_generate_telegram_link_code', {});
  assert(typeof linkCode === 'string' && linkCode.length === 6, 'got a 6-character link code');

  console.log('--- Admin B (from Company A isolation setup above) cannot see Company A profiles or check-ins ---');
  const profilesSeenByB = await select(adminBTokenEarly, 'stf_profiles', `select=*&id=eq.${staffAProfileId}`);
  assert(profilesSeenByB.length === 0, "admin B cannot read company A's staff profile");

  const checkinsSeenByB = await select(adminBTokenEarly, 'stf_checkins', `select=*&staff_id=eq.${staffAProfileId}`);
  assert(checkinsSeenByB.length === 0, "admin B cannot read company A's check-ins");

  console.log("--- Staff A cannot see another staff member's check-ins (self-only) ---");
  const checkinsSeenByStaffA = await select(staffAToken, 'stf_checkins', 'select=*');
  assert(checkinsSeenByStaffA.length === 2, 'staff A sees only their own 2 check-ins (the blocked zone attempt was never inserted), not company-wide');

  console.log('\nALL SMOKE TESTS PASSED');
})().catch(e => { console.error('SMOKE TEST FAILURE:', e.message); process.exit(1); });
