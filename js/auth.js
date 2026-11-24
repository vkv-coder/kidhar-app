// ==========================================
// STAFFTRACK - Auth
// ==========================================

let currentUser = null;
let currentProfile = null;

function isAdmin() {
  return !!(currentProfile && currentProfile.role === 'admin' && currentProfile.active);
}

function isActiveUser() {
  return !!(currentProfile && currentProfile.active);
}

async function loadProfile() {
  const { data } = await db.from('stf_profiles').select('*').eq('id', currentUser.id).maybeSingle();
  currentProfile = data;
}

async function login() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value.trim();
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  if (!email || !password) { errEl.textContent = 'Please enter email and password.'; return; }

  const { data, error } = await db.auth.signInWithPassword({ email: tagEmail(email), password });
  if (error) { errEl.textContent = error.message; return; }

  currentUser = data.user;
  await loadProfile();

  if (!currentProfile) {
    showSetupScreen();
    return;
  }
  if (!currentProfile.active) {
    errEl.textContent = 'Your account is awaiting admin approval. Contact your admin.';
    await db.auth.signOut();
    currentUser = null;
    currentProfile = null;
    return;
  }

  showMainApp();
  initApp();
}

async function logout() {
  await db.auth.signOut();
  currentUser = null;
  currentProfile = null;
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('pin-login-screen').style.display = 'none';
  document.getElementById('main-screen').style.display = 'none';
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
}

function showPinLogin() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('pin-login-screen').style.display = 'flex';
  document.getElementById('pin-login-error').textContent = '';
  document.getElementById('pin-login-input').value = '';
}

function hidePinLogin() {
  document.getElementById('pin-login-screen').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

async function loginWithPin() {
  const pin = document.getElementById('pin-login-input').value.trim();
  const errEl = document.getElementById('pin-login-error');
  errEl.textContent = '';

  if (!pin) { errEl.textContent = 'Please enter your PIN.'; return; }

  let res, result;
  try {
    res = await fetch(PIN_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ action: 'login', pin }),
    });
    result = await res.json();
  } catch (e) {
    errEl.textContent = 'Network error - check your connection and try again.';
    return;
  }
  if (!res.ok) { errEl.textContent = result.error || 'Incorrect PIN.'; return; }

  const { data, error } = await db.auth.verifyOtp({ type: 'magiclink', token_hash: result.token_hash });
  if (error || !data.session) { errEl.textContent = error?.message || 'Could not start session. Try again.'; return; }

  currentUser = data.session.user;
  await loadProfile();
  if (!currentProfile || !currentProfile.active) {
    errEl.textContent = 'Account error. Contact your admin.';
    await db.auth.signOut();
    currentUser = null;
    currentProfile = null;
    return;
  }

  document.getElementById('pin-login-screen').style.display = 'none';
  showMainApp();
  initApp();
}

function showMainApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('main-screen').style.display = 'block';
}

// Check session on load.
window.addEventListener('load', async () => {
  if (!document.getElementById('login-screen')) return;
  if (window.location.hash.includes('type=recovery')) return;
  const { data } = await db.auth.getSession();
  if (data.session) {
    currentUser = data.session.user;
    await loadProfile();
    if (!currentProfile) {
      showSetupScreen();
      return;
    }
    if (!currentProfile.active) {
      await db.auth.signOut();
      currentUser = null;
      currentProfile = null;
      return;
    }
    showMainApp();
    initApp();
  }
});

// Forgot password
function showForgotPassword() {
  const m = document.getElementById('forgotModal');
  if (m) m.style.display = 'flex';
  const e = document.getElementById('forgotEmail');
  if (e) e.value = '';
  const msg = document.getElementById('forgotMsg');
  if (msg) msg.style.display = 'none';
}
function hideForgotPassword() {
  const m = document.getElementById('forgotModal');
  if (m) m.style.display = 'none';
}
async function sendForgotPassword() {
  const email = document.getElementById('forgotEmail').value.trim();
  const msg = document.getElementById('forgotMsg');
  if (!email) { msg.textContent = 'Please enter your email.'; msg.style.color = '#D32F2F'; msg.style.display = 'block'; return; }
  const { error } = await db.auth.resetPasswordForEmail(tagEmail(email), { redirectTo: window.location.origin + window.location.pathname });
  if (error) { msg.textContent = 'Error: ' + error.message; msg.style.color = '#D32F2F'; }
  else { msg.textContent = 'Reset link sent! Check your email.'; msg.style.color = '#2E7D32'; }
  msg.style.display = 'block';
}
async function confirmNewPassword() {
  const newPass = document.getElementById('newPassInput').value.trim();
  const confirmPass = document.getElementById('newPassConfirm').value.trim();
  const msg = document.getElementById('newPassMsg');
  if (!newPass || newPass.length < 6) { msg.textContent = 'Password must be at least 6 characters.'; msg.style.display = 'block'; return; }
  if (newPass !== confirmPass) { msg.textContent = 'Passwords do not match.'; msg.style.display = 'block'; return; }
  const { error } = await db.auth.updateUser({ password: newPass });
  if (error) { msg.textContent = 'Error: ' + error.message; msg.style.display = 'block'; return; }
  msg.style.color = '#2E7D32';
  msg.textContent = '✅ Password updated! Redirecting to login...';
  msg.style.display = 'block';
  await db.auth.signOut();
  setTimeout(() => { window.location.href = window.location.pathname; }, 1800);
}

db.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    const m = document.getElementById('newPassModal');
    if (m) m.style.display = 'flex';
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
