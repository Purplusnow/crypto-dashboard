/**
 * charts.js — 의존성 없는 SVG 차트 프리미티브.
 *
 * 공통 규칙
 *  - 선 2px / 마커 r≥4 + 2px 표면 링 / 막대 ≤24px, 데이터 끝 4px 라운드
 *  - 스택 사이는 테두리가 아니라 2px 표면색 간격으로 분리
 *  - 그리드·축은 1px 실선, 표면에서 한 단계만 떨어진 회색
 *  - 색은 CSS 변수로만 지정해 라이트/다크가 한 곳에서 스왑되게 한다
 *  - 모든 차트에 호버 + 키보드 포커스 리드아웃 (툴팁은 보조 수단이며,
 *    같은 값은 표 보기에서도 항상 읽을 수 있다)
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, styles = {}) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  }
  for (const [k, v] of Object.entries(styles)) n.style[k] = v;
  return n;
}

/* --------------------------------------------------------------- 스케일 */

function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad * 0.5;
    max += pad * 0.5;
  }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function xTickIndices(n, target = 6) {
  if (n <= 1) return [0];
  const k = Math.min(n, target);
  const out = [];
  for (let i = 0; i < k; i++) out.push(Math.round((i * (n - 1)) / (k - 1)));
  return [...new Set(out)];
}

export function shortDate(iso) {
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/* ------------------------------------------------------- 차트 스캐폴딩 */

/**
 * 카드 내부에 반응형 SVG를 만들고, 컨테이너 폭이 바뀌면 다시 그린다.
 * draw(ctx) 는 {svg, W, H, plot, tip} 를 받아 실제 마크를 그린다.
 */
function mount(host, height, draw) {
  host.classList.add('chart');
  const render = () => {
    const W = Math.max(280, host.clientWidth || 640);
    const H = height;
    host.textContent = '';
    const svg = el('svg', {
      width: '100%',
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      role: 'img',
      tabindex: '0',
    });
    host.appendChild(svg);
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.hidden = true;
    host.appendChild(tip);
    draw({ svg, W, H, host, tip });
  };
  render();
  if (host._ro) host._ro.disconnect();
  let w = host.clientWidth;
  host._ro = new ResizeObserver(() => {
    if (Math.abs(host.clientWidth - w) < 8) return;
    w = host.clientWidth;
    render();
  });
  host._ro.observe(host);
}

function axes(svg, { W, H, m, yTicks, yFmt, xLabels, xIdx }) {
  const innerW = W - m.l - m.r;
  const innerH = H - m.t - m.b;
  const g = el('g');
  const y0 = yTicks[0];
  const y1 = yTicks[yTicks.length - 1];
  const sy = (v) => m.t + innerH - ((v - y0) / (y1 - y0 || 1)) * innerH;

  for (const t of yTicks) {
    const y = sy(t);
    g.appendChild(
      el('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, 'stroke-width': 1 }, { stroke: 'var(--grid)' })
    );
    const lab = el('text', { x: m.l - 8, y: y + 4, 'text-anchor': 'end' }, { fill: 'var(--muted)' });
    lab.setAttribute('class', 'tick');
    lab.textContent = yFmt(t);
    g.appendChild(lab);
  }
  // 0 기준선은 한 단계 진하게
  if (y0 < 0 && y1 > 0) {
    g.appendChild(
      el(
        'line',
        { x1: m.l, x2: W - m.r, y1: sy(0), y2: sy(0), 'stroke-width': 1 },
        { stroke: 'var(--baseline)' }
      )
    );
  }
  for (const i of xIdx) {
    const x = m.l + (xLabels.length === 1 ? innerW / 2 : (i / (xLabels.length - 1)) * innerW);
    const lab = el('text', { x, y: H - m.b + 18, 'text-anchor': 'middle' }, { fill: 'var(--muted)' });
    lab.setAttribute('class', 'tick');
    lab.textContent = xLabels[i];
    g.appendChild(lab);
  }
  svg.appendChild(g);
  return { sy, innerW, innerH, sx: (i) => m.l + (xLabels.length === 1 ? innerW / 2 : (i / (xLabels.length - 1)) * innerW) };
}

/* ------------------------------------------------- 호버 / 키보드 리드아웃 */

function attachCrosshair({ svg, host, tip, W, H, m, n, sx, onIndex }) {
  if (n === 0) return;
  const line = el(
    'line',
    { y1: m.t, y2: H - m.b, 'stroke-width': 1, visibility: 'hidden' },
    { stroke: 'var(--baseline)' }
  );
  svg.appendChild(line);
  const dots = el('g', { visibility: 'hidden' });
  svg.appendChild(dots);

  let active = -1;
  const show = (i) => {
    if (i < 0 || i >= n) return;
    active = i;
    const x = sx(i);
    line.setAttribute('x1', x);
    line.setAttribute('x2', x);
    line.setAttribute('visibility', 'visible');
    dots.setAttribute('visibility', 'visible');
    dots.textContent = '';
    const { html, marks } = onIndex(i);
    for (const mk of marks || []) {
      dots.appendChild(
        el('circle', { cx: x, cy: mk.y, r: 4.5, 'stroke-width': 2 }, { fill: mk.color, stroke: 'var(--surface-1)' })
      );
    }
    tip.hidden = false;
    tip.replaceChildren(html);
    const tw = tip.offsetWidth;
    const left = Math.min(Math.max(x - tw / 2, 4), host.clientWidth - tw - 4);
    tip.style.left = `${(left / W) * 100}%`;
    tip.style.top = `${m.t}px`;
    svg.setAttribute('aria-label', tip.textContent);
  };
  const hide = () => {
    line.setAttribute('visibility', 'hidden');
    dots.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  const idxFromEvent = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const innerW = W - m.l - m.r;
    const t = n === 1 ? 0 : ((px - m.l) / innerW) * (n - 1);
    return Math.min(n - 1, Math.max(0, Math.round(t)));
  };
  svg.addEventListener('pointermove', (e) => show(idxFromEvent(e)));
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(active < 0 ? n - 1 : active));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { show(Math.max(0, (active < 0 ? n - 1 : active) - 1)); e.preventDefault(); }
    if (e.key === 'ArrowRight') { show(Math.min(n - 1, (active < 0 ? 0 : active) + 1)); e.preventDefault(); }
    if (e.key === 'Home') { show(0); e.preventDefault(); }
    if (e.key === 'End') { show(n - 1); e.preventDefault(); }
    if (e.key === 'Escape') hide();
  });
}

function tipNode(title, rows) {
  const box = document.createElement('div');
  const h = document.createElement('div');
  h.className = 'tip-title';
  h.textContent = title;
  box.appendChild(h);
  for (const r of rows) {
    const line = document.createElement('div');
    line.className = 'tip-row';
    if (r.color) {
      const key = document.createElement('span');
      key.className = 'tip-key';
      key.style.background = r.color;
      line.appendChild(key);
    } else if (r.indent) {
      const key = document.createElement('span');
      key.className = 'tip-key tip-key-blank';
      line.appendChild(key);
    }
    const val = document.createElement('span');
    val.className = 'tip-val';
    val.textContent = r.value;
    const lab = document.createElement('span');
    lab.className = 'tip-lab';
    lab.textContent = r.label;
    line.append(val, lab);
    box.appendChild(line);
  }
  return box;
}

/* ------------------------------------------------------------ 라인 차트 */

/**
 * cfg: { dates[], series: [{id,label,color,values[],style?:'solid'|'soft'}],
 *        yFmt, tipFmt, height, fillFirst?:boolean }
 */
export function lineChart(host, cfg) {
  const { dates, series, yFmt, tipFmt } = cfg;
  mount(host, cfg.height || 260, ({ svg, W, H, tip }) => {
    const m = { t: 14, r: 16, b: 30, l: cfg.leftPad || 62 };
    const all = series.flatMap((s) => s.values).filter(Number.isFinite);
    let lo = Math.min(...all, cfg.includeZero ? 0 : Infinity);
    let hi = Math.max(...all, cfg.includeZero ? 0 : -Infinity);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
    const ticks = niceTicks(lo - pad, hi + pad, 5);
    const xIdx = xTickIndices(dates.length);
    const { sy, sx } = axes(svg, { W, H, m, yTicks: ticks, yFmt, xLabels: dates.map(shortDate), xIdx });

    // 밴드: 첫 시리즈와 둘째 시리즈 사이를 채운다.
    // 기준선(둘째) 위쪽은 상승색, 아래쪽은 하락색 — 손익 부호가 면적으로 읽힌다.
    if (cfg.band && series.length >= 2) {
      const a = series[0].values.map((v, i) => [sx(i), sy(v)]);
      const b = series[1].values.map((v, i) => [sx(i), sy(v)]);
      const bRev = b.slice().reverse().map((p) => `L ${p[0]} ${p[1]}`).join(' ');
      const bandD =
        a.map((p, i) => `${i ? 'L' : 'M'} ${p[0]} ${p[1]}`).join(' ') + ' ' + bRev + ' Z';
      const defs = el('defs');
      const uid = `band-${Math.round(sy(ticks[0]))}-${dates.length}`;
      for (const [key, edgeY] of [['up', m.t], ['down', H - m.b]]) {
        const clip = el('clipPath', { id: `${uid}-${key}` });
        clip.appendChild(
          el('path', { d: `M ${m.l} ${edgeY} L ${W - m.r} ${edgeY} ${bRev} Z` })
        );
        defs.appendChild(clip);
      }
      svg.appendChild(defs);
      for (const key of ['up', 'down']) {
        svg.appendChild(
          el('path', { d: bandD, 'clip-path': `url(#${uid}-${key})` }, { fill: `var(--${key})`, opacity: '0.16' })
        );
      }
    }

    for (const s of series) {
      const pts = s.values.map((v, i) => [sx(i), sy(v)]);
      if (s.fill) {
        const d =
          `M ${pts[0][0]} ${sy(ticks[0])} ` +
          pts.map((p) => `L ${p[0]} ${p[1]}`).join(' ') +
          ` L ${pts[pts.length - 1][0]} ${sy(ticks[0])} Z`;
        svg.appendChild(el('path', { d }, { fill: s.color, opacity: '0.1' }));
      }
      const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0]} ${p[1]}`).join(' ');
      svg.appendChild(
        el(
          'path',
          { d, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' },
          { stroke: s.color, opacity: s.style === 'soft' ? '0.9' : '1' }
        )
      );
      // 끝점 마커 + 2px 표면 링
      const last = pts[pts.length - 1];
      svg.appendChild(
        el('circle', { cx: last[0], cy: last[1], r: 4.5, 'stroke-width': 2 }, { fill: s.color, stroke: 'var(--surface-1)' })
      );
    }

    attachCrosshair({
      svg, host, tip, W, H, m, n: dates.length, sx,
      onIndex: (i) => ({
        html: tipNode(dates[i], series.map((s) => ({
          color: s.color, label: s.label, value: (tipFmt || yFmt)(s.values[i]),
        }))),
        marks: series.map((s) => ({ y: sy(s.values[i]), color: s.color })),
      }),
    });
  });
}

/* ------------------------------------------------------- 스택 영역 차트 */

/** cfg: { dates[], series: [{id,label,color,values[]}], yFmt, tipFmt, height } */
export function stackedArea(host, cfg) {
  const { dates, series, yFmt, tipFmt } = cfg;
  mount(host, cfg.height || 260, ({ svg, W, H, tip }) => {
    const m = { t: 14, r: 16, b: 30, l: cfg.leftPad || 62 };
    const totals = dates.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
    const ticks = niceTicks(0, Math.max(...totals, 1) * 1.06, 5);
    const xIdx = xTickIndices(dates.length);
    const { sy, sx } = axes(svg, { W, H, m, yTicks: ticks, yFmt, xLabels: dates.map(shortDate), xIdx });

    const cum = dates.map(() => 0);
    const bands = [];
    for (const s of series) {
      const lower = cum.slice();
      const upper = cum.map((c, i) => c + (s.values[i] || 0));
      const top = upper.map((v, i) => `${i ? 'L' : 'M'} ${sx(i)} ${sy(v)}`).join(' ');
      const bot = lower.map((v, i) => `L ${sx(i)} ${sy(v)}`).reverse().join(' ');
      svg.appendChild(el('path', { d: `${top} ${bot} Z` }, { fill: s.color }));
      bands.push({ s, upper });
      for (let i = 0; i < cum.length; i++) cum[i] = upper[i];
    }
    // 스택 경계: 테두리가 아니라 2px 표면색 간격
    for (let b = 0; b < bands.length - 1; b++) {
      const d = bands[b].upper.map((v, i) => `${i ? 'L' : 'M'} ${sx(i)} ${sy(v)}`).join(' ');
      svg.appendChild(
        el('path', { d, fill: 'none', 'stroke-width': 2 }, { stroke: 'var(--surface-1)' })
      );
    }

    attachCrosshair({
      svg, host, tip, W, H, m, n: dates.length, sx,
      onIndex: (i) => ({
        html: tipNode(dates[i], [
          ...series.map((s) => ({ color: s.color, label: s.label, value: (tipFmt || yFmt)(s.values[i] || 0) })),
          { indent: true, label: '합계', value: (tipFmt || yFmt)(totals[i]) },
        ]),
        marks: [],
      }),
    });
  });
}

/* -------------------------------------------------- 다이버징 컬럼 차트 */

/**
 * 일별 증감 등 0 기준 양/음.
 * 한국식 관례에 맞춰 + 는 빨강, − 는 파랑. 값에 항상 부호를 붙여 색만으로
 * 의미를 전달하지 않는다.
 * cfg: { dates[], values[], yFmt, tipFmt, label, height }
 */
export function divergingColumns(host, cfg) {
  const { dates, values, yFmt, tipFmt, label } = cfg;
  mount(host, cfg.height || 200, ({ svg, W, H, tip }) => {
    const m = { t: 14, r: 16, b: 30, l: cfg.leftPad || 62 };
    const hi = Math.max(...values, 0);
    const lo = Math.min(...values, 0);
    const pad = (hi - lo) * 0.1 || 1;
    const ticks = niceTicks(lo - pad, hi + pad, 4);
    const xIdx = xTickIndices(dates.length);
    const { sy, sx, innerW } = axes(svg, { W, H, m, yTicks: ticks, yFmt, xLabels: dates.map(shortDate), xIdx });

    const slot = dates.length > 1 ? innerW / (dates.length - 1) : innerW;
    const bw = Math.max(2, Math.min(24, slot - 2)); // 슬롯을 꽉 채우지 않는다 (2px 간격)
    const zero = sy(0);
    const g = el('g');
    values.forEach((v, i) => {
      const x = sx(i) - bw / 2;
      const y = v >= 0 ? sy(v) : zero;
      const h = Math.max(1, Math.abs(sy(v) - zero));
      const r = Math.min(4, bw / 2, h);
      // 데이터 끝만 4px 라운드, 기준선 쪽은 각지게
      const d = v >= 0
        ? `M ${x} ${y + h} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + bw - r} ${y} Q ${x + bw} ${y} ${x + bw} ${y + r} L ${x + bw} ${y + h} Z`
        : `M ${x} ${y} L ${x} ${y + h - r} Q ${x} ${y + h} ${x + r} ${y + h} L ${x + bw - r} ${y + h} Q ${x + bw} ${y + h} ${x + bw} ${y + h - r} L ${x + bw} ${y} Z`;
      const bar = el('path', { d }, { fill: v >= 0 ? 'var(--up)' : 'var(--down)' });
      g.appendChild(bar);
    });
    svg.appendChild(g);

    attachCrosshair({
      svg, host, tip, W, H, m, n: dates.length, sx,
      onIndex: (i) => ({
        html: tipNode(dates[i], [{
          color: values[i] >= 0 ? 'var(--up)' : 'var(--down)',
          label: label || '증감',
          value: (values[i] > 0 ? '+' : '') + (tipFmt || yFmt)(values[i]),
        }]),
        marks: [],
      }),
    });
  });
}

/* --------------------------------------------------- 스택 컬럼 차트 */

/** cfg: { dates[], series: [{id,label,color,values[]}], yFmt, tipFmt, height } */
export function stackedColumns(host, cfg) {
  const { dates, series, yFmt, tipFmt } = cfg;
  mount(host, cfg.height || 220, ({ svg, W, H, tip }) => {
    const m = { t: 14, r: 16, b: 30, l: cfg.leftPad || 62 };
    const totals = dates.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
    const ticks = niceTicks(0, Math.max(...totals, 1e-9) * 1.15, 4);
    const xIdx = xTickIndices(dates.length);
    const { sy, sx, innerW } = axes(svg, { W, H, m, yTicks: ticks, yFmt, xLabels: dates.map(shortDate), xIdx });

    const slot = dates.length > 1 ? innerW / (dates.length - 1) : innerW;
    const bw = Math.max(2, Math.min(24, slot - 2));
    const GAP = 2; // 세그먼트 사이 표면 간격
    dates.forEach((_, i) => {
      let acc = 0;
      const stack = series.map((s) => {
        const v = s.values[i] || 0;
        const seg = { s, y0: acc, y1: acc + v, v };
        acc += v;
        return seg;
      }).filter((seg) => seg.v > 0);
      stack.forEach((seg, k) => {
        const isTop = k === stack.length - 1;
        const x = sx(i) - bw / 2;
        const yTop = sy(seg.y1);
        const yBot = sy(seg.y0) - (k > 0 ? GAP : 0);
        const h = Math.max(1, yBot - yTop);
        const r = isTop ? Math.min(4, bw / 2, h) : 0;
        const d = r
          ? `M ${x} ${yTop + h} L ${x} ${yTop + r} Q ${x} ${yTop} ${x + r} ${yTop} L ${x + bw - r} ${yTop} Q ${x + bw} ${yTop} ${x + bw} ${yTop + r} L ${x + bw} ${yTop + h} Z`
          : `M ${x} ${yTop} L ${x + bw} ${yTop} L ${x + bw} ${yTop + h} L ${x} ${yTop + h} Z`;
        svg.appendChild(el('path', { d }, { fill: seg.s.color }));
      });
    });

    attachCrosshair({
      svg, host, tip, W, H, m, n: dates.length, sx,
      onIndex: (i) => ({
        html: tipNode(dates[i], [
          ...series.map((s) => ({ color: s.color, label: s.label, value: (tipFmt || yFmt)(s.values[i] || 0) })),
          { indent: true, label: '합계', value: (tipFmt || yFmt)(totals[i]) },
        ]),
        marks: [],
      }),
    });
  });
}

/* --------------------------------------------- 가로 스택 바 (구성 비율) */

/** cfg: { parts: [{id,label,color,value}], fmt } — 현재 자산 배분 */
export function allocationBar(host, cfg) {
  const { parts, fmt } = cfg;
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  host.textContent = '';
  host.classList.add('alloc');

  const bar = document.createElement('div');
  bar.className = 'alloc-bar';
  for (const p of parts) {
    const seg = document.createElement('div');
    seg.className = 'alloc-seg';
    seg.style.flexGrow = String(Math.max(p.value, 0));
    seg.style.background = p.color;
    seg.title = `${p.label} · ${fmt(p.value)} · ${((p.value / total) * 100).toFixed(1)}%`;
    seg.setAttribute('role', 'listitem');
    seg.setAttribute('aria-label', seg.title);
    bar.appendChild(seg);
  }
  bar.setAttribute('role', 'list');
  host.appendChild(bar);

  const list = document.createElement('ul');
  list.className = 'alloc-list';
  for (const p of parts) {
    const li = document.createElement('li');
    const key = document.createElement('span');
    key.className = 'swatch';
    key.style.background = p.color;
    const name = document.createElement('span');
    name.className = 'alloc-name';
    name.textContent = p.label;
    const val = document.createElement('span');
    val.className = 'alloc-val';
    val.textContent = fmt(p.value);
    const pct = document.createElement('span');
    pct.className = 'alloc-pct';
    pct.textContent = ((p.value / total) * 100).toFixed(1) + '%';
    li.append(key, name, val, pct);
    list.appendChild(li);
  }
  host.appendChild(list);
}

/* ------------------------------------------------------------ 스파크라인 */

export function sparkline(host, values, color) {
  host.textContent = '';
  if (!values || values.length < 2) return;
  const W = 120, H = 32, p = 3;
  const lo = Math.min(...values), hi = Math.max(...values);
  const sy = (v) => p + (H - 2 * p) * (1 - (v - lo) / (hi - lo || 1));
  const sx = (i) => p + ((W - 2 * p) * i) / (values.length - 1);
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', class: 'spark' });
  const d = values.map((v, i) => `${i ? 'L' : 'M'} ${sx(i)} ${sy(v)}`).join(' ');
  svg.appendChild(el('path', { d, fill: 'none', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, { stroke: color }));
  svg.appendChild(el('circle', { cx: sx(values.length - 1), cy: sy(values[values.length - 1]), r: 3, 'stroke-width': 2 }, { fill: color, stroke: 'var(--surface-1)' }));
  host.appendChild(svg);
}

/* ------------------------------------------------------------- 범례 */

export function legend(host, items) {
  host.textContent = '';
  host.className = 'legend';
  for (const it of items) {
    const s = document.createElement('span');
    s.className = 'legend-item';
    const k = document.createElement('span');
    k.className = it.shape === 'line' ? 'legend-line' : 'swatch';
    k.style.background = it.color;
    const t = document.createElement('span');
    t.textContent = it.label;
    s.append(k, t);
    host.appendChild(s);
  }
}
