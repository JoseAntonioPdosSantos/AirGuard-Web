// "WhatsApp" page: the WhatsApp account linked to AirGuard (connect with the
// 8-character code that is also on the AirGuard display, or with a QR code
// here; disconnect, ask for a new connection), the messages received, live,
// with what happened to each one on the AirGuard displays, and the alert
// messages AirGuard sent to the account's own number.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from './api';
import { fmtTime } from './telemetry';
import { qrPath, waApi, waStream, type Link, type NodeInfo, type Notice, type View, type WaMessage } from './whatsapp';

interface Props {
  code: string;
  // runs fn with the edit password, asking for it first when needed (App)
  withPw: (fn: (pw: string) => void) => void;
  onError: (e: unknown) => void;
  notify: (text: string, kind?: 'ok' | 'err') => void;
}

const C_OK = '#0ca30c', C_WAIT = '#22e4ff', C_WARN = '#fab219', C_OFF = '#7d8aa6';

function waNumber(n: string) {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(n);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : n ? `+${n}` : '';
}

function dayTime(t: number) {
  const d = new Date(t);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? fmtTime(t, false) : `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${fmtTime(t, false)}`;
}

function initials(name: string) {
  const p = name.replace(/[^\p{L}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '#';
  return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

const WHY_IDLE: Record<string, string> = {
  qr_timeout: 'O código expirou sem ser lido.',
  code_timeout: 'O código expirou sem ser digitado no celular.',
  code_failed: 'O WhatsApp não gerou o código. Confira o número e tente de novo.',
  logged_out: 'A conexão foi removida no celular (Dispositivos conectados).',
  bad_session: 'A sessão salva deixou de valer. Conecte de novo.',
  forbidden: 'O WhatsApp recusou a conexão desta conta.',
  connection_failed: 'Não foi possível falar com o WhatsApp. Verifique a internet do servidor.',
  library: 'O servidor não conseguiu iniciar a conexão com o WhatsApp.',
};

// What happened to a received message on the AirGuard displays.
function fate(m: WaMessage): { text: string; tone: 'ok' | 'wait' | 'warn' | 'muted' } {
  switch (m.result) {
    case 'shown': return { text: 'exibida no visor', tone: 'ok' };
    case 'queued': return { text: 'na fila do visor', tone: 'ok' };
    case 'ignored': return { text: 'ignorada: alerta ativo', tone: 'warn' };
    case 'full': return { text: 'não exibida: visor ocupado', tone: 'warn' };
    case 'empty': return { text: 'sem texto exibível', tone: 'muted' };
    default: break;
  }
  switch (m.node) {
    case 'sent': return { text: 'enviada ao AirGuard…', tone: 'wait' };
    case 'offline': return { text: 'AirGuard desligado', tone: 'muted' };
    case 'old': return { text: 'chegou com atraso', tone: 'muted' };
    case 'empty': return { text: 'sem texto exibível', tone: 'muted' };
    default: return { text: 'só registrada', tone: 'muted' };
  }
}

const NOTICE_KIND: Record<Notice['kind'], { label: string; color: string }> = {
  alert: { label: 'Alerta', color: '#ec835a' },
  recovery: { label: 'Normalizado', color: C_OK },
  relay: { label: 'Relé', color: C_WARN },
};

function noticeStatus(n: Notice): { text: string; tone: 'ok' | 'wait' | 'warn' } {
  if (n.status === 'sent') return { text: `enviado às ${fmtTime(n.sentAt ?? n.t)}`, tone: 'ok' };
  if (n.status === 'queued') return { text: 'aguardando o WhatsApp reconectar', tone: 'wait' };
  switch (n.reason) {
    case 'not_linked': return { text: 'não enviado: nenhum WhatsApp conectado', tone: 'warn' };
    case 'unlinked': return { text: 'não enviado: WhatsApp desconectado antes', tone: 'warn' };
    case 'too_old': return { text: 'não enviado: ficou velho demais na fila', tone: 'warn' };
    case 'restart': return { text: 'não enviado: o servidor reiniciou', tone: 'warn' };
    default: return { text: 'não enviado', tone: 'warn' };
  }
}

// WhatsApp marks bold as *text* and italic as _text_: show it as plain text.
const plain = (s: string) => s.replace(/\*([^*\n]+)\*/g, '$1').replace(/(^|\n)_([^\n]+)_(?=\n|$)/g, '$1$2');

export default function WhatsApp({ code, withPw, onError, notify }: Props) {
  const [link, setLink] = useState<Link | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [messages, setMessages] = useState<WaMessage[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [groups, setGroups] = useState(false);
  const [conn, setConn] = useState<boolean | null>(null);
  const [off, setOff] = useState(false);            // the server runs without the WhatsApp link
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState('');           // number of the account, for the pairing code
  const phoneTyped = useRef(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [chat, setChat] = useState<string | null>(null);
  const [openNotice, setOpenNotice] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const skew = useRef(0);                           // server clock - browser clock

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  useEffect(() => {
    const ctl = new AbortController();
    let got = false;
    void waStream(code, (e) => {
      got = true;
      switch (e.type) {
        case 'init': {
          const v: View = e.data;
          skew.current = v.now - Date.now();
          setLink(v.link); setNodes(v.nodes); setGroups(v.groups);
          setMessages(v.messages); setNotices(v.notices);
          break;
        }
        case 'link': setLink(e.data); break;
        case 'node': setNodes(e.data); break;
        case 'now': skew.current = e.data.now - Date.now(); break;
        case 'message':
          setMessages((l) => {
            const i = l.findIndex((x) => x.id === e.data.id);
            if (i >= 0) { const c = l.slice(); c[i] = e.data; return c; }
            return [...l.slice(-299), e.data];
          });
          break;
        case 'notice':
          setNotices((l) => {
            const i = l.findIndex((x) => x.id === e.data.id);
            if (i >= 0) { const c = l.slice(); c[i] = e.data; return c; }
            return [...l.slice(-59), e.data];
          });
          break;
        default: break;
      }
    }, setConn, ctl.signal)
      // the stream only ends by itself when the server has no WhatsApp link (404)
      .then(() => { if (!ctl.signal.aborted && !got) setOff(true); });
    return () => ctl.abort();
  }, [code]);

  const srvNow = now + skew.current;
  const state = link?.state ?? 'idle';

  // the number used last time comes back filled in, until the user types
  const saved = link?.pairNumber ?? '';
  useEffect(() => { if (saved && !phoneTyped.current) setPhone(waNumber(saved)); }, [saved]);

  // number given: pairing with the 8-character code; none: with a QR code here
  async function connect(pw: string, number?: string) {
    setBusy(true);
    try {
      const r = await waApi.connect(code, pw, number);
      if (r.result === 'linked') notify('O WhatsApp já está conectado');
      else if (r.result === 'reconnecting') notify('Tentando reconectar');
      else notify(number ? 'Pedindo o código ao WhatsApp…' : 'Gerando o QR code…');
    } catch (e) { fail(e); }
    setBusy(false);
  }

  async function disconnect(pw: string) {
    setBusy(true);
    try {
      await waApi.disconnect(code, pw);
      notify(state === 'qr' || state === 'code' ? 'Pedido de conexão cancelado' : 'WhatsApp desconectado');
    } catch (e) { fail(e); }
    setBusy(false);
    setConfirmOff(false);
  }

  function fail(e: unknown) {
    if (e instanceof ApiError && e.code === 'whatsapp_failed') notify('O servidor não conseguiu falar com o WhatsApp.', 'err');
    else if (e instanceof ApiError && e.code === 'invalid_phone') notify('Número inválido. Digite o DDD e o número do seu WhatsApp.', 'err');
    else onError(e);
  }

  // conversations: one chip per chat, newest first
  const chats = useMemo(() => {
    const m = new Map<string, { chat: string; name: string; count: number; last: number }>();
    for (const x of messages) {
      const c = m.get(x.chat) || { chat: x.chat, name: x.name, count: 0, last: 0 };
      c.count += 1;
      if (x.t >= c.last) { c.last = x.t; if (!x.group) c.name = x.name; }
      m.set(x.chat, c);
    }
    return [...m.values()].sort((a, b) => b.last - a.last);
  }, [messages]);
  useEffect(() => { if (chat && !chats.some((c) => c.chat === chat)) setChat(null); }, [chat, chats]);
  const shown = useMemo(() => [...messages].reverse().filter((m) => !chat || m.chat === chat).slice(0, 150), [messages, chat]);

  const node = nodes.find((n) => n.online) ?? nodes[0] ?? null;
  const qrLeft = link?.qr ? Math.max(0, Math.ceil((link.qr.expiresAt - srvNow) / 1000)) : 0;
  const codeLeft = link?.code ? Math.max(0, Math.ceil((link.code.expiresAt - srvNow) / 1000)) : 0;
  const codeText = link?.code ? `${link.code.code.slice(0, 4)}-${link.code.code.slice(4)}` : '';
  const qrD = useMemo(() => (link?.qr ? qrPath(link.qr.n, link.qr.bits) : ''), [link?.qr]);

  if (off) {
    return (
      <div className="env">
        <section className="panel"><p className="note">A ligação com o WhatsApp está desativada neste servidor.</p></section>
      </div>
    );
  }

  const head = (() => {
    if (!link) return { color: C_OFF, title: 'Carregando…', text: '' };
    if (state === 'open') return { color: C_OK, title: 'WhatsApp conectado', text: 'As mensagens recebidas aparecem no visor do AirGuard e os alertas são enviados para este número.' };
    if (state === 'code') return { color: C_WAIT, title: 'Digite o código no WhatsApp', text: 'O mesmo código está no visor do AirGuard.' };
    if (state === 'qr') return { color: C_WAIT, title: 'Leia o código com o WhatsApp', text: 'O QR code aparece só nesta página: o visor do AirGuard é pequeno demais para a câmera.' };
    if (state === 'connecting') return { color: C_WARN, title: 'Conectando ao WhatsApp…', text: link.linked ? 'Sessão salva. Reconectando.' : 'Pedindo o código de conexão.' };
    return { color: C_OFF, title: 'WhatsApp não conectado', text: (link.error && WHY_IDLE[link.error]) || 'Conecte para ver as mensagens no AirGuard e receber os alertas no seu WhatsApp.' };
  })();

  return (
    <div className="env wa">
      <section className="hero" style={{ ['--s' as string]: head.color }} aria-live="polite">
        <div className="hero-icon">
          <svg viewBox="0 0 24 24" aria-hidden><path d="M4 20l1.3-3.9A8 8 0 1 1 8 19.2z" /><path d="M9 9.5c.5 2 2.5 4 4.5 4.5l1-1.2 2 1-.5 1.6c-3.5.2-7.6-3.9-7.4-7.4l1.6-.5 1 2z" /></svg>
        </div>
        <div className="hero-txt wa-head">
          <h2>{head.title}</h2>
          {state === 'open' && link?.me && (
            <p className="wa-me"><b>{waNumber(link.me.number)}</b>{link.me.name ? ` · ${link.me.name}` : ''}</p>
          )}
          <p>{head.text}</p>
          <p className="hero-meta">
            <span className={`live ${conn ? 'on' : ''}`} />
            {conn === false ? 'Sem conexão com o servidor, tentando de novo…'
              : state === 'open' && link?.since ? `Conectado desde ${dayTime(link.since)}`
                : conn ? 'Ao vivo' : 'Conectando ao servidor…'}
          </p>

          {state === 'code' && link?.code && (
            <div className="wa-pair">
              <div className="wa-code" role="img" aria-label={`Código de conexão: ${link.code.code.split('').join(' ')}`}>
                <span>{codeText}</span>
              </div>
              <ol className="wa-steps">
                <li>Abra o <b>WhatsApp</b> no celular.</li>
                <li>Toque em <b>Mais opções</b> (ou <b>Configurações</b>) e em <b>Dispositivos conectados</b>.</li>
                <li>Toque em <b>Conectar dispositivo</b> e depois em <b>Conectar com número de telefone</b>.</li>
                <li>Digite o código acima{link.pairNumber ? <> (conta <b>{waNumber(link.pairNumber)}</b>)</> : null}.</li>
                <li className="wa-count">{codeLeft > 0 ? `O código vale por mais ${codeLeft} s, aproximadamente.` : 'O código está expirando…'}</li>
              </ol>
            </div>
          )}

          {state === 'qr' && link?.qr && (
            <div className="wa-pair">
              <div className="wa-qr" role="img" aria-label="QR code para conectar o WhatsApp">
                <svg viewBox={`-4 -4 ${link.qr.n + 8} ${link.qr.n + 8}`} shapeRendering="crispEdges">
                  <rect x={-4} y={-4} width={link.qr.n + 8} height={link.qr.n + 8} fill="#fff" />
                  <path d={qrD} fill="#000" />
                </svg>
              </div>
              <ol className="wa-steps">
                <li>Abra o <b>WhatsApp</b> no celular.</li>
                <li>Toque em <b>Mais opções</b> (ou <b>Configurações</b>) e em <b>Dispositivos conectados</b>.</li>
                <li>Toque em <b>Conectar dispositivo</b>.</li>
                <li>Aponte a câmera para este código.</li>
                <li className="wa-count">{qrLeft > 0 ? `Este código muda em ${qrLeft} s.` : 'Atualizando o código…'}</li>
              </ol>
            </div>
          )}

          {link && !link.linked && state === 'idle' && (
            <form className="wa-form" onSubmit={(e) => { e.preventDefault(); withPw((pw) => void connect(pw, phone.trim())); }}>
              <label htmlFor="wa-phone">Número do seu WhatsApp</label>
              <div className="wa-form-row">
                <input id="wa-phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={32} placeholder="(67) 99999-8888"
                  value={phone} onChange={(e) => { phoneTyped.current = true; setPhone(e.target.value); }} />
                <button type="submit" className="primary" disabled={busy || !phone.trim()}>
                  {busy ? 'Aguarde…' : link.error ? 'Pedir novo código' : 'Conectar com código'}
                </button>
              </div>
              <p className="wa-hint">
                Um código de 8 caracteres aparece aqui e no visor do AirGuard. Você digita esse código no WhatsApp do celular.
              </p>
              <button type="button" className="wa-alt" disabled={busy} onClick={() => withPw((pw) => void connect(pw))}>
                Prefiro ler um QR code nesta página
              </button>
            </form>
          )}

          <div className="wa-actions">
            {link && link.linked && state === 'idle' && (
              <button className="primary" disabled={busy} onClick={() => withPw((pw) => void connect(pw))}>Tentar reconectar</button>
            )}
            {link && (link.linked || state === 'qr' || state === 'code' || (state === 'connecting' && !link.linked)) && !confirmOff && (
              <button className="ghost" disabled={busy} onClick={() => (link.linked ? setConfirmOff(true) : withPw((pw) => void disconnect(pw)))}>
                {link.linked ? 'Desconectar' : 'Cancelar'}
              </button>
            )}
            {confirmOff && (
              <>
                <span className="wa-ask">Desconectar este WhatsApp do AirGuard?</span>
                <button className="chip danger" disabled={busy} onClick={() => withPw((pw) => void disconnect(pw))}>Desconectar</button>
                <button className="chip" onClick={() => setConfirmOff(false)}>Manter</button>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="panel wa-node">
        <span className={`ddot ${node?.online ? 'on' : ''}`} />
        {!node ? <span>O AirGuard ainda não deu notícias a este servidor.</span>
          : !node.online ? <span><b>{node.device}</b> desligado ou sem rede: as mensagens são registradas aqui, mas não chegam ao visor.</span>
            : node.alert ? <span><b>{node.device}</b> em alerta{node.relay ? ' (energia desligada pelo relé)' : ''}: as mensagens recebidas agora são ignoradas no visor.</span>
              : <span><b>{node.device}</b> ligado, sem alertas: as mensagens aparecem no visor (faixa amarela), o LED azul pisca, e elas aparecem no LCD do receptor.</span>}
      </section>

      <div className="wa-cols">
        <section className="panel">
          <div className="phead">
            <h3>MENSAGENS RECEBIDAS</h3>
            <span className="pmeta">{messages.length ? `${messages.length} guardadas` : 'ao vivo'}</span>
          </div>
          {chats.length > 1 && (
            <nav className="filters wa-chats" aria-label="Filtrar por conversa">
              <button className={`fchip ${chat === null ? 'on' : ''}`} onClick={() => setChat(null)}>Todas</button>
              {chats.slice(0, 30).map((c) => (
                <button key={c.chat} className={`fchip ${chat === c.chat ? 'on' : ''}`} aria-pressed={chat === c.chat}
                  onClick={() => setChat(chat === c.chat ? null : c.chat)}>
                  {c.name}<span className="fcount">{c.count}</span>
                </button>
              ))}
            </nav>
          )}
          {shown.length === 0 ? (
            <p className="note">{state === 'open' ? 'Nenhuma mensagem recebida ainda.' : 'As mensagens aparecem aqui depois que o WhatsApp for conectado.'}</p>
          ) : (
            <ul className="wa-list">
              {shown.map((m) => {
                const f = fate(m);
                return (
                  <li key={m.id}>
                    <div className="avatar wa-av" aria-hidden>{initials(m.name)}</div>
                    <div className="wa-body">
                      <div className="wa-top">
                        <b>{m.name}</b>
                        {m.group && <span className="tag">grupo</span>}
                        <time>{dayTime(m.t)}</time>
                      </div>
                      {/* a contact shows by name only; a name the sender chose (not a contact) keeps the number */}
                      {m.nameFrom === 'profile' && m.numberDisplay && <div className="wa-num">{m.numberDisplay}</div>}
                      <p className="wa-text">{m.text}</p>
                      <span className={`wa-fate ${f.tone}`}>{f.text}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel">
          <div className="phead"><h3>AVISOS ENVIADOS</h3><span className="pmeta">para o seu próprio número</span></div>
          {notices.length === 0 ? <p className="note">Nenhum aviso ainda. Quando houver um alerta, o AirGuard envia ao seu WhatsApp qual é o alerta e a gravidade, e avisa quando normalizar e quando o relé desligar a energia.</p> : (
            <ul className="wa-notices">
              {[...notices].reverse().slice(0, 30).map((n) => {
                const k = NOTICE_KIND[n.kind] ?? NOTICE_KIND.alert;
                const s = noticeStatus(n);
                const open = openNotice === n.id;
                return (
                  <li key={n.id}>
                    <button className="wa-nrow" onClick={() => setOpenNotice(open ? null : n.id)} aria-expanded={open}>
                      <span className="sev" style={{ ['--s' as string]: k.color }}>{k.label}</span>
                      <span className="wa-ndev">{n.device}</span>
                      <time>{dayTime(n.t)}</time>
                      <span className={`wa-fate ${s.tone}`}>{s.text}</span>
                    </button>
                    {open && <pre className="wa-ntext">{plain(n.text)}</pre>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <p className="note wa-foot">
        Enquanto houver qualquer alerta, o AirGuard ignora as mensagens recebidas. Sem alerta, cada mensagem passa duas vezes na faixa amarela do visor, devagar, com o LED azul do AirGuard piscando por 5 s, e aparece duas vezes no LCD do receptor, por até 5 s cada (o LED verde dele pisca nesse tempo).
        {groups ? ' Mensagens de grupos também são mostradas.' : ' Mensagens de grupos, status e canais não são mostradas.'}
        {' '}Quem tem um link de acesso a esta página vê as mensagens recebidas por este WhatsApp.
      </p>
    </div>
  );
}
