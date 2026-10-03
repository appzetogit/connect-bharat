/// AWB (air waybill) numbers: the human-readable tracking number printed on
/// every label and typed into every scanner.
///
/// Format: ZB + 3-letter city code + YYMMDD + 6-digit daily sequence + 1
/// check digit, e.g. ZBBLR2610030000427. 18 characters, uppercase, no
/// separators, so a keyboard-wedge Code128 scanner and a human reading it
/// over the phone produce the same string.
///
/// The check digit is Luhn (mod 10) over a digit expansion of the body
/// (letters become their base-36 value, A=10 … Z=35). It catches every
/// single-digit typo and every adjacent digit swap except 0↔9, which is
/// what goes wrong when someone types an AWB by hand at a counter. Letter
/// typos are mostly caught too; the rest name a city code no hub has. Pure;
/// the sequence itself comes from the database (hubLookupService).

export const AWB_PREFIX = 'ZB';
export const AWB_LENGTH = 18;
const AWB_PATTERN = /^ZB[A-Z]{3}\d{6}\d{6}\d$/;

const charToDigits = (char) => {
  const code = char.charCodeAt(0);
  if (code >= 48 && code <= 57) return char; // 0-9
  if (code >= 65 && code <= 90) return String(code - 55); // A=10 … Z=35
  throw new Error(`AWB may only contain A-Z and 0-9, got "${char}"`);
};

export const computeLuhnDigit = (digitString) => {
  let sum = 0;
  // Double every second digit counting from the right of the payload, since
  // the check digit will be appended on the right.
  for (let index = 0; index < digitString.length; index += 1) {
    let digit = Number(digitString[digitString.length - 1 - index]);
    if (index % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return String((10 - (sum % 10)) % 10);
};

export const computeAwbCheckDigit = (body) =>
  computeLuhnDigit(String(body).toUpperCase().split('').map(charToDigits).join(''));

/// Three uppercase letters for a city: the explicit code when one is set,
/// else the first consonant-heavy letters of the name, padded with X.
export const normalizeCityCode = (value = '') => {
  const letters = String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length >= 3) {
    if (String(value).trim().length === 3) return letters.slice(0, 3);
    const consonants = letters[0] + letters.slice(1).replace(/[AEIOU]/g, '');
    return (consonants.length >= 3 ? consonants : letters).slice(0, 3);
  }
  return (letters + 'XXX').slice(0, 3);
};

/// YYMMDD in the given UTC offset (minutes). The operating day is Indian
/// time, so a parcel booked at 00:30 IST carries that day's date even though
/// the server clock is still on yesterday in UTC.
export const formatAwbDate = (date = new Date(), offsetMinutes = 330) => {
  const shifted = new Date(new Date(date).getTime() + offsetMinutes * 60 * 1000);
  const yy = String(shifted.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
};

export const buildAwb = ({ cityCode, date = new Date(), sequence, offsetMinutes = 330 }) => {
  const seq = Number(sequence);
  if (!Number.isInteger(seq) || seq < 1 || seq > 999999) {
    throw new Error('AWB sequence must be an integer from 1 to 999999');
  }
  const body = `${AWB_PREFIX}${normalizeCityCode(cityCode)}${formatAwbDate(date, offsetMinutes)}${String(seq).padStart(6, '0')}`;
  return `${body}${computeAwbCheckDigit(body)}`;
};

export const normalizeAwbInput = (value = '') => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const isValidAwb = (value) => {
  const awb = normalizeAwbInput(value);
  if (!AWB_PATTERN.test(awb)) return false;
  return computeAwbCheckDigit(awb.slice(0, -1)) === awb.slice(-1);
};

/// What the QR code on a label encodes: the public tracking URL when a base
/// is configured, else the bare AWB. Either way a scanner that reads the QR
/// can recover the AWB (see extractAwbFromScan).
export const buildQrPayload = (awb, trackingBaseUrl = '') => {
  const base = String(trackingBaseUrl || '').trim().replace(/\/+$/, '');
  return base ? `${base}/${awb}` : awb;
};

/// A scanner may hand us the raw AWB, a tracking URL from the QR, or the AWB
/// with stray whitespace from a keyboard wedge. Pull the AWB out of any of
/// them.
export const extractAwbFromScan = (raw = '') => {
  const text = String(raw || '').toUpperCase();
  const match = text.match(/ZB[A-Z]{3}\d{13}/);
  return match ? match[0] : normalizeAwbInput(text);
};
