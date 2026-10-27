// ==========================================
// Plus Codes (Open Location Code) - encode only, self-contained.
// Verified against the official "open-location-code" npm package across
// several coordinates including poles/date-line/zero before shipping.
// ==========================================

const PLUS_CODE_ALPHABET = '23456789CFGHJMPQRVWX';
const PLUS_CODE_PLACE_UNITS = [160000, 8000, 400, 20, 1];

function normalizeLongitude(lng) {
  while (lng < -180) lng += 360;
  while (lng >= 180) lng -= 360;
  return lng;
}

function encodePlusCode(lat, lng) {
  lat = Math.min(90, Math.max(-90, lat));
  if (lat === 90) lat -= 0.000125;
  lng = normalizeLongitude(lng);
  // Multiply by the exact integer reciprocal of the finest grid size
  // (1/0.000125 = 8000) rather than dividing by a decimal, to avoid
  // IEEE754 decimal-division rounding noise in the digit extraction below.
  let latUnits = Math.floor((lat + 90) * 8000);
  let lngUnits = Math.floor((lng + 180) * 8000);
  let code = '';
  for (let i = 0; i < 5; i++) {
    const placeUnits = PLUS_CODE_PLACE_UNITS[i];
    const latDigit = Math.floor(latUnits / placeUnits);
    latUnits -= latDigit * placeUnits;
    code += PLUS_CODE_ALPHABET[latDigit];
    const lngDigit = Math.floor(lngUnits / placeUnits);
    lngUnits -= lngDigit * placeUnits;
    code += PLUS_CODE_ALPHABET[lngDigit];
  }
  return code.slice(0, 8) + '+' + code.slice(8);
}
