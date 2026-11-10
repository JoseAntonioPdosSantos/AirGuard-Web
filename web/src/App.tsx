import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, errorText, forgetCode, takeCodeFromUrl, ApiError, type Contact, type ContactInput } from './api';
import { CATEGORIES, CategoryIcon, categoryOf, type CategoryId } from './categories';

type Phase = 'loading' | 'denied' | 'ready';
// create = first time (no password yet), enter = unlock editing, change = new password
type PwMode = 'create' | 'enter' | 'change';

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
  const [filter, setFilter] = useState<CategoryId | null>(null);
  const [sheet, setSheet] = useState<{ edit: Contact | null } | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [hasPw, setHasPw] = useState(false);
  // Edit password, only in memory (asked again after a reload).
  const [pw, setPw] = useState<string | null>(null);
  const [pwSheet, setPwSheet] = useState<{ mode: PwMode; then?: (pw: string) => void } | null>(null);

  const notify = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const load = useCallback(async () => {
    if (!code) return;
    try {
      const [me, list] = await Promise.all([api.me(code), api.list(code)]);
      setUser(me.name);
      setHasPw(me.hasPassword);
      setContacts(list);
      setPhase('ready');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { forgetCode(); setPhase('denied'); }
      else { setPhase('ready'); notify(errorText(e), 'err'); }
    }
  }, [code, notify]);

  useEffect(() => { void load(); }, [load]);

  // categories that have at least one contact, in the fixed order, with counts
  const used = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of contacts) n.set(categoryOf(c.category).id, (n.get(categoryOf(c.category).id) || 0) + 1);
    return CATEGORIES.filter((k) => n.has(k.id)).map((k) => ({ ...k, count: n.get(k.id)! }));
  }, [contacts]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qd = q.replace(/\D/g, '');
    return contacts.filter((c) => {
      const cat = categoryOf(c.category);
      if (filter && cat.id !== filter) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || cat.label.toLowerCase().includes(q) || (qd && c.phone.includes(qd));
    });
  }, [contacts, query, filter]);

  // drop a filter whose last contact was removed
  useEffect(() => { if (filter && !used.some((k) => k.id === filter)) setFilter(null); }, [filter, used]);

  // Runs `fn` with the edit password, asking for it (or to create one) first.
  function withPw(fn: (pw: string) => void) {
    if (pw) fn(pw);
    else setPwSheet({ mode: hasPw ? 'enter' : 'create', then: fn });
  }

  // A password refused by the server (changed on another phone): forget it.
  function failed(e: unknown) {
    if (e instanceof ApiError && (e.code === 'wrong_password' || e.code === 'password_not_set')) {
      setPw(null);
      if (e.code === 'password_not_set') setHasPw(false);
    }
    notify(errorText(e), 'err');
  }

  async function remove(id: string, password: string) {
    if (!code) return;
    try {
      await api.remove(code, password, id);
      setContacts((l) => l.filter((c) => c.id !== id));
      notify('Contato removido');
    } catch (e) { failed(e); }
    setConfirmId(null);
  }

  // Throws the API error so the sheet can show it next to the fields.
  async function save(v: ContactInput, edit: Contact | null) {
    if (!code || !pw) throw new ApiError(403, 'wrong_password');
    try {
      const c = edit ? await api.update(code, pw, edit.id, v) : await api.add(code, pw, v);
      setContacts((l) => [...l.filter((x) => x.id !== c.id), c].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')));
      setSheet(null);
      notify(edit ? 'Contato atualizado' : 'Contato cadastrado');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'wrong_password') { setPw(null); setSheet(null); }
      throw e;
    }
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
            <p className="sub">CONTATOS ÚTEIS</p>
          </div>
        </div>
        <button className="user" title={hasPw ? 'Trocar a senha de edição' : 'Criar a senha de edição'}
          onClick={() => setPwSheet({ mode: hasPw ? 'change' : 'create' })}>
          <span className={`dot ${pw ? '' : 'locked'}`} />
          <span className="uname">{user || '···'}</span>
          <svg className="key" viewBox="0 0 24 24" aria-hidden><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M15 8l2 2" /></svg>
        </button>
      </header>

      <section className="hud">
        <div className="stat">
          <span className="num">{String(contacts.length).padStart(2, '0')}</span>
          <span className="lbl">contatos</span>
        </div>
        <div className="stat">
          <span className="num">{String(used.length).padStart(2, '0')}</span>
          <span className="lbl">categorias</span>
        </div>
        <div className="stat">
          <span className="num">100</span>
          <span className="lbl">limite</span>
        </div>
      </section>

      <div className="search">
        <svg viewBox="0 0 24 24" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input
          placeholder="Buscar nome, serviço ou número"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Buscar contatos"
        />
      </div>

      {used.length > 1 && (
        <nav className="filters" aria-label="Filtrar por categoria">
          <button className={`fchip ${filter === null ? 'on' : ''}`} onClick={() => setFilter(null)}>Todos</button>
          {used.map((k) => (
            <button key={k.id} className={`fchip ${filter === k.id ? 'on' : ''}`} style={{ ['--c' as string]: k.color }}
              onClick={() => setFilter(filter === k.id ? null : k.id)} aria-pressed={filter === k.id}>
              <CategoryIcon id={k.id} />{k.label}<span className="fcount">{k.count}</span>
            </button>
          ))}
        </nav>
      )}

      <main className="list">
        {phase === 'loading' && <div className="skeleton" />}
        {phase === 'ready' && shown.length === 0 && (
          <div className="empty">
            <div className="ring" />
            <p>{contacts.length ? 'Nenhum contato encontrado.' : 'Nenhum contato ainda.'}</p>
            {!contacts.length && <p className="hint">Toque em <b>+</b> para guardar farmácia, gás, médico, marido de aluguel e outros números úteis.</p>}
          </div>
        )}
        {shown.map((c, i) => {
          const cat = categoryOf(c.category);
          return (
          <article key={c.id} className="card" style={{ animationDelay: `${i * 40}ms`, ['--c' as string]: cat.color }}>
            <div className={`avatar ${cat.id === 'outro' ? '' : 'svc'}`} title={cat.label}>
              {cat.id === 'outro' ? initials(c.name) : <CategoryIcon id={cat.id} />}
            </div>
            <button className="info" onClick={() => withPw(() => setSheet({ edit: c }))} aria-label={`Editar ${c.name}`}>
              <h2>{c.name}</h2>
              <p className="meta">
                <span className="tag">{cat.label}</span>
                <span className="edit-hint" aria-hidden>
                  <svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>
                </span>
              </p>
              <p className="phone">{c.phoneDisplay.replace(/^\+55 /, '')}</p>
            </button>
            {confirmId === c.id ? (
              <div className="confirm">
                <button className="chip danger" onClick={() => withPw((p) => void remove(c.id, p))}>Excluir</button>
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
          );
        })}
      </main>

      <button className="fab" onClick={() => withPw(() => setSheet({ edit: null }))} aria-label="Cadastrar contato">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
      </button>

      {sheet && code && (
        <ContactSheet edit={sheet.edit} onClose={() => setSheet(null)} onSave={(v) => save(v, sheet.edit)} />
      )}

      {pwSheet && code && (
        <PasswordSheet
          code={code}
          mode={pwSheet.mode}
          onClose={() => setPwSheet(null)}
          onDone={(p) => {
            const then = pwSheet.then;
            if (pwSheet.mode !== 'enter') notify(pwSheet.mode === 'create' ? 'Senha criada' : 'Senha alterada');
            setHasPw(true);
            setPw(p);
            setPwSheet(null);
            then?.(p);
          }}
        />
      )}

      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
    </div>
  );
}

function ContactSheet({ edit, onClose, onSave }: { edit: Contact | null; onClose: () => void; onSave: (v: ContactInput) => Promise<void> }) {
  const [name, setName] = useState(edit?.name ?? '');
  // editing: show the number the way people type it, e.g. (11) 98888-7777
  const [phone, setPhone] = useState(edit ? edit.phoneDisplay.replace(/^\+55 /, '') : '');
  const [category, setCategory] = useState<CategoryId>(edit ? categoryOf(edit.category).id : 'farmacia');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const unchanged = !!edit && name.trim() === edit.name && phone === edit.phoneDisplay.replace(/^\+55 /, '') && category === categoryOf(edit.category).id;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try { await onSave({ name, phone, category }); }
    catch (err) { setError(errorText(err)); setBusy(false); }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <form className="sheet" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <h3>{edit ? 'EDITAR CONTATO' : 'NOVO CONTATO'}</h3>
        <fieldset className="cats">
          <legend>Serviço</legend>
          <div className="cat-grid" role="radiogroup">
            {CATEGORIES.map((k) => (
              <button type="button" key={k.id} role="radio" aria-checked={category === k.id}
                className={`cat ${category === k.id ? 'on' : ''}`} style={{ ['--c' as string]: k.color }}
                onClick={() => setCategory(k.id)}>
                <CategoryIcon id={k.id} />
                <span>{k.label}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <label>
          <span>Nome</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required
            placeholder={`Ex.: ${category === 'outro' ? 'Maria (vizinha)' : categoryOf(category).label + ' do bairro'}`} />
        </label>
        <label>
          <span>Telefone</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" required placeholder="(11) 98888-7777" maxLength={32} />
        </label>
        {error && <p className="err">{error}</p>}
        <div className="row">
          <button type="button" className="ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" disabled={busy || unchanged || !name.trim() || !phone.trim()}>
            {busy ? 'Salvando…' : edit ? 'Salvar' : 'Cadastrar'}
          </button>
        </div>
      </form>
    </div>
  );
}

function PasswordSheet({ code, mode, onClose, onDone }: { code: string; mode: PwMode; onClose: () => void; onDone: (pw: string) => void }) {
  const [current, setCurrent] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [show, setShow] = useState(false);
  const creating = mode !== 'enter';
  const tooShort = creating && [...p1].length < 4;
  const mismatch = creating && p2.length > 0 && p1 !== p2;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (creating && p1 !== p2) { setError('As senhas não conferem.'); return; }
    setBusy(true);
    try {
      if (mode === 'enter') await api.checkPassword(code, p1);
      else await api.setPassword(code, p1, mode === 'change' ? current : undefined);
      onDone(p1);
    } catch (err) { setError(errorText(err)); setBusy(false); }
  }

  const type = show ? 'text' : 'password';
  return (
    <div className="overlay" onClick={onClose}>
      <form className="sheet" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <h3>{mode === 'create' ? 'CRIAR SENHA' : mode === 'change' ? 'TROCAR SENHA' : 'SENHA'}</h3>
        <p className="hint pw-hint">
          {mode === 'create' && 'Crie uma senha para proteger seus contatos. Ela será pedida para cadastrar, editar ou excluir.'}
          {mode === 'enter' && 'Digite sua senha para cadastrar, editar ou excluir contatos.'}
          {mode === 'change' && 'Informe a senha atual e escolha uma nova.'}
        </p>
        {mode === 'change' && (
          <label>
            <span>Senha atual</span>
            <input type={type} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" maxLength={64} required autoFocus />
          </label>
        )}
        <label>
          <span>{creating ? 'Nova senha' : 'Senha'}</span>
          <input type={type} value={p1} onChange={(e) => setP1(e.target.value)} maxLength={64} required autoFocus={mode !== 'change'}
            autoComplete={creating ? 'new-password' : 'current-password'} placeholder={creating ? 'mínimo 4 caracteres' : ''} />
        </label>
        {creating && (
          <label>
            <span>Repita a nova senha</span>
            <input type={type} value={p2} onChange={(e) => setP2(e.target.value)} maxLength={64} required autoComplete="new-password" />
          </label>
        )}
        <label className="show-pw">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          <span>Mostrar senha</span>
        </label>
        {mismatch && !error && <p className="err">As senhas não conferem.</p>}
        {error && <p className="err">{error}</p>}
        <div className="row">
          <button type="button" className="ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" disabled={busy || !p1 || tooShort || mismatch || (creating && !p2) || (mode === 'change' && !current)}>
            {busy ? 'Verificando…' : mode === 'enter' ? 'Desbloquear' : 'Salvar senha'}
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
