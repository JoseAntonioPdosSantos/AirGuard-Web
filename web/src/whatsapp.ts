// WhatsApp page: API client and live stream (same pattern as telemetry.ts: the
// access code goes in the Authorization header, never in the URL).
import { ApiError } from './api';

export type LinkState = 'idle' | 'connecting' | 'qr' | 'code' | 'open';

export interface Link {
  state: LinkState;
  linked: boolean;                                   // a session is saved on the server
  me: { number: string; name: string } | null;
  since: number | null;
  error: string | null;
  qr: { n: number; bits: string; ttl: number; expiresAt: number } | null;       // pairing by QR (this page only)
  code: { code: string; ttl: number; expiresAt: number } | null;                // pairing by code (also on the OLED)
  pairNumber: string | null;                         // number saved for the pairing code (digits)
}

export interface NodeInfo { device: string; online: boolean; lastSeen: number | null; levels: number[] | null; relay: boolean; alert: boolean }

export interface WaMessage {
  id: number; t: number; at: number; chat: string; group: boolean;
  number: string; numberDisplay: string; name: string; kind: string; text: string;
  // where the name comes from: AirGuard contact, the phone's address book, the sender's own profile, or none
  nameFrom?: 'airguard' | 'phone' | 'profile' | 'number';
  node: 'sent' | 'offline' | 'old' | 'empty' | 'none';
  result: string | null;                             // what the node did: shown | queued | ignored | full | empty
}

export interface Notice {
  id: number; t: number; device: string; kind: 'alert' | 'recovery' | 'relay'; text: string;
  status: 'queued' | 'sent' | 'dropped'; sentAt: number | null; reason: string | null;
}

export interface View { now: number; link: Link; groups: boolean; nodes: NodeInfo[]; messages: WaMessage[]; notices: Notice[] }

async function post<T>(code: string, password: string, path: string, send?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${code}`, 'x-edit-password': password, ...(send === undefined ? {} : { 'content-type': 'application/json' }) },
    body: send === undefined ? undefined : JSON.stringify(send),
  });
  if (r.status === 204) return undefined as T;
  let body: unknown = null;
  try { body = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new ApiError(r.status, (body as { error?: string } | null)?.error || 'http_' + r.status);
  return body as T;
}

export const waApi = {
  // phone: the number of the WhatsApp account -> pairing with the 8-character
  // code; without it -> pairing with a QR code on this page
  connect: (c: string, pw: string, phone?: string) => post<{ result: string }>(c, pw, '/api/whatsapp/connect', phone ? { phone } : undefined),
  disconnect: (c: string, pw: string) => post<void>(c, pw, '/api/whatsapp/disconnect'),
};

export type WaEvent =
  | { type: 'init'; data: View }
  | { type: 'link'; data: Link }
  | { type: 'node'; data: NodeInfo[] }
  | { type: 'message'; data: WaMessage }
  | { type: 'notice'; data: Notice }
  | { type: 'now'; data: { now: number } };

// Reads the stream until `signal` aborts; reconnects after an error. Every
// (re)connection starts with an "init" event holding the whole picture.
export async function waStream(code: string, onEvent: (e: WaEvent) => void, onConn: (ok: boolean) => void, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const r = await fetch('/api/whatsapp/stream', { headers: { authorization: `Bearer ${code}` }, signal });
      if (r.status === 404) { onConn(false); return; }  // WhatsApp link turned off on the server
      if (!r.ok || !r.body) throw new Error('http_' + r.status);
      onConn(true);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let type = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) { try { onEvent({ type, data: JSON.parse(data) } as WaEvent); } catch { /* bad block */ } }
        }
      }
    } catch { /* network error or abort */ }
    if (signal.aborted) return;
    onConn(false);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// Dark modules of a QR sent as base64 bits (row by row, MSB first) -> SVG path.
export function qrPath(n: number, bitsB64: string): string {
  let bin: string;
  try { bin = atob(bitsB64); } catch { return ''; }
  let d = '';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      const i = r * n + c;
      if ((bin.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1) {
        // merge a horizontal run of dark modules into one rectangle
        let w = 1;
        while (c + w < n) {
          const j = r * n + c + w;
          if (!((bin.charCodeAt(j >> 3) >> (7 - (j & 7))) & 1)) break;
          w += 1;
        }
        d += `M${c} ${r}h${w}v1h-${w}z`;
        c += w - 1;
      }
    }
  }
  return d;
}
