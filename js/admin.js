// ==========================================
// STAFFTRACK - Admin pages (Lookup + Staff)
// ==========================================

let _staffCache = [];

async function loadStaffCache() {
  const { data } = await db.from('stf_profiles').select('*').order('name');
  _staffCache = data || [];
  return _staffCache;
}

function todayDateStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function renderLookupPage(container) {
  container.innerHTML = `<div class="card"><p>Loading...</p></div>`;
  await loadStaffCache();
  const staffOptions = _staffCache
    .filter(p => p.role === 'staff')
    .map(p => `<option value="${p.id}">${escapeHtml(p.name)}${p.active ? '' : ' (pending)'}</option>`)
    .join('');

  container.innerHTML = `
    <div class="card">
      <div class="card-title">Find a Staff Member's Position</div>
      <div class="form-group">
        <label>Staff Member</label>
        <select id="lookup-staff">
          <option value="">All staff</option>
          ${staffOptions}
        </select>
      </div>
      <div class="form-group">
        <label>Date</label>
        <input type="date" id="lookup-date" value="${todayDateStr()}" />
      </div>
      <div style="display:flex;gap:10px;">
        <div class="form-group" style="flex:1;">
          <label>From Time</label>
          <input type="time" id="lookup-from" value="00:00" />
        </div>
        <div class="form-group" style="flex:1;">
          <label>To Time</label>
          <input type="time" id="lookup-to" value="23:59" />
        </div>
      </div>
      <button class="btn-primary" onclick="runLookup()">Search</button>
      <div class="error-msg" id="lookup-error"></div>
    </div>
    <div class="card">
      <div class="section-header"><h3>Results</h3></div>
      <div id="lookup-results"><div class="empty-state"><p>Choose filters above and tap Search.</p></div></div>
    </div>
  `;
}

async function runLookup() {
  const errEl = document.getElementById('lookup-error');
  const resultsEl = document.getElementById('lookup-results');
  errEl.textContent = '';

  const staffId = document.getElementById('lookup-staff').value;
  const dateStr = document.getElementById('lookup-date').value;
  const fromTime = document.getElementById('lookup-from').value || '00:00';
  const toTime = document.getElementById('lookup-to').value || '23:59';

  if (!dateStr) { errEl.textContent = 'Please pick a date.'; return; }

  const start = new Date(`${dateStr}T${fromTime}:00`);
  const end = new Date(`${dateStr}T${toTime}:59`);
  if (end < start) { errEl.textContent = 'To Time must be after From Time.'; return; }

  let query = db.from('stf_checkins').select('*')
    .gte('captured_at', start.toISOString())
    .lte('captured_at', end.toISOString())
    .order('captured_at', { ascending: false });

  if (staffId) query = query.eq('staff_id', staffId);

  const { data, error } = await query;
  if (error) { errEl.textContent = error.message; return; }

  if (!data || data.length === 0) {
    resultsEl.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>No check-ins found for that filter.</p></div>`;
    return;
  }

  const nameById = Object.fromEntries(_staffCache.map(p => [p.id, p.name]));
  resultsEl.innerHTML = data.map(c => `
    <div class="list-item">
      <div>
        <div class="list-item-name">${escapeHtml(nameById[c.staff_id] || 'Unknown')}</div>
        <div class="list-item-sub">${formatDateTime(c.captured_at)} &middot; ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}</div>
      </div>
      <div class="list-item-actions">
        <a class="btn-secondary btn-sm" href="${mapsLink(c.lat, c.lng)}" target="_blank" rel="noopener">Open in Maps</a>
      </div>
    </div>
  `).join('');
}

async function renderStaffPage(container) {
  container.innerHTML = `<div class="card"><p>Loading...</p></div>`;
  await loadStaffCache();
  const pending = _staffCache.filter(p => !p.active);
  const active = _staffCache.filter(p => p.active);

  container.innerHTML = `
    <div class="card">
      <div class="section-header"><h3>Pending Approval</h3></div>
      <div id="pending-list">${renderStaffList(pending, true)}</div>
    </div>
    <div class="card">
      <div class="section-header"><h3>Active Team</h3></div>
      <div id="active-list">${renderStaffList(active, false)}</div>
    </div>
  `;
}

function renderStaffList(list, pending) {
  if (list.length === 0) {
    return `<div class="empty-state"><p>${pending ? 'No one is waiting for approval.' : 'No active team members yet.'}</p></div>`;
  }
  return list.map(p => `
    <div class="list-item">
      <div>
        <div class="list-item-name">${escapeHtml(p.name)}</div>
        <div class="list-item-sub">${p.role === 'admin' ? 'Admin' : 'Staff'}</div>
      </div>
      <div class="list-item-actions">
        ${pending
          ? `<button class="btn-accent btn-sm" onclick="setStaffActive('${p.id}', true)">Approve</button>`
          : (p.role !== 'admin' ? `<button class="btn-danger btn-sm" onclick="setStaffActive('${p.id}', false)">Deactivate</button>` : '')}
      </div>
    </div>
  `).join('');
}

async function setStaffActive(profileId, active) {
  const { error } = await db.rpc('stf_admin_set_active', { p_profile_id: profileId, p_active: active });
  if (error) { showToast(error.message, 'error'); return; }
  showToast(active ? 'Approved!' : 'Deactivated.', 'success');
  renderStaffPage(document.getElementById('page-content'));
}
