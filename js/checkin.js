// ==========================================
// STAFFTRACK - Staff check-in page
// ==========================================

let _requirePhoto = false;

function renderCheckinPage(container) {
  _requirePhoto = !!currentProfile.require_photo;

  container.innerHTML = `
    <div class="card" style="text-align:center;">
      <div class="card-title" style="border-bottom:none;">Hi, ${escapeHtml(currentProfile.name)}</div>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:18px;">
        ${_requirePhoto
          ? 'Tap below - you\'ll be asked to take a quick selfie, then your location is recorded.'
          : 'Tap the button below to record where you are right now.'}
      </p>
      <input type="file" accept="image/*" capture="user" id="checkin-photo-input" style="display:none;" onchange="onPhotoSelected(event)" />
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
  document.getElementById('checkin-error').textContent = '';
  if (_requirePhoto) {
    const input = document.getElementById('checkin-photo-input');
    input.value = '';
    input.click();
    return;
  }
  proceedCheckin(null);
}

function onPhotoSelected(event) {
  const file = event.target.files[0];
  if (!file) return; // user cancelled the camera
  proceedCheckin(file);
}

function compressImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
      else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not process photo.')), 'image/jpeg', quality);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('Could not read photo.'));
    img.src = URL.createObjectURL(file);
  });
}

async function proceedCheckin(photoFile) {
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
      let photoPath = null;

      if (photoFile) {
        try {
          btn.textContent = 'Uploading photo...';
          const compressed = await compressImage(photoFile, 800, 0.7);
          photoPath = `${currentProfile.company_id}/${crypto.randomUUID()}.jpg`;
          const { error: uploadError } = await db.storage.from('kidhar-checkins').upload(photoPath, compressed, { contentType: 'image/jpeg' });
          if (uploadError) throw uploadError;
        } catch (e) {
          btn.disabled = false;
          btn.textContent = '📍 Share My Location Now';
          errEl.textContent = 'Could not upload photo: ' + e.message;
          return;
        }
      }

      btn.textContent = 'Saving...';
      try {
        const { error } = await db.rpc('stf_log_checkin', {
          p_lat: latitude, p_lng: longitude, p_accuracy_m: accuracy, p_note: null, p_photo_path: photoPath
        });
        if (error) { errEl.textContent = error.message; return; }
        showToast('✅ Location shared!', 'success');
        loadMyCheckins();
      } catch (e) {
        errEl.textContent = 'Network error - check your connection and try again.';
      } finally {
        btn.disabled = false;
        btn.textContent = '📍 Share My Location Now';
      }
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
      <div style="display:flex;align-items:center;gap:10px;">
        ${c.photo_path ? `<img class="checkin-thumb" id="thumb-${c.id}" alt="Check-in photo" />` : ''}
        <div>
          <div class="list-item-name">${formatDateTime(c.captured_at)}</div>
          <div class="list-item-sub">${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} &middot; ${encodePlusCode(c.lat, c.lng)}${c.matched_zone_name ? ' &middot; ' + escapeHtml(c.matched_zone_name) : ''}</div>
        </div>
      </div>
      <div class="list-item-actions">
        <a class="btn-secondary btn-sm" href="${mapsLink(c.lat, c.lng)}" target="_blank" rel="noopener">Open in Maps</a>
      </div>
    </div>
  `).join('');

  data.filter(c => c.photo_path).forEach(c => loadCheckinThumb(c.id, c.photo_path));
}

async function loadCheckinThumb(checkinId, photoPath) {
  const { data } = await db.storage.from('kidhar-checkins').download(photoPath);
  if (!data) return;
  const img = document.getElementById('thumb-' + checkinId);
  if (img) img.src = URL.createObjectURL(data);
}
