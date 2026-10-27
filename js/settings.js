// ==========================================
// STAFFTRACK - Admin Settings (Zones + Telegram Alerts)
// ==========================================

let _zoneModalId = null; // null = adding a new zone; else editing this zone's id
let _zoneModalLat = null;
let _zoneModalLng = null;

async function renderSettingsPage(container) {
  container.innerHTML = `<div class="card"><p>Loading...</p></div>`;

  const { data: zones } = await db.from('stf_zones').select('*').order('created_at');

  container.innerHTML = `
    <div class="card">
      <div class="section-header"><h3>Zones</h3></div>
      <p class="form-hint" style="margin-bottom:12px;">
        ${zones && zones.length > 0
          ? 'A check-in only counts if it\'s inside one of these zones. No zones yet means staff can check in from anywhere.'
          : 'No zones set yet - staff can check in from anywhere.'}
      </p>
      <div id="zones-list">${renderZonesList(zones || [])}</div>
      <button class="btn-primary" style="margin-top:12px;" onclick="openZoneModal()">+ Add Zone</button>
    </div>

    <div class="card">
      <div class="card-title">Telegram Alerts</div>
      <div id="telegram-card">${renderTelegramCard()}</div>
    </div>
  `;
}

function renderZonesList(zones) {
  if (zones.length === 0) return `<div class="empty-state"><p>No zones yet.</p></div>`;
  return zones.map(z => `
    <div class="list-item">
      <div>
        <div class="list-item-name">${escapeHtml(z.name)}</div>
        <div class="list-item-sub">${z.lat.toFixed(5)}, ${z.lng.toFixed(5)} (${encodePlusCode(z.lat, z.lng)}) &middot; radius ${z.radius_m} m</div>
      </div>
      <div class="list-item-actions">
        <button class="btn-secondary btn-sm" onclick="openZoneModal('${z.id}')">Edit</button>
        <button class="btn-danger btn-sm" onclick="deleteZone('${z.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

async function openZoneModal(zoneId) {
  _zoneModalId = zoneId || null;
  _zoneModalLat = null;
  _zoneModalLng = null;
  let zone = null;
  if (zoneId) {
    const { data } = await db.from('stf_zones').select('*').eq('id', zoneId).single();
    zone = data;
    _zoneModalLat = zone.lat;
    _zoneModalLng = zone.lng;
  }

  openModal(`
    <div class="modal-title">${zoneId ? 'Edit Zone' : 'Add Zone'}</div>
    <div class="form-group">
      <label>Name</label>
      <input type="text" id="zone-name-input" value="${zone ? escapeHtml(zone.name) : ''}" placeholder="e.g. Office, Warehouse, Farm 1" />
    </div>
    <button class="btn-secondary" style="width:100%;margin-bottom:12px;" onclick="useMyLocationForZone()">📍 Stand Here &amp; Use This Spot</button>
    <div class="form-group">
      <label>Or Enter Coordinates Manually</label>
      <div style="display:flex;gap:10px;">
        <input type="number" id="zone-lat-input" step="any" placeholder="Latitude" style="flex:1;" value="${zone ? zone.lat : ''}" oninput="useManualCoordsForZone()" />
        <input type="number" id="zone-lng-input" step="any" placeholder="Longitude" style="flex:1;" value="${zone ? zone.lng : ''}" oninput="useManualCoordsForZone()" />
      </div>
      <div class="form-hint">From Google Maps: long-press the spot, then tap the coordinates shown to copy them.</div>
    </div>
    <div class="form-hint" id="zone-center-preview">${_zoneModalLat != null ? previewText(_zoneModalLat, _zoneModalLng) : 'Location not set yet.'}</div>
    <div class="form-group" style="margin-top:12px;">
      <label>Radius (meters)</label>
      <input type="number" id="zone-radius" min="1" value="${zone ? zone.radius_m : ''}" placeholder="e.g. 50" />
      <div class="form-hint">Tip: for a 200ft x 200ft plot, a center-to-corner distance is about 43m, so 50m comfortably covers it.</div>
    </div>
    <div class="error-msg" id="zone-error"></div>
    <div class="modal-actions">
      <button class="btn-primary" onclick="saveZone()">Save</button>
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

function previewText(lat, lng) {
  return 'Location: ' + lat.toFixed(5) + ', ' + lng.toFixed(5) + ' (' + encodePlusCode(lat, lng) + ')';
}

function renderTelegramCard() {
  if (currentProfile.telegram_chat_id) {
    return `
      <p style="color:var(--success);font-weight:600;">✅ Telegram connected</p>
      <p class="form-hint">You'll get alerts here when a staff member misses a check-in. Set each staff member's schedule from the Staff tab.</p>
      <button class="btn-secondary btn-sm" style="margin-top:10px;" onclick="generateTelegramCode()">Reconnect / Use a Different Telegram</button>
    `;
  }
  return `
    <p class="form-hint">Not connected yet. This is a one-time step so alerts reach your own Telegram, not anyone else's.</p>
    <button class="btn-primary" onclick="generateTelegramCode()">Connect Telegram</button>
    <div id="telegram-code-box" style="margin-top:12px;"></div>
  `;
}

function useMyLocationForZone() {
  const errEl = document.getElementById('zone-error');
  errEl.textContent = '';
  if (!('geolocation' in navigator)) { errEl.textContent = 'Location is not supported on this device/browser.'; return; }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setZoneModalLocation(pos.coords.latitude, pos.coords.longitude);
      document.getElementById('zone-lat-input').value = pos.coords.latitude;
      document.getElementById('zone-lng-input').value = pos.coords.longitude;
    },
    () => { errEl.textContent = 'Could not get your location. Please try again.'; },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

function useManualCoordsForZone() {
  const lat = parseFloat(document.getElementById('zone-lat-input').value);
  const lng = parseFloat(document.getElementById('zone-lng-input').value);
  if (isNaN(lat) || isNaN(lng)) return;
  setZoneModalLocation(lat, lng);
}

function setZoneModalLocation(lat, lng) {
  _zoneModalLat = lat;
  _zoneModalLng = lng;
  document.getElementById('zone-center-preview').textContent = previewText(lat, lng) + ' - tap Save to confirm';
}

async function saveZone() {
  const errEl = document.getElementById('zone-error');
  errEl.textContent = '';
  const name = document.getElementById('zone-name-input').value.trim();
  const radius = parseFloat(document.getElementById('zone-radius').value);

  if (!name) { errEl.textContent = 'Enter a name for this zone.'; return; }
  if (_zoneModalLat == null || _zoneModalLng == null) { errEl.textContent = 'Set a location first.'; return; }
  if (!radius || radius <= 0) { errEl.textContent = 'Enter a radius greater than zero.'; return; }

  const { error } = _zoneModalId
    ? await db.rpc('stf_update_zone', { p_zone_id: _zoneModalId, p_name: name, p_lat: _zoneModalLat, p_lng: _zoneModalLng, p_radius_m: radius })
    : await db.rpc('stf_add_zone', { p_name: name, p_lat: _zoneModalLat, p_lng: _zoneModalLng, p_radius_m: radius });
  if (error) { errEl.textContent = error.message; return; }

  closeModal();
  showToast('✅ Zone saved!', 'success');
  renderSettingsPage(document.getElementById('page-content'));
}

async function deleteZone(zoneId) {
  const { error } = await db.rpc('stf_delete_zone', { p_zone_id: zoneId });
  if (error) { showToast(error.message, 'error'); return; }
  showToast('Zone deleted.', 'success');
  renderSettingsPage(document.getElementById('page-content'));
}

async function generateTelegramCode() {
  const { data, error } = await db.rpc('stf_generate_telegram_link_code');
  if (error) { showToast(error.message, 'error'); return; }
  const box = document.getElementById('telegram-code-box');
  if (!box) return;
  const deepLink = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(data)}`;
  box.innerHTML = `
    <div class="card" style="background:var(--bg);">
      <a class="btn-primary" style="display:block;text-align:center;text-decoration:none;" href="${deepLink}" target="_blank" rel="noopener">Tap to Connect on Telegram</a>
      <p class="form-hint" style="margin-top:10px;">This opens Telegram - just tap "Start" there. You'll get a reply confirming you're connected, then come back here.</p>
      <p class="form-hint">If the button doesn't work, open Telegram yourself, search for <strong>@${escapeHtml(TELEGRAM_BOT_USERNAME)}</strong>, and send it this code: <strong>${escapeHtml(data)}</strong></p>
    </div>
  `;
}
