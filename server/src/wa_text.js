// WhatsApp link, pure helpers: the pairing QR as a bit matrix, what a received
// message says, and the text shown on the AirGuard displays.
import qrcode from 'qrcode-generator';

// What the node shows (OLED 2x font, then relayed by LoRa to the LCD): the
// sender and the text are shortened here so the node never has to guess.
export const DISPLAY_NAME_MAX = 20;
export const DISPLAY_TEXT_MAX = 96;
export const STORED_TEXT_MAX = 1000;   // what the monitoring page keeps of one message

// QR code of `text` as { n, bits }: n modules per side, bits = dark modules
// row by row, MSB first. Error correction L = the smallest matrix (61 modules
// for WhatsApp's pairing data). Drawn by the page only: at 1 px per module on
// the 64-row OLED a phone camera cannot read it.
export function qrMatrix(text) {
  const q = qrcode(0, 'L');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  const bits = Buffer.alloc(Math.ceil((n * n) / 8));
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (!q.isDark(r, c)) continue;
      const i = r * n + c;
      bits[i >> 3] |= 0x80 >> (i & 7);
    }
  }
  return { n, bits };
}

// Emoji and other pictographs cannot be drawn by the displays; variation
// selectors, joiners and skin tones travel with them.
const PICTO = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/gu;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g;

// One line of plain text: no emoji, no control characters, single spaces.
export function plainLine(s) {
  if (typeof s !== 'string') return '';
  return s.replace(PICTO, ' ').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

// Cut to `max` characters (code points), ending with "..." when shortened.
export function shorten(s, max) {
  const cp = [...s];
  if (cp.length <= max) return s;
  return cp.slice(0, Math.max(0, max - 3)).join('').trimEnd() + '...';
}

// { from, text } for the node's displays, or null when nothing printable is left.
export function displayMessage(name, text) {
  const body = plainLine(text);
  if (!body) return null;
  return { from: shorten(plainLine(name) || 'WhatsApp', DISPLAY_NAME_MAX), text: shorten(body, DISPLAY_TEXT_MAX) };
}

// WhatsApp wraps the real content in several envelopes.
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage', 'groupMentionedMessage', 'botInvokeMessage', 'associatedChildMessage'];

export function unwrap(message) {
  let m = message;
  for (let i = 0; i < 6 && m; i += 1) {
    const w = WRAPPERS.find((k) => m[k]?.message);
    if (!w) break;
    m = m[w].message;
  }
  return m || null;
}

const str = (v) => (typeof v === 'string' ? v : '');

// What a received message says: { kind, text } or null for the ones that are
// not content (reactions, receipts, key exchanges, edits/deletes, polls votes).
export function describeMessage(message) {
  const m = unwrap(message);
  if (!m) return null;
  const tag = (label, extra) => (plainLine(extra) ? `[${label}] ${str(extra)}` : `[${label}]`);
  if (str(m.conversation)) return { kind: 'text', text: m.conversation };
  if (str(m.extendedTextMessage?.text)) return { kind: 'text', text: m.extendedTextMessage.text };
  if (m.imageMessage) return { kind: 'image', text: tag('imagem', m.imageMessage.caption) };
  if (m.videoMessage || m.ptvMessage) return { kind: 'video', text: tag('vídeo', m.videoMessage?.caption) };
  if (m.audioMessage) return { kind: 'audio', text: m.audioMessage.ptt ? '[mensagem de voz]' : '[áudio]' };
  if (m.documentMessage) return { kind: 'document', text: tag('documento', m.documentMessage.caption || m.documentMessage.fileName) };
  if (m.stickerMessage) return { kind: 'sticker', text: '[figurinha]' };
  if (m.locationMessage || m.liveLocationMessage) return { kind: 'location', text: tag('localização', m.locationMessage?.name) };
  if (m.contactMessage) return { kind: 'contact', text: tag('contato', m.contactMessage.displayName) };
  if (m.contactsArrayMessage) return { kind: 'contact', text: tag('contatos', m.contactsArrayMessage.displayName) };
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3;
  if (poll) return { kind: 'poll', text: tag('enquete', poll.name) };
  if (str(m.buttonsResponseMessage?.selectedDisplayText)) return { kind: 'text', text: m.buttonsResponseMessage.selectedDisplayText };
  if (str(m.listResponseMessage?.title)) return { kind: 'text', text: m.listResponseMessage.title };
  if (str(m.templateButtonReplyMessage?.selectedDisplayText)) return { kind: 'text', text: m.templateButtonReplyMessage.selectedDisplayText };
  if (m.eventMessage) return { kind: 'event', text: tag('evento', m.eventMessage.name) };
  return null;
}

// Digits of a phone number as a comparison key. Brazilian mobiles appear with
// or without the 9th digit depending on when the WhatsApp account was created.
export function phoneKey(number) {
  const d = String(number || '').replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `55${d.slice(2, 4)}${d.slice(-8)}`;
  return d;
}

// +55 (11) 98888-7777 for Brazil, +<digits> otherwise, '' when unknown.
export function formatNumber(number) {
  const d = String(number || '').replace(/\D/g, '');
  if (!d) return '';
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(d);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : `+${d}`;
}
