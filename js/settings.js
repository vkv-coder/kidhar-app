// ==========================================
// STAFFTRACK - Admin Settings (Zone + Telegram Alerts)
// ==========================================

let _pendingZoneLat = null;
let _pendingZoneLng = null;

async function renderSettingsPage(container) {
  container.innerHTML = `<div class="card"><p>Loading...</p></div>`;

  const { data: company } = await db.from('stf_companies').select('*').eq('id', currentProfile.company_id).single();
  _pendingZoneLat = company && company.zone_lat != null ? company.zone_lat : null;
  _pendingZoneLng = company && company.zone_lng != null ? company.zone_lng : null;

  const hasZone = company && company.zone_lat != null && company.zone_lng != null && company.zone_radius_m != null;

  container.innerHTML = `
    <div class="card">
      <div class="card-title">Company Zone</div>
      <div id="zone-status" class="form-hint" style="margin-bottom:12px;">
        ${hasZone
          ? `Zone set: ${company.zone_lat.toFixed(5)}, ${company.zone_lng.toFixed(5)} &middot; radius ${company.zone_radius_m} m. Check-ins outside this are blocked.`
          : 'No zone set yet - staff can check in from anywhere.'}
      </div>
      <button class="btn-secondary" style="width:100%;margin-bottom:12px;" onclick="useMyLocationForZone()">📍 Stand Here &amp; Set Zone Center</button>
      <div class="form-hint" id="zone-center-preview">${_pendingZoneLat != null ? ('Center ready: ' + _pendingZoneLat.toFixed(5) + ', ' + _pendingZoneLng.toFixed(5)) : 'Center not captured yet.'}</div>
      <div class="form-group" style="margin-top:12px;">
        <label>Radius (meters)</label>
        <input type="number" id="zone-radius" min="1" value="${hasZone ? company.zone_radius_m : ''}" placeholder="e.g. 50" />
        <div class="form-hint">Tip: for a 200ft x 200ft plot, a center-to-corner distance is about 43m, so 50m comfortably covers it.</div>
      </div>
      <button class="btn-primary" onclick="saveZone()">Save Zone</button>
      <div class="error-msg" id="zone-error"></div>
    </div>

    <div class="card">
      <div class="card-title">Telegram Alerts</div>
      <div id="telegram-card">${renderTelegramCard()}</div>
    </div>
  `;
}

function renderTelegramCard() {
  if (!TELEGRAM_BOT_USERNAME) {
    return `<p class="form-hint">Telegram alerts are being set up by the developer and will be enabled here soon.</p>`;
  }
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

async function useMyLocationForZone() {
  const errEl = document.getElementById('zone-error');
  errEl.textContent = '';
  if (!('geolocation' in navigator)) { errEl.textContent = 'Location is not supported on this device/browser.'; return; }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      _pendingZoneLat = pos.coords.latitude;
      _pendingZoneLng = pos.coords.longitude;
      document.getElementById('zone-center-preview').textContent =
        'Center ready: ' + _pendingZoneLat.toFixed(5) + ', ' + _pendingZoneLng.toFixed(5) + ' (tap Save Zone to confirm)';
    },
    () => { errEl.textContent = 'Could not get your location. Please try again.'; },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

async function saveZone() {
  const errEl = document.getElementById('zone-error');
  errEl.textContent = '';
  const radius = parseFloat(document.getElementById('zone-radius').value);

  if (_pendingZoneLat == null || _pendingZoneLng == null) {
    errEl.textContent = 'Tap "Stand Here & Set Zone Center" first.';
    return;
  }
  if (!radius || radius <= 0) {
    errEl.textContent = 'Enter a radius greater than zero.';
    return;
  }

  const { error } = await db.rpc('stf_set_zone', { p_lat: _pendingZoneLat, p_lng: _pendingZoneLng, p_radius_m: radius });
  if (error) { errEl.textContent = error.message; return; }
  showToast('✅ Zone saved!', 'success');
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
