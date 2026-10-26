// ==========================================
// STAFFTRACK - Finish Setup (first login after email confirmation)
// A confirmed user with no stf_profiles row yet lands here to choose
// whether they're creating a brand-new company or joining an existing one.
// ==========================================

function onSetupModeChange() {
  const mode = document.getElementById('setup-mode').value;
  document.getElementById('setup-company-select-group').style.display = mode === 'join' ? 'block' : 'none';
  document.getElementById('setup-company-name-group').style.display = mode === 'create' ? 'block' : 'none';
}

async function loadCompaniesForSetup() {
  const sel = document.getElementById('setup-company-id');
  const { data, error } = await db.from('stf_companies').select('id,name').eq('active', true).order('name');
  if (error || !data || data.length === 0) {
    sel.innerHTML = '<option value="">No companies yet - choose "Setting up a new company" above</option>';
    return;
  }
  sel.innerHTML = data.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

function showSetupScreen() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('main-screen').style.display = 'none';
  document.getElementById('setup-screen').style.display = 'flex';
  document.getElementById('setup-name').value = (currentUser.user_metadata && currentUser.user_metadata.name) || '';
  document.getElementById('setup-mode').value = 'join';
  onSetupModeChange();
  loadCompaniesForSetup();
}

async function finishSetup() {
  const mode = document.getElementById('setup-mode').value;
  const name = document.getElementById('setup-name').value.trim();
  const errEl = document.getElementById('setup-error');
  errEl.textContent = '';

  if (!name) { errEl.textContent = 'Enter your name.'; return; }

  if (mode === 'join') {
    const companyId = document.getElementById('setup-company-id').value;
    if (!companyId) { errEl.textContent = 'Please select your company.'; return; }
    const { error } = await db.rpc('stf_signup_join_company', { p_company_id: companyId, p_staff_name: name });
    if (error) { errEl.textContent = error.message; return; }
  } else {
    const companyName = document.getElementById('setup-company-name').value.trim();
    if (!companyName) { errEl.textContent = 'Enter your company name.'; return; }
    const { error } = await db.rpc('stf_signup_create_company', { p_company_name: companyName, p_admin_name: name });
    if (error) { errEl.textContent = error.message; return; }
  }

  await loadProfile();
  if (!currentProfile) { errEl.textContent = 'Setup did not complete. Please try again.'; return; }

  document.getElementById('setup-screen').style.display = 'none';
  if (!currentProfile.active) {
    showToast('✅ Account created! Ask your admin to approve you before you can check in.', 'success');
    document.getElementById('login-screen').style.display = 'flex';
    await db.auth.signOut();
    currentUser = null;
    currentProfile = null;
    return;
  }
  showMainApp();
  initApp();
}
