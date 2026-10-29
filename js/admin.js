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
      <div style="display:flex;align-items:center;gap:10px;">
        ${c.photo_path ? `<img class="checkin-thumb" id="thumb-${c.id}" alt="Check-in photo" />` : ''}
        <div>
          <div class="list-item-name">${escapeHtml(nameById[c.staff_id] || 'Unknown')}</div>
          <div class="list-item-sub">${formatDateTime(c.captured_at)} &middot; ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} &middot; ${encodePlusCode(c.lat, c.lng)}${c.matched_zone_name ? ' &middot; ' + escapeHtml(c.matched_zone_name) : ''}</div>
        </div>
      </div>
      <div class="list-item-actions">
        <a class="btn-secondary btn-sm" href="${mapsLink(c.lat, c.lng)}" target="_blank" rel="noopener">Open in Maps</a>
      </div>
    </div>
  `).join('');

  data.filter(c => c.photo_path).forEach(c => loadCheckinThumb(c.id, c.photo_path));
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
          : (p.role !== 'admin' ? `
              <button class="btn-secondary btn-sm" onclick="openScheduleModal('${p.id}')">Schedule</button>
              <button class="btn-danger btn-sm" onclick="setStaffActive('${p.id}', false)">Deactivate</button>
            ` : '')}
      </div>
    </div>
  `).join('');
}

// ---------- Per-staff schedule (shift windows or rolling idle-hours) ----------

let _scheduleStaffId = null;
let _scheduleMode = 'none'; // 'none' | 'shift' | 'rolling'
let _scheduleWindows = []; // [{start_time:'08:00', end_time:'10:00', grace_minutes:20}, ...]

async function openScheduleModal(staffId) {
  _scheduleStaffId = staffId;
  const staff = _staffCache.find(p => p.id === staffId);
  const { data: windows } = await db.from('stf_shift_windows').select('*').eq('staff_id', staffId).order('start_time');
  _scheduleWindows = (windows || []).map(w => ({ start_time: w.start_time.slice(0, 5), end_time: w.end_time.slice(0, 5), grace_minutes: w.grace_minutes }));

  if (_scheduleWindows.length > 0) _scheduleMode = 'shift';
  else if (staff && staff.idle_alert_hours) _scheduleMode = 'rolling';
  else _scheduleMode = 'none';

  openModal(renderScheduleModalBody(staff));
}

function renderScheduleModalBody(staff) {
  const idleHours = (staff && staff.idle_alert_hours) || '';
  const activeStart = (staff && staff.idle_active_start) ? staff.idle_active_start.slice(0, 5) : '09:00';
  const activeEnd = (staff && staff.idle_active_end) ? staff.idle_active_end.slice(0, 5) : '19:00';
  return `
    <div class="modal-title">Schedule - ${escapeHtml(staff.name)}</div>
    <div class="form-group">
      <label>Alert Type</label>
      <select id="sched-mode" onchange="onScheduleModeChange()">
        <option value="none" ${_scheduleMode === 'none' ? 'selected' : ''}>No alerting</option>
        <option value="shift" ${_scheduleMode === 'shift' ? 'selected' : ''}>Shift windows (entry/exit times)</option>
        <option value="rolling" ${_scheduleMode === 'rolling' ? 'selected' : ''}>Continuous - tap every N hours</option>
      </select>
    </div>
    <div id="sched-shift-section" style="display:${_scheduleMode === 'shift' ? 'block' : 'none'};">
      <div id="sched-windows-list">${renderScheduleWindowsList()}</div>
      <button class="btn-secondary btn-sm" style="margin-top:8px;" onclick="addScheduleWindow()">+ Add Window</button>
    </div>
    <div id="sched-rolling-section" style="display:${_scheduleMode === 'rolling' ? 'block' : 'none'};margin-top:12px;">
      <div class="form-group">
        <label>Alert if no tap for (hours)</label>
        <input type="number" id="sched-idle-hours" min="0.5" step="0.5" value="${idleHours}" placeholder="e.g. 2" />
      </div>
      <div class="form-group">
        <label>Only check between (so it never alerts overnight)</label>
        <div style="display:flex;gap:10px;align-items:center;">
          <input type="time" id="sched-idle-active-start" value="${activeStart}" style="flex:1;" />
          <span>to</span>
          <input type="time" id="sched-idle-active-end" value="${activeEnd}" style="flex:1;" />
        </div>
      </div>
    </div>
    <div class="form-group" style="margin-top:12px;">
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;text-transform:none;">
        <input type="checkbox" id="sched-require-photo" ${staff && staff.require_photo ? 'checked' : ''} style="width:18px;height:18px;" />
        <span style="font-weight:normal;">Require a selfie-style photo on this staff member's check-ins</span>
      </label>
    </div>
    <div class="error-msg" id="sched-error"></div>
    <div class="modal-actions">
      <button class="btn-primary" onclick="saveSchedule()">Save</button>
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    </div>
  `;
}

function renderScheduleWindowsList() {
  if (_scheduleWindows.length === 0) return `<p class="form-hint">No windows yet - tap "+ Add Window" below.</p>`;
  return _scheduleWindows.map((w, i) => `
    <div class="list-item" style="align-items:flex-end;">
      <div class="form-group" style="flex:1;margin-bottom:0;">
        <label>Start</label>
        <input type="time" value="${w.start_time}" onchange="updateScheduleWindow(${i}, 'start_time', this.value)" />
      </div>
      <div class="form-group" style="flex:1;margin-bottom:0;">
        <label>End</label>
        <input type="time" value="${w.end_time}" onchange="updateScheduleWindow(${i}, 'end_time', this.value)" />
      </div>
      <div class="form-group" style="flex:1;margin-bottom:0;">
        <label>Grace (min)</label>
        <input type="number" min="0" value="${w.grace_minutes}" onchange="updateScheduleWindow(${i}, 'grace_minutes', this.value)" />
      </div>
      <button class="btn-danger btn-sm" onclick="removeScheduleWindow(${i})">✕</button>
    </div>
  `).join('');
}

function onScheduleModeChange() {
  _scheduleMode = document.getElementById('sched-mode').value;
  document.getElementById('sched-shift-section').style.display = _scheduleMode === 'shift' ? 'block' : 'none';
  document.getElementById('sched-rolling-section').style.display = _scheduleMode === 'rolling' ? 'block' : 'none';
}

function addScheduleWindow() {
  _scheduleWindows.push({ start_time: '08:00', end_time: '10:00', grace_minutes: 20 });
  document.getElementById('sched-windows-list').innerHTML = renderScheduleWindowsList();
}

function removeScheduleWindow(i) {
  _scheduleWindows.splice(i, 1);
  document.getElementById('sched-windows-list').innerHTML = renderScheduleWindowsList();
}

function updateScheduleWindow(i, field, value) {
  _scheduleWindows[i][field] = field === 'grace_minutes' ? parseInt(value, 10) : value;
}

async function saveSchedule() {
  const errEl = document.getElementById('sched-error');
  errEl.textContent = '';

  if (_scheduleMode === 'shift') {
    for (const w of _scheduleWindows) {
      if (!w.start_time || !w.end_time) { errEl.textContent = 'Every window needs a start and end time.'; return; }
      if (w.end_time <= w.start_time) { errEl.textContent = 'Each window\'s end time must be after its start time.'; return; }
    }
    const { error } = await db.rpc('stf_set_shift_windows', { p_staff_id: _scheduleStaffId, p_windows: JSON.stringify(_scheduleWindows) });
    if (error) { errEl.textContent = error.message; return; }
    await db.rpc('stf_set_idle_alert_hours', { p_staff_id: _scheduleStaffId, p_hours: null, p_active_start: null, p_active_end: null });
  } else if (_scheduleMode === 'rolling') {
    const hours = parseFloat(document.getElementById('sched-idle-hours').value);
    const activeStart = document.getElementById('sched-idle-active-start').value;
    const activeEnd = document.getElementById('sched-idle-active-end').value;
    if (!hours || hours <= 0) { errEl.textContent = 'Enter hours greater than zero.'; return; }
    if (!activeStart || !activeEnd) { errEl.textContent = 'Set the active hours range.'; return; }
    if (activeEnd <= activeStart) { errEl.textContent = 'The "to" time must be after the "between" time.'; return; }
    const { error } = await db.rpc('stf_set_idle_alert_hours', { p_staff_id: _scheduleStaffId, p_hours: hours, p_active_start: activeStart, p_active_end: activeEnd });
    if (error) { errEl.textContent = error.message; return; }
    await db.rpc('stf_set_shift_windows', { p_staff_id: _scheduleStaffId, p_windows: JSON.stringify([]) });
  } else {
    await db.rpc('stf_set_shift_windows', { p_staff_id: _scheduleStaffId, p_windows: JSON.stringify([]) });
    await db.rpc('stf_set_idle_alert_hours', { p_staff_id: _scheduleStaffId, p_hours: null, p_active_start: null, p_active_end: null });
  }

  const requirePhoto = document.getElementById('sched-require-photo').checked;
  const { error: photoError } = await db.rpc('stf_set_staff_require_photo', { p_staff_id: _scheduleStaffId, p_require: requirePhoto });
  if (photoError) { errEl.textContent = photoError.message; return; }

  closeModal();
  showToast('✅ Schedule saved!', 'success');
  renderStaffPage(document.getElementById('page-content'));
}

async function setStaffActive(profileId, active) {
  const { error } = await db.rpc('stf_admin_set_active', { p_profile_id: profileId, p_active: active });
  if (error) { showToast(error.message, 'error'); return; }
  showToast(active ? 'Approved!' : 'Deactivated.', 'success');
  renderStaffPage(document.getElementById('page-content'));
}
