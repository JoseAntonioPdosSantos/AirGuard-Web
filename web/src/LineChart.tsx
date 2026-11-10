// Small time-series chart (SVG, no library): one measure per chart, a min..max
// band, reference zones / threshold lines, alert markers, a crosshair tooltip
// and a table view of the same data.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { fmtDay, fmtTime, num } from './telemetry';

export interface Datum { t: number; v: number | null; lo?: number | null; hi?: number | null }
export interface Zone { from: number; to: number; label: string; color: string }
export interface RefLine { y: number; label: string; color: string }
export interface Marker { t: number; label: string; color: string }

interface Props {
  title: string;
  unit: string;
  decimals: number;
  color: string;
  data: Datum[];
  from: number;
  to: number;
  step: number;           // bucket width of the data (ms): longer holes are gaps
  zones?: Zone[];
  lines?: RefLine[];
  markers?: Marker[];
  floor?: number;         // y never below this (e.g. 0 V)
  minSpan?: number;       // smallest y range shown (a flat line is not blown up)
  height?: number;
  bandLabel?: string;     // tooltip label of lo..hi
}

const PAD = { l: 44, r: 14, t: 10, b: 24 };

function niceTicks(lo: number, hi: number, n = 4) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) || raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return { ticks: out, step };
}

export default function LineChart(p: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const h = p.height ?? 190;
  const clip = 'clip' + useId().replace(/[^a-zA-Z0-9]/g, '');

  useLayoutEffect(() => {
    const el = box.current;
    if (el) setW(Math.max(260, Math.round(el.getBoundingClientRect().width)));
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = useMemo(() => p.data.filter((d) => d.v != null && d.t >= p.from - p.step), [p.data, p.from, p.step]);

  const { y0, y1, ticks } = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const d of pts) {
      lo = Math.min(lo, d.lo ?? d.v!, d.v!);
      hi = Math.max(hi, d.hi ?? d.v!, d.v!);
    }
    for (const l of p.lines || []) { lo = Math.min(lo, l.y); hi = Math.max(hi, l.y); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const minSpan = p.minSpan ?? 1;
    if (hi - lo < minSpan) { const c = (hi + lo) / 2; lo = c - minSpan / 2; hi = c + minSpan / 2; }
    const pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;
    if (p.floor != null && lo < p.floor) lo = p.floor;
    const nt = niceTicks(lo, hi);
    return { y0: Math.min(lo, nt.ticks[0] ?? lo), y1: Math.max(hi, nt.ticks[nt.ticks.length - 1] ?? hi), ticks: nt.ticks };
  }, [pts, p.lines, p.minSpan, p.floor]);

  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const x = (t: number) => PAD.l + ((t - p.from) / (p.to - p.from)) * iw;
  const y = (v: number) => PAD.t + (1 - (v - y0) / (y1 - y0)) * ih;
  const gapMs = Math.max(3 * p.step, 30_000);

  // split into segments at holes in the data (board offline)
  const segs = useMemo(() => {
    const out: Datum[][] = [];
    let cur: Datum[] = [];
    for (const d of pts) {
      if (cur.length && d.t - cur[cur.length - 1].t > gapMs) { out.push(cur); cur = []; }
      cur.push(d);
    }
    if (cur.length) out.push(cur);
    return out;
  }, [pts, gapMs]);

  const line = (s: Datum[]) => s.map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d.v!).toFixed(1)}`).join('');
  const band = (s: Datum[]) => {
    if (!s.some((d) => d.lo != null && d.hi != null && d.hi !== d.lo)) return '';
    const top = s.map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d.hi ?? d.v!).toFixed(1)}`).join('');
    const bot = [...s].reverse().map((d) => `L${x(d.t).toFixed(1)},${y(d.lo ?? d.v!).toFixed(1)}`).join('');
    return top + bot + 'Z';
  };

  const span = p.to - p.from;
  const xTicks = useMemo(() => {
    const n = Math.max(2, Math.floor(iw / 90));
    const stepT = [60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 2 * 86400e3, 5 * 86400e3, 7 * 86400e3]
      .find((s) => span / s <= n) || 7 * 86400e3;
    const tz = new Date().getTimezoneOffset() * 60e3;
    const out: number[] = [];
    for (let t = Math.ceil((p.from - tz) / stepT) * stepT + tz; t <= p.to; t += stepT) out.push(t);
    return { ticks: out, days: stepT >= 86400e3 };
  }, [p.from, p.to, iw, span]);

  function onMove(e: PointerEvent<SVGSVGElement>) {
    if (!pts.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = p.from + ((e.clientX - r.left - PAD.l) / iw) * span;
    let best = 0;
    for (let i = 1; i < pts.length; i += 1) if (Math.abs(pts[i].t - t) < Math.abs(pts[best].t - t)) best = i;
    setHover(best);
  }

  const last = pts[pts.length - 1];
  const hv = hover != null ? pts[hover] : null;
  const stats = useMemo(() => {
    if (!pts.length) return null;
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const d of pts) { lo = Math.min(lo, d.lo ?? d.v!); hi = Math.max(hi, d.hi ?? d.v!); sum += d.v!; }
    return { lo, hi, avg: sum / pts.length };
  }, [pts]);
  const fmtT = (t: number) => (span > 86400e3 ? `${fmtDay(t)} ${fmtTime(t, false)}` : fmtTime(t, p.step < 60e3));

  return (
    <figure className="chart">
      <figcaption>
        <span className="ctitle"><i style={{ background: p.color }} aria-hidden />{p.title}</span>
        {stats && (
          <span className="cstats">
            mín <b>{num(stats.lo, p.decimals)}</b> · méd <b>{num(stats.avg, p.decimals)}</b> · máx <b>{num(stats.hi, p.decimals)}</b> {p.unit}
          </span>
        )}
      </figcaption>
      <div className="cbox" ref={box}>
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" onPointerMove={onMove} onPointerLeave={() => setHover(null)}
          aria-label={`${p.title}: ${stats ? `de ${num(stats.lo, p.decimals)} a ${num(stats.hi, p.decimals)} ${p.unit}` : 'sem dados'}`}>
          <defs>
            <clipPath id={clip}><rect x={PAD.l} y={PAD.t} width={iw} height={ih} /></clipPath>
          </defs>
          {/* reference zones (comfort / alarm bands) */}
          <g clipPath={`url(#${clip})`}>
            {(p.zones || []).map((z) => {
              const a = y(Math.min(z.to, y1)), b = y(Math.max(z.from, y0));
              return b > a ? <rect key={z.label} x={PAD.l} y={a} width={iw} height={b - a} fill={z.color} opacity={0.07} /> : null;
            })}
          </g>
          {/* grid + y axis */}
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={w - PAD.r} y1={y(v)} y2={y(v)} className="grid" />
              <text x={PAD.l - 8} y={y(v)} className="axis" textAnchor="end" dominantBaseline="middle">{num(v, p.decimals > 1 ? 1 : 0)}</text>
            </g>
          ))}
          {xTicks.ticks.map((t) => (
            <text key={t} x={x(t)} y={h - 6} className="axis" textAnchor="middle">{xTicks.days ? fmtDay(t) : fmtTime(t, false)}</text>
          ))}
          {/* thresholds */}
          {(p.lines || []).filter((l) => l.y >= y0 && l.y <= y1).map((l) => (
            <g key={l.label}>
              <line x1={PAD.l} x2={w - PAD.r} y1={y(l.y)} y2={y(l.y)} stroke={l.color} strokeWidth={1} strokeDasharray="4 4" opacity={0.8} />
              <text x={PAD.l + 6} y={y(l.y) - 5} className="axis tline" textAnchor="start">{l.label}</text>
            </g>
          ))}
          {/* alert markers */}
          {(p.markers || []).filter((m) => m.t >= p.from && m.t <= p.to).map((m, i) => (
            <g key={`${m.t}-${i}`}>
              <line x1={x(m.t)} x2={x(m.t)} y1={PAD.t} y2={PAD.t + ih} stroke={m.color} strokeWidth={1} opacity={0.45} />
              <circle cx={x(m.t)} cy={PAD.t + 4} r={4} fill={m.color} stroke="var(--chart-surface)" strokeWidth={2}><title>{m.label}</title></circle>
            </g>
          ))}
          {/* data */}
          <g clipPath={`url(#${clip})`}>
            {segs.map((s, i) => <path key={`b${i}`} d={band(s)} fill={p.color} opacity={0.16} />)}
            {segs.map((s, i) => (s.length > 1
              ? <path key={`l${i}`} d={line(s)} fill="none" stroke={p.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              : <circle key={`l${i}`} cx={x(s[0].t)} cy={y(s[0].v!)} r={2.5} fill={p.color} />))}
          </g>
          {last && !hv && (
            <g>
              <circle cx={x(last.t)} cy={y(last.v!)} r={4} fill={p.color} stroke="var(--chart-surface)" strokeWidth={2} />
            </g>
          )}
          {hv && (
            <g>
              <line x1={x(hv.t)} x2={x(hv.t)} y1={PAD.t} y2={PAD.t + ih} className="cross" />
              <circle cx={x(hv.t)} cy={y(hv.v!)} r={5} fill={p.color} stroke="var(--chart-surface)" strokeWidth={2} />
            </g>
          )}
          {!pts.length && <text x={PAD.l + iw / 2} y={PAD.t + ih / 2} className="axis" textAnchor="middle">Sem dados neste período</text>}
        </svg>
        {hv && (
          <div className="tip" style={{ left: Math.min(Math.max(x(hv.t), 90), w - 90), top: Math.max(y(hv.v!) - 12, 4) }}>
            <span className="tt">{fmtT(hv.t)}</span>
            <b>{num(hv.v, p.decimals)} {p.unit}</b>
            {hv.lo != null && hv.hi != null && hv.hi !== hv.lo && (
              <span className="tt">{p.bandLabel ?? 'faixa'} {num(hv.lo, p.decimals)} – {num(hv.hi, p.decimals)}</span>
            )}
          </div>
        )}
      </div>
      <details className="ctable">
        <summary>Ver em tabela</summary>
        <div className="tscroll">
          <table>
            <thead><tr><th>Horário</th><th>{p.title} ({p.unit})</th>{pts.some((d) => d.lo != null) && <th>mín – máx</th>}</tr></thead>
            <tbody>
              {[...pts].reverse().slice(0, 200).map((d) => (
                <tr key={d.t}><td>{fmtT(d.t)}</td><td>{num(d.v, p.decimals)}</td>
                  {pts.some((q) => q.lo != null) && <td>{d.lo != null ? `${num(d.lo, p.decimals)} – ${num(d.hi, p.decimals)}` : ''}</td>}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
