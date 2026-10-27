// ==========================================
// STAFFTRACK - Staff check-in page
// ==========================================

function renderCheckinPage(container) {
  container.innerHTML = `
    <div class="card" style="text-align:center;">
      <div class="card-title" style="border-bottom:none;">Hi, ${escapeHtml(currentProfile.name)}</div>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:18px;">
        Tap the button below to record where you are right now.
      </p>
      <button class="btn-primary" id="checkin-btn" style="padding:22px;font-size:17px;" onclick="doCheckin()">
        📍 Share My Location Now
      </button>
      <div class="error-msg" id="checkin-error"></div>
    </div>
    <div class="card">
      <div class="section-header"><h3>Your Recent Check-Ins</h3></div>
      <div id="my-checkins-list"><div class="empty-state"><p>Loading...</p></div></div>
    </div>
  `;
  loadMyCheckins();
}

function doCheckin() {
  const btn = document.getElementById('checkin-btn');
  const errEl = document.getElementById('checkin-error');
  errEl.textContent = '';

  if (!('geolocation' in navigator)) {
    errEl.textContent = 'Location is not supported on this device/browser.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Getting your location...';

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const { error } = await db.rpc('stf_log_checkin', {
        p_lat: latitude, p_lng: longitude, p_accuracy_m: accuracy, p_note: null
      });
      btn.disabled = false;
      btn.textContent = '📍 Share My Location Now';
      if (error) {
        errEl.textContent = error.message;
        return;
      }
      showToast('✅ Location shared!', 'success');
      loadMyCheckins();
    },
    (geoErr) => {
      btn.disabled = false;
      btn.textContent = '📍 Share My Location Now';
      if (geoErr.code === geoErr.PERMISSION_DENIED) {
        errEl.textContent = 'Location permission was denied. Please allow location access for this site in your browser settings and try again.';
      } else if (geoErr.code === geoErr.TIMEOUT) {
        errEl.textContent = 'Timed out getting your location. Please try again.';
      } else {
        errEl.textContent = 'Could not get your location. Please try again.';
      }
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

async function loadMyCheckins() {
  const listEl = document.getElementById('my-checkins-list');
  const { data, error } = await db.from('stf_checkins')
    .select('*')
    .eq('staff_id', currentUser.id)
    .order('captured_at', { ascending: false })
    .limit(10);

  if (error) {
    listEl.innerHTML = `<div class="empty-state"><p>Could not load check-ins.</p></div>`;
    return;
  }
  if (!data || data.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">📍</div><p>No check-ins yet.</p></div>`;
    return;
  }
  listEl.innerHTML = data.map(c => `
    <div class="list-item">
      <div>
        <div class="list-item-name">${formatDateTime(c.captured_at)}</div>
        <div class="list-item-sub">${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} &middot; ${encodePlusCode(c.lat, c.lng)}</div>
      </div>
      <div class="list-item-actions">
        <a class="btn-secondary btn-sm" href="${mapsLink(c.lat, c.lng)}" target="_blank" rel="noopener">Open in Maps</a>
      </div>
    </div>
  `).join('');
}
