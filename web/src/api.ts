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
  category: string;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function call<T>(code: string, path: string, init: RequestInit = {}, password?: string): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${code}`,
      ...(password !== undefined ? { 'x-edit-password': password } : {}),
      ...(init.headers || {}),
    },
  });
  if (r.status === 204) return undefined as T;
  let body: unknown = null;
  try { body = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new ApiError(r.status, (body as { error?: string } | null)?.error || 'http_' + r.status);
  return body as T;
}

export interface ContactInput { name: string; phone: string; category: string }

// Adding, editing and deleting need the user's edit password (header X-Edit-Password).
// It is kept only in memory: asked again after the page is reloaded.
export const api = {
  me: (c: string) => call<{ name: string; hasPassword: boolean }>(c, '/api/me'),
  list: (c: string) => call<Contact[]>(c, '/api/contacts'),
  add: (c: string, pw: string, v: ContactInput) =>
    call<Contact>(c, '/api/contacts', { method: 'POST', body: JSON.stringify(v) }, pw),
  update: (c: string, pw: string, id: string, v: ContactInput) =>
    call<Contact>(c, `/api/contacts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(v) }, pw),
  remove: (c: string, pw: string, id: string) =>
    call<void>(c, `/api/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }, pw),
  checkPassword: (c: string, pw: string) => call<void>(c, '/api/password/check', { method: 'POST' }, pw),
  setPassword: (c: string, password: string, current?: string) =>
    call<void>(c, '/api/password', { method: 'POST', body: JSON.stringify({ password, current }) }),
};

export function errorText(e: unknown): string {
  const code = e instanceof ApiError ? e.code : 'network';
  switch (code) {
    case 'invalid_name': return 'Informe um nome (até 40 caracteres).';
    case 'invalid_phone': return 'Número inválido. Use DDD + número, ex.: (11) 98888-7777.';
    case 'invalid_category': return 'Categoria inválida.';
    case 'duplicate_phone': return 'Esse número já está cadastrado.';
    case 'limit_reached': return 'Limite de 100 contatos atingido.';
    case 'too_many_attempts': return 'Muitas tentativas. Aguarde um minuto.';
    case 'invalid_code': return 'Código de acesso inválido.';
    case 'wrong_password': return 'Senha incorreta.';
    case 'invalid_password': return 'A senha precisa ter de 4 a 64 caracteres.';
    case 'password_not_set': return 'Crie uma senha primeiro.';
    case 'not_found': return 'Contato não encontrado (já foi excluído?).';
    default: return 'Sem conexão com o servidor AirGuard.';
  }
}
