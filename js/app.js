// ==========================================
// STAFFTRACK - App shell / router
// ==========================================

let currentTab = null;

function tabsForRole() {
  if (isAdmin()) return [
    { id: 'lookup', label: 'Lookup' },
    { id: 'staff', label: 'Staff' },
    { id: 'settings', label: 'Settings' }
  ];
  return [
    { id: 'checkin', label: 'Check In' }
  ];
}

function renderNavTabs() {
  const tabs = tabsForRole();
  const nav = document.getElementById('nav-tabs');
  nav.innerHTML = tabs.map(t =>
    `<div class="nav-tab${t.id === currentTab ? ' active' : ''}" onclick="goTab('${t.id}')">${t.label}</div>`
  ).join('');
}

function goTab(tabId) {
  currentTab = tabId;
  renderNavTabs();
  const content = document.getElementById('page-content');
  if (tabId === 'checkin') renderCheckinPage(content);
  else if (tabId === 'lookup') renderLookupPage(content);
  else if (tabId === 'staff') renderStaffPage(content);
  else if (tabId === 'settings') renderSettingsPage(content);
}

function openModal(html) {
  document.getElementById('modal-box').innerHTML = html;
  document.getElementById('modal-overlay').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.getElementById('modal-box').innerHTML = '';
}

function initApp() {
  document.getElementById('user-role-badge').textContent = currentProfile.role === 'admin' ? 'Admin' : 'Staff';
  const tabs = tabsForRole();
  goTab(tabs[0].id);
}

function showToast(msg, type) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show ' + (type || '');
  setTimeout(() => { toast.className = 'toast'; }, type === 'error' ? 8000 : 3000);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function mapsLink(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}
