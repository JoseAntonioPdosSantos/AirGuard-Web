import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, errorText, forgetCode, takeCodeFromUrl, ApiError, type Contact } from './api';

type Phase = 'loading' | 'denied' | 'ready';

function initials(name: string) {
  // letters only: "Maria (vizinha)" -> "MV"
  const p = name.replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '#';
  return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

function waLink(e164: string) {
  return `https://wa.me/${e164.replace(/\D/g, '')}`;
}

export default function App() {
  const [code] = useState(() => takeCodeFromUrl());
  const [phase, setPhase] = useState<Phase>(code ? 'loading' : 'denied');
  const [user, setUser] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const notify = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const load = useCallback(async () => {
    if (!code) return;
    try {
      const [me, list] = await Promise.all([api.me(code), api.list(code)]);
      setUser(me.name);
      setContacts(list);
      setPhase('ready');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { forgetCode(); setPhase('denied'); }
      else { setPhase('ready'); notify(errorText(e), 'err'); }
    }
  }, [code, notify]);

  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    const qd = q.replace(/\D/g, '');
    return contacts.filter((c) => c.name.toLowerCase().includes(q) || (qd && c.phone.includes(qd)));
  }, [contacts, query]);

  async function remove(id: string) {
    if (!code) return;
    try {
      await api.remove(code, id);
      setContacts((l) => l.filter((c) => c.id !== id));
      notify('Contato removido');
    } catch (e) { notify(errorText(e), 'err'); }
    setConfirmId(null);
  }

  if (phase === 'denied') return <Denied />;

  return (
    <div className="app">
      <div className="bg" aria-hidden />
      <header className="top">
        <div className="brand">
          <img src="/icon.svg" alt="" className="logo" />
          <div>
            <h1>AIRGUARD</h1>
            <p className="sub">CONTATOS DE EMERGÊNCIA</p>
          </div>
        </div>
        <div className="user" title="Usuário conectado">
          <span className="dot" />
          <span className="uname">{user || '···'}</span>
        </div>
      </header>

      <section className="hud">
        <div className="stat">
          <span className="num">{String(contacts.length).padStart(2, '0')}</span>
          <span className="lbl">contatos</span>
        </div>
        <div className="stat">
          <span className="num">{phase === 'loading' ? '··' : 'ON'}</span>
          <span className="lbl">sincronizado</span>
        </div>
        <div className="stat">
          <span className="num">100</span>
          <span className="lbl">limite</span>
        </div>
      </section>

      <div className="search">
        <svg viewBox="0 0 24 24" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input
          placeholder="Buscar nome ou número"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Buscar contatos"
        />
      </div>

      <main className="list">
        {phase === 'loading' && <div className="skeleton" />}
        {phase === 'ready' && shown.length === 0 && (
          <div className="empty">
            <div className="ring" />
            <p>{contacts.length ? 'Nenhum contato encontrado.' : 'Nenhum contato ainda.'}</p>
            {!contacts.length && <p className="hint">Toque em <b>+</b> para cadastrar quem deve ser avisado.</p>}
          </div>
        )}
        {shown.map((c, i) => (
          <article key={c.id} className="card" style={{ animationDelay: `${i * 40}ms` }}>
            <div className="avatar">{initials(c.name)}</div>
            <div className="info">
              <h2>{c.name}</h2>
              <p className="phone">{c.phoneDisplay}</p>
            </div>
            {confirmId === c.id ? (
              <div className="confirm">
                <button className="chip danger" onClick={() => void remove(c.id)}>Excluir</button>
                <button className="chip" onClick={() => setConfirmId(null)}>Cancelar</button>
              </div>
            ) : (
              <div className="actions">
                <a className="icon-btn" href={`tel:${c.phone}`} aria-label={`Ligar para ${c.name}`}>
                  <svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>
                </a>
                <a className="icon-btn" href={waLink(c.phone)} target="_blank" rel="noreferrer noopener" aria-label={`WhatsApp de ${c.name}`}>
                  <svg viewBox="0 0 24 24"><path d="M4 20l1.3-3.9A8 8 0 1 1 8 19.2z" /><path d="M9 9.5c.5 2 2.5 4 4.5 4.5l1-1.2 2 1-.5 1.6c-3.5.2-7.6-3.9-7.4-7.4l1.6-.5 1 2z" /></svg>
                </a>
                <button className="icon-btn del" onClick={() => setConfirmId(c.id)} aria-label={`Excluir ${c.name}`}>
                  <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
                </button>
              </div>
            )}
          </article>
        ))}
      </main>

      <button className="fab" onClick={() => setSheet(true)} aria-label="Cadastrar contato">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
      </button>

      {sheet && code && (
        <AddSheet
          code={code}
          onClose={() => setSheet(false)}
          onAdded={(c) => {
            setContacts((l) => [...l, c].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')));
            setSheet(false);
            notify('Contato cadastrado');
          }}
        />
      )}

      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
    </div>
  );
}

function AddSheet({ code, onClose, onAdded }: { code: string; onClose: () => void; onAdded: (c: Contact) => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try { onAdded(await api.add(code, name, phone)); }
    catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <form className="sheet" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <h3>NOVO CONTATO</h3>
        <label>
          <span>Nome / contato</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="name" required autoFocus placeholder="Ex.: Maria (vizinha)" />
        </label>
        <label>
          <span>Telefone</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" required placeholder="(11) 98888-7777" maxLength={32} />
        </label>
        {error && <p className="err">{error}</p>}
        <div className="row">
          <button type="button" className="ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" disabled={busy || !name.trim() || !phone.trim()}>
            {busy ? 'Salvando…' : 'Cadastrar'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Denied() {
  return (
    <div className="app denied">
      <div className="bg" aria-hidden />
      <div className="lock">
        <svg viewBox="0 0 24 24" aria-hidden><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
      </div>
      <h1>ACESSO RESTRITO</h1>
      <p>Abra esta página pelo <b>link pessoal</b> que você recebeu.</p>
      <p className="hint">O código de acesso é único para cada pessoa. Peça um novo ao administrador do AirGuard se você o perdeu.</p>
    </div>
  );
}
