// "Ambiente" page: what the AirGuard node is measuring now, the history, and
// the LoRa conversation between the ESP32 node and the RP2040 receiver, live.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LineChart, { type Datum } from './LineChart';
import {
  ago, CAT_LABEL, fmtTime, num, SEV_INFO, sevOf, stream, tlmApi, TYPE_LABEL,
  type Alert, type EnvSample, type History, type Packet, type RangeId, type Sev, type Status,
} from './telemetry';

const RANGES: { id: RangeId; label: string }[] = [
  { id: '1h', label: '1 h' }, { id: '6h', label: '6 h' }, { id: '24h', label: '24 h' }, { id: '7d', label: '7 dias' }, { id: '30d', label: '30 dias' },
];
// validated categorical slots (dark surface): one fixed hue per measure
const C_TEMP = '#d95926', C_HUM = '#3987e5', C_GAS = '#199e70', C_NEUTRAL = '#9aa6bf';
const RANGE_KEY = 'airguard.envRange';

function SevChip({ sev, text }: { sev: Sev; text?: string }) {
  const s = SEV_INFO[sev];
  return (
    <span className="sev" style={{ ['--s' as string]: s.color }}>
      <SevIcon sev={sev} />{text ?? s.label}
    </span>
  );
}

function SevIcon({ sev }: { sev: Sev }) {
  if (sev === 'NORMAL') return <svg viewBox="0 0 24 24" aria-hidden><path d="m5 12 5 5 9-10" /></svg>;
  if (sev === 'HIGH') return <svg viewBox="0 0 24 24" aria-hidden><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17v.5" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16v.5" /></svg>;
}

function headline(s: Status | null): { sev: Sev; title: string; text: string } {
  const c = s?.current;
  if (!s || !c) return { sev: 'NORMAL', title: 'Aguardando o AirGuard', text: 'Nenhuma leitura recente. Verifique se a placa e a ponte USB estão ligadas.' };
  const lv = c.levels;
  const air = sevOf(lv?.air), temp = sevOf(lv?.temp), hum = sevOf(lv?.hum), sys = sevOf(lv?.sys);
  if (air === 'HIGH') return { sev: 'HIGH', title: 'Perigo: gás detectado', text: 'Concentração alta. Ventile o ambiente, não acenda fogo nem acione interruptores.' };
  if (air !== 'NORMAL') return { sev: air, title: 'Atenção: gás acima do normal', text: 'O sensor detectou gás. Verifique o fogão e as conexões do botijão.' };
  const worst = [temp, hum, sys].sort((a, b) => ['NORMAL', 'LOW', 'MEDIUM', 'HIGH'].indexOf(b) - ['NORMAL', 'LOW', 'MEDIUM', 'HIGH'].indexOf(a))[0];
  if (worst !== 'NORMAL') {
    const what = worst === temp ? 'Temperatura' : worst === hum ? 'Umidade' : 'Sistema';
    return { sev: worst, title: `${what} fora do ideal`, text: what === 'Sistema' ? 'O AirGuard indica uma falha (sensor, rádio ou visor).' : 'O ambiente está menos confortável que o recomendado.' };
  }
  return { sev: 'NORMAL', title: 'Ambiente seguro', text: 'Sem gás detectado. Temperatura e umidade dentro do normal.' };
}

export default function Environment({ code }: { code: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [range, setRange] = useState<RangeId>(() => {
    try { const r = localStorage.getItem(RANGE_KEY) as RangeId | null; return r && RANGES.some((x) => x.id === r) ? r : '1h'; } catch { return '1h'; }
  });
  const [hist, setHist] = useState<History | null>(null);
  const [live, setLive] = useState<EnvSample[]>([]);
  const [conn, setConn] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pulse, setPulse] = useState<{ k: number; dir: 'up' | 'down'; type: string } | null>(null);
  const skew = useRef(0);  // server clock - browser clock

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const loadHistory = useCallback(async () => {
    try {
      const h = await tlmApi.history(code, range);
      setHist(h);
      setLive((l) => l.filter((s) => s.t > (h.points[h.points.length - 1]?.t ?? 0) + h.step));
    } catch { /* stream status shows the connection */ }
  }, [code, range]);

  useEffect(() => {
    try { localStorage.setItem(RANGE_KEY, range); } catch { /* ignore */ }
    void loadHistory();
    const t = setInterval(() => void loadHistory(), range === '1h' ? 60_000 : 120_000);
    return () => clearInterval(t);
  }, [range, loadHistory]);

  useEffect(() => {
    const ctl = new AbortController();
    tlmApi.state(code).then((s) => {
      skew.current = s.now - Date.now();
      setStatus(s); setPackets(s.packets); setAlerts(s.alerts.slice().reverse());
    }).catch(() => { /* stream retries */ });
    void stream(code, (e) => {
      switch (e.type) {
        case 'status': {
          const s = e.data as Status;
          skew.current = s.now - Date.now();
          setStatus(s);
          break;
        }
        case 'env': setLive((l) => [...l.slice(-2000), e.data as EnvSample]); break;
        case 'packet': {
          const p = e.data as Packet;
          setPackets((l) => {
            const i = l.findIndex((x) => x.key === p.key);
            if (i >= 0) { const c = l.slice(); c[i] = p; return c; }
            return [...l.slice(-199), p];
          });
          // animate a packet on the link when it is seen for the first time
          if (p.rx && !p.tx) setPulse({ k: p.key * 10 + (p.rx ? 1 : 0), dir: p.from === 'gw' ? 'down' : 'up', type: p.type });
          else if (p.tx && !p.rx) setPulse({ k: p.key * 10, dir: p.from === 'gw' ? 'down' : 'up', type: p.type });
          break;
        }
        case 'alert': setAlerts((l) => [e.data as Alert, ...l].slice(0, 50)); break;
        default: break;
      }
    }, setConn, ctl.signal);
    return () => ctl.abort();
  }, [code]);

  const srvNow = now + skew.current;
  const limits = status?.limits ?? hist?.limits;
  const cur = status?.current ?? null;
  const head = headline(status);

  // history points + live samples received after the last history bucket
  const series = useMemo(() => {
    const pts = hist?.points ?? [];
    const lastT = pts[pts.length - 1]?.t ?? 0;
    const extra = range === '1h' ? live.filter((s) => s.t > lastT + (hist?.step ?? 0)) : [];
    const mk = (f: (p: (typeof pts)[number]) => Datum, g: (s: EnvSample) => Datum) => [...pts.map(f), ...extra.map(g)];
    return {
      temp: mk((p) => ({ t: p.t, v: p.temp, lo: p.tempMin, hi: p.tempMax }), (s) => ({ t: s.t, v: s.temp })),
      hum: mk((p) => ({ t: p.t, v: p.hum, lo: p.humMin, hi: p.humMax }), (s) => ({ t: s.t, v: s.hum })),
      gas: mk((p) => ({ t: p.t, v: p.gas, lo: null, hi: p.gasMax }), (s) => ({ t: s.t, v: s.gas })),
      rssi: pts.map((p) => ({ t: p.t, v: p.rssi })),
    };
  }, [hist, live, range]);

  const from = hist ? hist.from : srvNow - 3600e3;
  const to = range === '1h' ? Math.max(srvNow, hist?.to ?? 0) : (hist?.to ?? srvNow);
  const step = hist?.step ?? 10_000;
  const markers = (hist?.alerts ?? []).concat(alerts.filter((a) => a.t > (hist?.to ?? 0)))
    .filter((a) => a.cat === 'AIR_QUALITY')
    .map((a) => ({ t: a.t, color: SEV_INFO[sevOf(a.type === 'RECOVERY' ? 'NORMAL' : a.sev)].color,
      label: `${fmtTime(a.t)} ${a.type === 'RECOVERY' ? 'Gás normalizado' : `Alerta de gás: ${SEV_INFO[sevOf(a.sev)].label}`}` }));

  const gasSev = sevOf(cur?.levels?.air);
  const gasMax = Math.max(2.5, (limits?.gasHigh ?? 1.5) * 1.4);

  return (
    <div className="env">
      <section className={`hero sev-${head.sev}`} style={{ ['--s' as string]: SEV_INFO[head.sev].color }} aria-live="polite">
        <div className="hero-icon"><SevIcon sev={head.sev} /></div>
        <div className="hero-txt">
          <h2>{head.title}</h2>
          <p>{head.text}</p>
          <p className="hero-meta">
            <span className={`live ${conn ? 'on' : ''}`} />
            {conn === false ? 'Sem conexão com o servidor, tentando de novo…'
              : cur ? `Atualizado ${ago(cur.t, srvNow)} · pelo Wi-Fi do ESP32`
                : 'Conectado. Aguardando leituras.'}
            {cur?.sim && ' · SIMULAÇÃO'}
          </p>
        </div>
      </section>

      <section className="tiles">
        <Tile label="Temperatura" color={C_TEMP} value={num(cur?.temp, 1)} unit="°C" sev={sevOf(cur?.levels?.temp)}
          sub={cur?.hi != null && cur.temp != null && Math.abs(cur.hi - cur.temp) >= 0.5 ? `sensação ${num(cur.hi, 1)} °C` : limits ? `ideal ${num(limits.tempLow, 0)}–${num(limits.tempHigh, 0)} °C` : ''} />
        <Tile label="Umidade" color={C_HUM} value={num(cur?.hum, 0)} unit="%" sev={sevOf(cur?.levels?.hum)}
          sub={limits ? `ideal ${limits.humLow}–${limits.humHigh} %` : ''} />
        <div className="tile gas">
          <div className="tlabel"><i style={{ background: C_GAS }} aria-hidden />Gás (MQ-135)</div>
          <div className="tval">{cur?.gas != null ? num(cur.gas, 2) : '–'}<small>V</small></div>
          <SevChip sev={gasSev} />
          {limits && (
            <div className="gauge" aria-label={`Gás ${num(cur?.gas, 2)} V; atenção a partir de ${num(limits.gasMedium, 2)} V, perigo a partir de ${num(limits.gasHigh, 2)} V`}>
              <div className="gtrack">
                <span style={{ width: `${(limits.gasMedium / gasMax) * 100}%`, background: SEV_INFO.NORMAL.color }} />
                <span style={{ width: `${((limits.gasHigh - limits.gasMedium) / gasMax) * 100}%`, background: SEV_INFO.MEDIUM.color }} />
                <span style={{ flex: 1, background: SEV_INFO.HIGH.color }} />
              </div>
              {cur?.gas != null && <b className="gneedle" style={{ left: `${Math.min(100, (cur.gas / gasMax) * 100)}%` }} />}
              <div className="gscale"><span>0</span><span style={{ left: `${(limits.gasMedium / gasMax) * 100}%` }}>{num(limits.gasMedium, 2)}</span><span style={{ left: `${(limits.gasHigh / gasMax) * 100}%` }}>{num(limits.gasHigh, 2)}</span></div>
            </div>
          )}
          {cur?.airState === 'WARMUP' && <p className="tsub">sensor aquecendo</p>}
          {cur?.relay && <p className="tsub">exaustão / relé LIGADO</p>}
        </div>
      </section>

      <section className="panel">
        <div className="phead">
          <h3>HISTÓRICO</h3>
          <div className="seg" role="radiogroup" aria-label="Período">
            {RANGES.map((r) => (
              <button key={r.id} role="radio" aria-checked={range === r.id} className={range === r.id ? 'on' : ''} onClick={() => setRange(r.id)}>{r.label}</button>
            ))}
          </div>
        </div>
        <div className="charts">
          <LineChart title="Gás" unit="V" decimals={2} color={C_GAS} data={series.gas} from={from} to={to} step={step} floor={0} minSpan={0.5}
            bandLabel="pico até" markers={markers}
            lines={limits ? [{ y: limits.gasMedium, label: `atenção ${num(limits.gasMedium, 2)} V`, color: SEV_INFO.MEDIUM.color },
              { y: limits.gasHigh, label: `perigo ${num(limits.gasHigh, 2)} V`, color: SEV_INFO.HIGH.color }] : []} />
          <LineChart title="Temperatura" unit="°C" decimals={1} color={C_TEMP} data={series.temp} from={from} to={to} step={step} minSpan={3}
            bandLabel="mín–máx" zones={limits ? [{ from: limits.tempLow, to: limits.tempHigh, label: 'conforto', color: SEV_INFO.NORMAL.color }] : []} />
          <LineChart title="Umidade" unit="%" decimals={0} color={C_HUM} data={series.hum} from={from} to={to} step={step} floor={0} minSpan={10}
            bandLabel="mín–máx" zones={limits ? [{ from: limits.humLow, to: limits.humHigh, label: 'conforto', color: SEV_INFO.NORMAL.color }] : []} />
        </div>
        <p className="note">A faixa clara mostra o mínimo e o máximo de cada intervalo; a área verde é a faixa de conforto. Bolinhas no gráfico do gás marcam alertas.</p>
      </section>

      <LoraPanel status={status} packets={packets} pulse={pulse} now={srvNow}
        rssi={series.rssi} from={from} to={to} step={step} />

      <section className="panel">
        <div className="phead"><h3>OCORRÊNCIAS</h3></div>
        {alerts.length === 0 ? <p className="note">Nenhum alerta registrado.</p> : (
          <ul className="events">
            {alerts.slice(0, 15).map((a, i) => {
              const sev = a.type === 'RECOVERY' ? 'NORMAL' : sevOf(a.sev);
              return (
                <li key={`${a.id}-${i}`}>
                  <SevChip sev={sev} text={a.type === 'RECOVERY' ? 'Normalizado' : SEV_INFO[sevOf(a.sev)].label} />
                  <span className="ev-what">{CAT_LABEL[a.cat || ''] || a.cat}{a.prev && a.type !== 'RECOVERY' ? ` (antes: ${SEV_INFO[sevOf(a.prev)].label.toLowerCase()})` : ''}</span>
                  <time>{new Date(a.t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Tile({ label, color, value, unit, sev, sub }: { label: string; color: string; value: string; unit: string; sev: Sev; sub: string }) {
  return (
    <div className="tile">
      <div className="tlabel"><i style={{ background: color }} aria-hidden />{label}</div>
      <div className="tval">{value}<small>{unit}</small></div>
      <SevChip sev={sev} />
      {sub && <p className="tsub">{sub}</p>}
    </div>
  );
}

// ---- LoRa ---------------------------------------------------------------------
function packetState(p: Packet, gwOnline: boolean, now: number): { text: string; tone: 'ok' | 'wait' | 'bad' | 'muted' } {
  if (p.status === 'failed') return { text: 'não entregue', tone: 'bad' };
  if (p.status === 'txerror') return { text: 'erro no envio', tone: 'bad' };
  if (p.status === 'invalid') return { text: 'quadro inválido', tone: 'bad' };
  if (p.status === 'lost') return { text: 'perdido', tone: 'bad' };
  if (p.status === 'foreign' || p.status === 'other') return { text: 'ignorado', tone: 'muted' };
  if (p.dup) return { text: 'repetido', tone: 'muted' };
  if (p.type === 'ALERT' || p.type === 'RECOVERY') {
    if (p.acked) return { text: `confirmado em ${num((p.latency ?? 0) / 1000, 1)} s`, tone: 'ok' };
    if (p.rx) return { text: 'recebido', tone: 'ok' };
    return now - p.t > 10_000 && gwOnline ? { text: 'sem resposta', tone: 'bad' } : { text: 'enviado…', tone: 'wait' };
  }
  if (p.rx) return { text: p.tx ? 'recebido' : 'recebido pelo ESP32', tone: 'ok' };
  // a heartbeat is confirmed by the receiver's next STAT (every 5 s)
  if (p.tx) return now - p.t > 60_000 ? { text: 'sem notícia do receptor', tone: 'muted' } : { text: 'enviado…', tone: 'wait' };
  return { text: '–', tone: 'muted' };
}

function rssiQuality(r: number | null) {
  if (r == null) return { label: '–', bars: 0 };
  if (r >= -70) return { label: 'excelente', bars: 4 };
  if (r >= -90) return { label: 'bom', bars: 3 };
  if (r >= -105) return { label: 'fraco', bars: 2 };
  return { label: 'muito fraco', bars: 1 };
}

function LoraPanel({ status, packets, pulse, now, rssi, from, to, step }: {
  status: Status | null; packets: Packet[]; pulse: { k: number; dir: 'up' | 'down'; type: string } | null; now: number;
  rssi: Datum[]; from: number; to: number; step: number;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [showHb, setShowHb] = useState(true);
  const link = status?.link;
  const nodeOn = !!status?.node.online, gwOn = !!status?.gateway.online;
  const q = rssiQuality(link?.rssi ?? null);
  const list = useMemo(() => [...packets].reverse().filter((p) => showHb || p.type !== 'HB').slice(0, 60), [packets, showHb]);

  return (
    <section className="panel">
      <div className="phead"><h3>COMUNICAÇÃO LORA</h3><span className="pmeta">915 MHz · SF8 · ao vivo</span></div>

      <div className="link">
        <Device name="ESP32" role="Sensor da cozinha" id="KITCHEN_01" online={nodeOn} last={status?.node.lastSeen ?? null} now={now}
          detail={status?.node.boot?.fw ? `firmware ${status.node.boot.fw} · Wi-Fi` : nodeOn ? 'Wi-Fi' : 'sem dados pelo Wi-Fi'} />
        <div className="wire" aria-hidden>
          <div className="wline" />
          {pulse && <span key={pulse.k} className={`packet ${pulse.dir} t-${pulse.type}`}>{pulse.type === 'HB' ? '' : pulse.type[0]}</span>}
          <div className="wlabel">
            <span className="bars">{[1, 2, 3, 4].map((b) => <i key={b} className={b <= q.bars ? 'on' : ''} style={{ height: 4 + b * 3 }} />)}</span>
            {link?.rssi != null ? `${link.rssi} dBm · ${q.label}` : 'sem sinal medido'}
          </div>
        </div>
        <Device name="RP2040" role="Receptor (gateway)" id="GATEWAY_01" online={gwOn} last={status?.gateway.lastSeen ?? null} now={now}
          detail={status?.gateway.stat ? `LCD ${status.gateway.stat.lcd ? 'ok' : 'falha'} · informa pelo LoRa` : 'sem notícias pelo LoRa'} />
      </div>

      <div className="kpis">
        <Kpi label="Sinal no receptor" value={link?.rssi != null ? `${link.rssi}` : '–'} unit="dBm" />
        <Kpi label="SNR" value={link?.snr != null ? num(link.snr, 0) : '–'} unit="dB" />
        <Kpi label="Perda (10 min)" value={link?.lossPct != null ? num(link.lossPct, 1) : '–'} unit="%"
          hint={link ? `${link.hbReceived} recebidos, ${link.hbLost} perdidos` : ''} />
        <Kpi label="Confirmação" value={link?.ackLatencyMs != null ? num(link.ackLatencyMs / 1000, 1) : '–'} unit="s"
          hint="alerta → ACK" />
      </div>

      <LineChart title="Sinal no receptor (RSSI)" unit="dBm" decimals={0} color={C_NEUTRAL} data={rssi} from={from} to={to}
        step={Math.max(step, 60_000)} minSpan={10} height={150} />

      <div className="phead sub">
        <h4>Pacotes</h4>
        <label className="toggle"><input type="checkbox" checked={showHb} onChange={(e) => setShowHb(e.target.checked)} /> sinais de vida</label>
      </div>
      <div className="plist" role="list">
        {list.length === 0 && <p className="note">Nenhum pacote ainda.</p>}
        {list.map((p) => {
          const st = packetState(p, gwOn, now);
          const up = p.from !== 'gw';
          return (
            <div key={p.key} role="listitem" className={`pkt ${open === p.key ? 'open' : ''}`}>
              <button className="prow" onClick={() => setOpen(open === p.key ? null : p.key)} aria-expanded={open === p.key}>
                <time>{fmtTime(p.t)}</time>
                <span className={`dir ${up ? 'up' : 'down'}`} title={up ? 'ESP32 → RP2040' : 'RP2040 → ESP32'}>
                  {up ? 'ESP32 → RP2040' : 'RP2040 → ESP32'}
                </span>
                <span className={`ptype t-${p.type}`}>{TYPE_LABEL[p.type] || p.type}{p.ref != null ? ` #${p.type === 'HB' ? p.ref : p.ref % 100000}` : ''}</span>
                <span className={`pst ${st.tone}`}>{p.retry ? `tentativa ${p.try} · ` : ''}{st.text}</span>
                <span className="prssi">{p.rx?.rssi != null ? `${p.rx.rssi} dBm` : ''}</span>
              </button>
              {open === p.key && (
                <div className="pdetail">
                  <dl>
                    {p.tx && <><dt>Enviado</dt><dd>{fmtTime(p.tx.t)}{p.tx.airtime != null ? ` · ${p.tx.airtime} ms no ar` : ''}{p.len ? ` · ${p.len} bytes` : ''}</dd></>}
                    {p.rx && <><dt>Recebido</dt><dd>
                      {up ? 'pelo RP2040' : `pelo ESP32 às ${fmtTime(p.rx.t ?? p.t)}`}
                      {p.rx.rssi != null ? ` · RSSI ${p.rx.rssi} dBm · SNR ${p.rx.snr ?? '–'} dB` : up ? ' (informado no status do receptor)' : ''}
                    </dd></>}
                    {!p.rx && !p.status && up && <><dt>Recepção</dt><dd>{gwOn ? 'aguardando o status do receptor' : 'receptor sem notícias'}</dd></>}
                    {p.note && <><dt>Info</dt><dd>{p.note}</dd></>}
                  </dl>
                  {p.frame && <pre>{p.frame}</pre>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="note">“Sinal de vida” é enviado a cada 5 s pelo ESP32 com as leituras; a cada 5 s o receptor responde com um status dizendo quais ouviu e com que sinal. O ESP32 registra tudo o que envia e recebe e manda ao servidor pelo Wi-Fi. Alertas precisam de confirmação (ACK) do receptor; sem ela, o ESP32 repete o envio a cada 60 s.</p>
    </section>
  );
}

function Device({ name, role, id, online, last, now, detail }: { name: string; role: string; id: string; online: boolean; last: number | null; now: number; detail: string }) {
  return (
    <div className={`dev ${online ? 'on' : ''}`}>
      <div className="dname"><span className="ddot" />{name}</div>
      <div className="drole">{role}</div>
      <div className="dmeta">{id}</div>
      <div className="dmeta">{online ? 'online' : `offline · ${ago(last, now)}`}</div>
      <div className="dmeta">{detail}</div>
    </div>
  );
}

function Kpi({ label, value, unit, hint }: { label: string; value: string; unit: string; hint?: string }) {
  return (
    <div className="kpi" title={hint}>
      <span className="klabel">{label}</span>
      <span className="kval">{value}<small>{unit}</small></span>
      {hint && <span className="khint">{hint}</span>}
    </div>
  );
}
