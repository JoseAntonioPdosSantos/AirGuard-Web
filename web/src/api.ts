// API client. The access code arrives in the link after "#k=" (the fragment
// is never sent to the server in the request line, logs or Referer). It is
// kept in localStorage so the app also opens from the home-screen icon, and
// removed from the address bar right away.

const KEY = 'airguard.accessCode';
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

export function takeCodeFromUrl(): string | null {
  const m = /[#&]k=([A-Za-z0-9_-]{43})/.exec(window.location.hash);
  let code = m ? m[1] : null;
  if (code) {
    try { localStorage.setItem(KEY, code); } catch { /* private mode: keep in memory */ }
    history.replaceState(null, '', window.location.pathname);
  } else {
    try { code = localStorage.getItem(KEY); } catch { code = null; }
  }
  return code && CODE_RE.test(code) ? code : null;
}

export function forgetCode() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export interface Contact {
  id: string;
  name: string;
  phone: string;
  phoneDisplay: string;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function call<T>(code: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${code}`, ...(init.headers || {}) },
  });
  if (r.status === 204) return undefined as T;
  let body: unknown = null;
  try { body = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new ApiError(r.status, (body as { error?: string } | null)?.error || 'http_' + r.status);
  return body as T;
}

export const api = {
  me: (c: string) => call<{ name: string }>(c, '/api/me'),
  list: (c: string) => call<Contact[]>(c, '/api/contacts'),
  add: (c: string, name: string, phone: string) =>
    call<Contact>(c, '/api/contacts', { method: 'POST', body: JSON.stringify({ name, phone }) }),
  remove: (c: string, id: string) => call<void>(c, `/api/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export function errorText(e: unknown): string {
  const code = e instanceof ApiError ? e.code : 'network';
  switch (code) {
    case 'invalid_name': return 'Informe um nome (até 40 caracteres).';
    case 'invalid_phone': return 'Número inválido. Use DDD + número, ex.: (11) 98888-7777.';
    case 'duplicate_phone': return 'Esse número já está cadastrado.';
    case 'limit_reached': return 'Limite de 100 contatos atingido.';
    case 'too_many_attempts': return 'Muitas tentativas. Aguarde um minuto.';
    case 'invalid_code': return 'Código de acesso inválido.';
    default: return 'Sem conexão com o servidor AirGuard.';
  }
}
