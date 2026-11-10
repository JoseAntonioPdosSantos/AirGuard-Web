// Telemetry API client: snapshot, history and the live stream (Server-Sent
// Events read with fetch, so the access code goes in the Authorization header
// and never in the URL).
import { ApiError } from './api';

export type Sev = 'NORMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
export type RangeId = '1h' | '6h' | '24h' | '7d' | '30d';

export interface Limits { gasMedium: number; gasHigh: number; tempLow: number; tempHigh: number; humLow: number; humHigh: number }
export interface Levels { air: Sev; temp: Sev; hum: Sev; sys: Sev }

export interface Current {
  t: number; via: 'node';
  temp: number | null; hum: number | null; hi?: number | null; gas: number | null;
  levels: Levels | null; overall?: Sev | null;
  airState?: string | null; envState?: string | null; relay?: boolean; sim?: boolean;
}

export interface Packet {
  key: number; t: number;
  from: 'node' | 'gw' | '?';
  type: string; ref: number | null;
  try?: number; retry?: boolean; len?: number | null;
  tx: { t: number; airtime: number | null; ok: boolean | null } | null;
  rx: { t: number | null; rssi: number | null; snr: number | null; res?: string | null } | null;
  acked?: number; latency?: number; dup?: boolean;
  status?: 'failed' | 'txerror' | 'invalid' | 'foreign' | 'other' | 'lost';
  frame?: string | null; note?: string | null;
}

export interface Alert { t: number; id: number | null; type: string | null; cat: string | null; sev: string | null; prev: string | null }

export interface Status {
  now: number;
  limits: Limits;
  current: Current | null;
  node: { online: boolean; lastSeen: number | null; boot: { t: number; fw: string | null; boot: number | null } | null };
  gateway: {
    online: boolean; lastSeen: number | null;
    stat: { t: number; lcd: boolean; lora: boolean; lost: boolean; hbs: number | null; miss: number | null; up: number | null } | null;
  };
  link: {
    rssi: number | null; snr: number | null; hbReceived: number; hbLost: number; lossPct: number | null;
    txCount: number; ackCount: number; failCount: number; ackLatencyMs: number | null;
  };
}
export interface State extends Status { packets: Packet[]; alerts: Alert[] }

export interface Point {
  t: number;
  temp: number | null; tempMin: number | null; tempMax: number | null;
  hum: number | null; humMin: number | null; humMax: number | null;
  gas: number | null; gasMax: number | null;
  rssi: number | null; snr: number | null; loss: number | null;
}
export interface History { range: RangeId; from: number; to: number; step: number; points: Point[]; alerts: Alert[]; limits: Limits }

export interface EnvSample { t: number; temp: number | null; hum: number | null; gas: number | null; via: string }

async function get<T>(code: string, path: string): Promise<T> {
  const r = await fetch(path, { headers: { authorization: `Bearer ${code}` } });
  if (!r.ok) throw new ApiError(r.status, 'http_' + r.status);
  return r.json() as Promise<T>;
}

export const tlmApi = {
  state: (c: string) => get<State>(c, '/api/telemetry/state'),
  history: (c: string, range: RangeId) => get<History>(c, `/api/telemetry/history?range=${range}`),
};

export type StreamEvent =
  | { type: 'status'; data: Status }
  | { type: 'env'; data: EnvSample }
  | { type: 'packet'; data: Packet }
  | { type: 'alert'; data: Alert }
  | { type: string; data: unknown };

// Reads the stream until `signal` aborts; reconnects after an error.
export async function stream(code: string, onEvent: (e: StreamEvent) => void, onConn: (ok: boolean) => void, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const r = await fetch('/api/telemetry/stream', { headers: { authorization: `Bearer ${code}` }, signal });
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
          if (data) { try { onEvent({ type, data: JSON.parse(data) }); } catch { /* bad block */ } }
        }
      }
    } catch { /* network error or abort */ }
    if (signal.aborted) return;
    onConn(false);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---- presentation helpers ------------------------------------------------------
export const SEV_INFO: Record<Sev, { label: string; color: string }> = {
  NORMAL: { label: 'Normal', color: '#0ca30c' },
  LOW: { label: 'Baixo', color: '#fab219' },
  MEDIUM: { label: 'Médio', color: '#ec835a' },
  HIGH: { label: 'Alto', color: '#d03b3b' },
};
export const sevOf = (s: string | null | undefined): Sev => (s && s in SEV_INFO ? (s as Sev) : 'NORMAL');

export const CAT_LABEL: Record<string, string> = {
  AIR_QUALITY: 'Gás', TEMPERATURE: 'Temperatura', HUMIDITY: 'Umidade', SYSTEM: 'Sistema',
};

export const TYPE_LABEL: Record<string, string> = {
  HB: 'Sinal de vida', ALERT: 'Alerta', RECOVERY: 'Normalizado', ACK: 'Confirmação', STAT: 'Status do receptor', TEXT: 'Mensagem', 'INVÁLIDO': 'Inválido',
};

export function fmtTime(t: number, withSeconds = true) {
  return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) });
}
export function fmtDay(t: number) {
  return new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
export function ago(t: number | null | undefined, now: number) {
  if (!t) return 'nunca';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return 'agora';
  if (s < 60) return `há ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `há ${h} h` : `em ${fmtDay(t)}`;
}
export const num = (v: number | null | undefined, d = 1) => (v == null ? '–' : v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
