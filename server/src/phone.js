// Phone numbers are stored in E.164 (+<country><number>), the format WhatsApp
// and SMS gateways expect. Brazilian numbers may be typed in any usual way:
//   (11) 98888-7777   11988887777   +55 11 98888 7777   0xx11 98888-7777
// Other countries must be typed with the leading "+".

export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 32) return null;
  if (!/^[\d\s()+.-]+$/.test(raw)) return null;
  const intl = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');

  if (!intl) {
    digits = digits.replace(/^0+/, '');               // trunk prefix "0"
    if (digits.length === 10 || digits.length === 11) {
      digits = '55' + digits;                         // DDD + number
    } else if ((digits.length === 12 || digits.length === 13) && !digits.startsWith('55')) {
      digits = '55' + digits.slice(2);                // "0 15 11 98888-7777": carrier code
    }
  }

  if (digits.startsWith('55')) {
    const national = digits.slice(2);
    const ddd = Number(national.slice(0, 2));
    const subscriber = national.slice(2);
    if (ddd < 11 || ddd > 99 || national[1] === '0') return null;
    // mobile: 9 digits starting with 9; landline: 8 digits starting with 2-5
    if (subscriber.length === 9 && subscriber[0] === '9') return '+' + digits;
    if (subscriber.length === 8 && /[2-5]/.test(subscriber[0])) return '+' + digits;
    return null;
  }
  if (!intl) return null;  // without "+" only Brazilian numbers are accepted
  if (digits.length < 8 || digits.length > 15 || digits[0] === '0') return null;
  return '+' + digits;
}

// Display form: +55 (11) 98888-7777 for Brazil, otherwise +<digits>.
export function formatPhone(e164) {
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function cleanName(input) {
  if (typeof input !== 'string') return null;
  // collapse spaces, drop control characters
  const s = input.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < 1 || s.length > 40) return null;
  return s;
}
