import { buildSeries, currencyFns, fmtNum, fmtKrw, fmtUsdt, signOf, acctUsdt } from './core.js';
import { lineChart, stackedArea, divergingColumns, allocationBar, sparkline, legend } from './charts.js';

const $ = (sel, root = document) => root.querySelector(sel);

// URL 파라미터가 저장값보다 우선한다 — 특정 화면을 북마크/공유할 수 있게.
//   ?currency=USDT&range=30&theme=dark
const params = new URLSearchParams(location.search);
const state = {
  currency: params.get('currency') || localStorage.getItem('cdb.currency') || 'KRW',
  range: params.get('range') || localStorage.getItem('cdb.range') || '90',
  data: null,
};

/* ------------------------------------------------------------- 데이터 로드 */

async function loadJSON(path, fallback) {
  try {
    const res = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

async function boot() {
  let config, flows, snapshots;
  try {
    [config, flows, snapshots] = await Promise.all([
      loadJSON('./data/config.json'),
      loadJSON('./data/flows.json', []),
      loadJSON('./data/snapshots.json', []),
    ]);
  } catch (e) {
    $('#app').innerHTML = '';
    const box = document.createElement('div');
    box.className = 'card empty';
    box.textContent =
      'data/ 아래 JSON을 읽지 못했습니다. 로컬에서 열었다면 file:// 대신 `node tools/cdb.mjs serve` 로 실행하세요.';
    $('#app').appendChild(box);
    return;
  }
  state.data = buildSeries(config, flows, snapshots);
  state.config = config;
  renderChrome();
  render();
}

/* ------------------------------------------------------------------ 크롬 */

function renderChrome() {
  const { config } = state;
  $('#title').textContent = config.title || 'Crypto Dashboard';
  const latest = state.data.latest;
  $('#subtitle').textContent = latest
    ? `기준일 ${latest.date} · 1 USDT = ${fmtNum(latest.fx, 1)}원 · 계좌 ${state.data.accounts.length}곳`
    : '기록된 스냅샷이 없습니다';

  if (config.sample) {
    const b = document.createElement('div');
    b.className = 'banner';
    b.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = '샘플 데이터입니다. ';
    b.appendChild(strong);
    b.appendChild(
      document.createTextNode('실제 기록을 시작하려면 `node tools/cdb.mjs reset` 을 실행하세요.')
    );
    $('#banner').replaceChildren(b);
  }

  // 통화 / 기간 필터 — 한 줄, 아래 모든 것을 스코프한다
  bindSegmented('#currency', state.currency, (v) => {
    state.currency = v;
    localStorage.setItem('cdb.currency', v);
    render();
  });
  bindSegmented('#range', state.range, (v) => {
    state.range = v;
    localStorage.setItem('cdb.range', v);
    render();
  });

  $('#theme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('cdb.theme', next);
    render();
  });
}

function bindSegmented(sel, value, onChange) {
  const root = $(sel);
  const sync = (v) => {
    for (const b of root.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.value === v));
    }
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    sync(b.dataset.value);
    onChange(b.dataset.value);
  });
  sync(value);
}

/* ------------------------------------------------------------- 렌더 헬퍼 */

function card(title, hint) {
  const c = document.createElement('div');
  c.className = 'card';
  if (title) {
    const h = document.createElement('header');
    const h2 = document.createElement('h2');
    h2.textContent = title;
    h.appendChild(h2);
    if (hint) {
      const s = document.createElement('span');
      s.className = 'hint';
      s.textContent = hint;
      h.appendChild(s);
    }
    c.appendChild(h);
  }
  return c;
}

function tile(label, value, opts = {}) {
  const c = card();
  c.classList.add('tile');
  const l = document.createElement('div');
  l.className = 'label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'value';
  v.textContent = value;
  // 괄호 병기값은 한 단계 작게 — 24px로 같이 쓰면 줄바꿈으로 깨진다
  if (opts.ex) {
    const e = document.createElement('span');
    e.className = 'ex';
    e.textContent = `(${opts.ex})`;
    v.appendChild(e);
  }
  c.append(l, v);

  const foot = document.createElement('div');
  foot.className = 'foot';
  if (opts.delta !== undefined) {
    const d = document.createElement('span');
    d.className = 'delta ' + (opts.delta > 0 ? 'up' : opts.delta < 0 ? 'down' : 'flat');
    const arrow = opts.delta > 0 ? '▲ ' : opts.delta < 0 ? '▼ ' : '– ';
    d.textContent = arrow + (opts.delta > 0 ? '+' : opts.delta < 0 ? '-' : '') + opts.deltaText;
    foot.appendChild(d);
  } else if (opts.note) {
    const n = document.createElement('span');
    n.className = 'note';
    n.textContent = opts.note;
    foot.appendChild(n);
  }
  if (opts.spark && opts.spark.length > 1) {
    const s = document.createElement('span');
    sparkline(s, opts.spark, opts.sparkColor || 'var(--acct-BT)');
    foot.appendChild(s);
  }
  c.appendChild(foot);
  return c;
}

function grid(cls) {
  const g = document.createElement('div');
  g.className = 'grid ' + cls;
  return g;
}

function section(title) {
  const s = document.createElement('section');
  if (title) {
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = title;
    s.appendChild(h);
  }
  return s;
}

function chartHost() {
  const d = document.createElement('div');
  return d;
}

function acctColor(id) {
  return `var(--acct-${id})`;
}

/* ---------------------------------------------------------------- 렌더 */

function render() {
  const app = $('#app');
  app.textContent = '';
  const { rows: allRows, accounts } = state.data;

  if (!allRows.length) {
    const c = card();
    c.classList.add('empty');
    c.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = '아직 데이터가 없습니다. 터미널에서 첫 입금과 잔고를 기록해 보세요.';
    const pre = document.createElement('pre');
    pre.textContent =
      'node tools/cdb.mjs deposit 5000000 --fx 1380\n' +
      'node tools/cdb.mjs snap --bt 20 --ok 1500 --na 800 --bc 900 --bf 400 --fx 1382';
    c.append(p, pre);
    app.appendChild(c);
    return;
  }

  const n = state.range === 'all' ? allRows.length : Math.min(allRows.length, Number(state.range));
  const rows = allRows.slice(-n);
  const cur = currencyFns(state.currency);
  const K = cur.key; // 'Krw' | 'Usdt'
  const dates = rows.map((r) => r.date);
  const last = rows[rows.length - 1];
  const other = state.currency === 'KRW' ? fmtUsdt(last.valUsdt) : fmtKrw(last.valKrw);

  /* ---- 히어로 --------------------------------------------------- */
  const heroCard = card();
  heroCard.classList.add('hero');
  const left = document.createElement('div');
  const hl = document.createElement('div');
  hl.className = 'label';
  hl.textContent = '현재평가액';
  const hv = document.createElement('div');
  hv.className = 'value';
  // 큰 숫자는 지금 실제로 손에 있는 값(미래분 제외).
  // 괄호는 예정 보너스까지 더한 값 — 보조로 작게 병기한다.
  hv.textContent = cur.full(last[`future${K}`] > 0 ? last[`valEx${K}`] : last[`val${K}`]);
  if (last[`future${K}`] > 0) {
    const ex = document.createElement('span');
    ex.className = 'ex';
    ex.textContent = `(${cur.full(last[`val${K}`])})`;
    hv.appendChild(ex);
  }
  const ha = document.createElement('div');
  ha.className = 'alt';
  ha.textContent =
    last[`future${K}`] > 0
      ? `괄호 안은 미래분 포함 · ${other} · ${last.date} 기준`
      : `${other} · ${last.date} 기준`;
  left.append(hl, hv, ha);

  // 입금 기록이 없으면 원금이 0이라 "수익 = 평가액"이 되어 버린다.
  // 그건 수익이 아니므로 계산하지 않고 비워 둔다.
  // 판단 기준은 "입출금 기록이 하나라도 있는가"다. 순 입금액이 0이나 음수여도
  // (전액 회수·초과 인출) 수익은 계산된다 — 오히려 그때가 확실한 실현 손익이다.
  const hasBasis = state.data.flows.some((f) => f.date <= last.date);

  const side = document.createElement('div');
  side.className = 'side';
  side.append(
    heroRow(
      '총 수익',
      hasBasis ? withEx(last, 'profit', cur, K) : '—',
      hasBasis ? last[last[`future${K}`] > 0 ? `profitEx${K}` : `profit${K}`] : 0
    )
  );
  heroCard.append(left, side);
  app.appendChild(heroCard);

  /* ---- KPI 타일 -------------------------------------------------- */
  const kpi = grid('k4');
  kpi.style.marginTop = '14px';
  kpi.append(
    // 출금이 입금을 넘어서면 순 입금액이 음수가 된다. "순 입금액 -30만"은
    // 읽기 어려우므로 라벨을 뒤집어 "순 출금액 30만"으로 보여준다.
    tile(last[`dep${K}`] < 0 ? '순 출금액' : '순 입금액', cur.full(Math.abs(last[`dep${K}`])), {
      note:
        state.data.flows.length === 0
          ? '입금 기록을 먼저 넣어야 수익이 나옵니다'
          : `입금 ${state.data.flows.filter((f) => f.sign > 0).length}건 − 출금 ${state.data.flows.filter((f) => f.sign < 0).length}건`,
    }),
    tile('총 수익', hasBasis ? signed(last[last[`future${K}`] > 0 ? `profitEx${K}` : `profit${K}`], cur.full) : '—', {
      ex: hasBasis && last[`future${K}`] > 0 ? signed(last[`profit${K}`], cur.full) : null,
      spark: hasBasis ? rows.map((r) => r[`profit${K}`]) : null,
      sparkColor: last[`profit${K}`] >= 0 ? 'var(--up)' : 'var(--down)',
      note: hasBasis ? `${rows.length}일 구간` : '원금 없음',
    }),
    tile('예정된 보너스', cur.full(last[`bonus${K}`]), {
      spark: rows.map((r) => r[`bonus${K}`]),
      sparkColor: 'var(--ref)',
      note: '괄호 값에 포함 · 직접 입력',
    }),
    tile('예정될 보너스', cur.full(last[`bonus2${K}`]), {
      spark: rows.map((r) => r[`bonus2${K}`]),
      sparkColor: 'var(--ref)',
      note:
        last.seedUsdt > 0
          ? `시드 ${fmtNum(last.seedUsdt, 0)} × ${((state.config.futureBonusRate ?? 0.0017) * 100).toFixed(2)}%`
          : '시드 미입력',
    })
  );
  app.appendChild(kpi);

  /* ---- 돼지저금통 -------------------------------------------------- */
  // 계좌 밖 주머니일 뿐 성격은 현금과 같다. 그래서 미래분이 아니라
  // 평가액·일별 손익·자산 배분에 그대로 들어간다.
  // 목표 대비 막대는 보는 재미용이라 100%에서 멈춘다.
  if (last.piggyUsdt > 0) {
    const goal = state.currency === 'KRW' ? last.piggyGoalKrw : last.piggyGoalUsdt;
    const pig = card();
    pig.classList.add('meter');
    pig.title = `목표 ${cur.full(goal)} · ${fmtUsdt(last.piggyUsdt)}${last.piggyStart ? ` · ${last.piggyStart} 시작` : ''}`;

    const plb = document.createElement('span');
    plb.className = 'meter-label';
    plb.textContent = last.piggyDay > 0 ? `돼지저금통 (${last.piggyDay}일차)` : '돼지저금통';

    const pav = document.createElement('span');
    pav.className = 'meter-amt';
    pav.textContent = cur.full(last[`piggy${K}`]);

    const ptr = document.createElement('div');
    ptr.className = 'meter-track';
    ptr.setAttribute('role', 'progressbar');
    ptr.setAttribute('aria-valuenow', last.piggyPct.toFixed(1));
    ptr.setAttribute('aria-valuemin', '0');
    ptr.setAttribute('aria-valuemax', '100');
    ptr.setAttribute('aria-label', `돼지저금통 목표 ${cur.full(goal)} 대비 ${last.piggyPct.toFixed(1)}%`);
    const pfl = document.createElement('div');
    pfl.className = 'meter-fill piggy';
    pfl.style.width = `${last.piggyPct}%`;
    ptr.appendChild(pfl);

    const ppc = document.createElement('span');
    ppc.className = 'meter-pct';
    ppc.textContent = `${last.piggyPct >= 100 ? 100 : last.piggyPct.toFixed(1)}% / ${cur.compact(goal)}`;

    pig.append(plb, pav, ptr, ppc);
    const ps0 = section();
    ps0.appendChild(pig);
    app.appendChild(ps0);
  }

  /* ---- 레벨업 진행율 ----------------------------------------------- */
  // 한 줄짜리 미터. 값 하나라 카드 헤더 없이 라벨·금액·막대·퍼센트를 가로로 붙여
  // 높이를 최소로 가져간다. 채움/트랙은 같은 파랑 계열 두 단계.
  if (last.progressPct > 0) {
    const label = state.config.progressLabel || '진행율';
    const pc = card();
    pc.classList.add('meter');
    pc.title = `${fmtNum(state.config.progressBase ?? 0, 0)} USDT 기준 · ${fmtUsdt(last.progressUsdt)}`;

    const lb = document.createElement('span');
    lb.className = 'meter-label';
    lb.textContent = label;

    const amt = document.createElement('span');
    amt.className = 'meter-amt';
    amt.textContent = cur.full(last[`progress${K}`]);

    const track = document.createElement('div');
    track.className = 'meter-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuenow', String(last.progressPct));
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-label', `${label} ${last.progressPct}%`);
    const fill = document.createElement('div');
    fill.className = 'meter-fill';
    fill.style.width = `${Math.min(100, Math.max(0, last.progressPct))}%`;
    track.appendChild(fill);

    const pct = document.createElement('span');
    pct.className = 'meter-pct';
    pct.textContent = `${last.progressPct}%`;

    pc.append(lb, amt, track, pct);
    const ps = section();
    ps.appendChild(pc);
    app.appendChild(ps);
  }

  /* ---- 일별 손익 --------------------------------------------------- */
  const s2 = section();
  const c3 = card('일별 손익');
  const h3 = chartHost();
  c3.appendChild(h3);
  s2.appendChild(c3);
  app.appendChild(s2);
  divergingColumns(h3, {
    dates,
    height: 250,
    label: '일별 손익',
    showValues: true,
    labelFmt: cur.full,  // 막대 값은 축약 없이 그대로
    yFmt: cur.compact,
    tipFmt: cur.full,
    values: rows.map((r) => r[`dProfitEx${K}`]),
  });

  /* ---- 평가액 vs 원금 ------------------------------------------ */
  const s1 = section();
  const c1 = card('평가액과 원금');
  const h1 = chartHost();
  c1.appendChild(h1);
  const lg1 = document.createElement('div');
  c1.appendChild(lg1);
  s1.appendChild(c1);
  app.appendChild(s1);
  lineChart(h1, {
    dates,
    height: 280,
    band: true,
    yFmt: cur.compact,
    tipFmt: cur.full,
    series: [
      // 이 카드의 주인공은 두 선이 아니라 그 사이의 면적이다.
      // 선은 중립 잉크로 두고, 색은 수익/손실 밴드에만 쓴다.
      { id: 'val', label: '총 평가액', color: 'var(--text-primary)', values: rows.map((r) => r[`valEx${K}`]) },
      { id: 'dep', label: '순 입금액(원금)', color: 'var(--ref)', values: rows.map((r) => r[`dep${K}`]), style: 'soft' },
    ],
  });
  legend(lg1, [
    { label: '총 평가액', color: 'var(--text-primary)', shape: 'line' },
    { label: '순 입금액(원금)', color: 'var(--ref)', shape: 'line' },
    { label: '원금 초과 (수익)', color: 'var(--up)' },
    { label: '원금 미달 (손실)', color: 'var(--down)' },
  ]);

  /* ---- 계좌별 잔고 추이 + 현재 배분 -------------------------------- */
  const s3 = section();
  const g3 = grid('wide');
  const c4 = card('계좌별 잔고 추이');
  const h4 = chartHost();
  const lg4 = document.createElement('div');
  c4.append(h4, lg4);
  const c5 = card('현재 자산 배분', last.date);
  const h5 = chartHost();
  c5.appendChild(h5);
  g3.append(c4, c5);
  s3.appendChild(g3);
  app.appendChild(s3);

  // 보너스는 계좌가 아니라 아직 들어오지 않은 몫이다. 카테고리 색을 주지 않고
  // 중립 회색으로 둬서 실제 보유와 구분한다. 평가액에는 포함되므로 스택에도 넣어야
  // 차트 총합이 히어로 숫자와 맞는다.
  const acctSeries = accounts.map((a) => ({
    id: a.id,
    label: a.name,
    color: acctColor(a.id),
    values: rows.map((r) => acctValue(r, a.id, state.currency)),
  }));

  stackedArea(h4, { dates, height: 280, yFmt: cur.compact, tipFmt: cur.full, series: acctSeries });
  if (rows.some((r) => r.piggyUsdt > 0)) {
    acctSeries.push({
      id: '_piggy',
      label: '돼지저금통',
      color: 'var(--piggy)',
      values: rows.map((r) => r[`piggy${K}`]),
    });
  }
  legend(lg4, acctSeries.map((x) => ({ label: x.label, color: x.color })));
  allocationBar(h5, {
    fmt: cur.full,
    parts: [
      ...accounts.map((a) => ({
        id: a.id,
        label: a.name,
        color: acctColor(a.id),
        value: acctValue(last, a.id, state.currency),
      })),
      ...(last.piggyUsdt > 0
        ? [{ id: '_piggy', label: '돼지저금통', color: 'var(--piggy)', value: last[`piggy${K}`] }]
        : []),
    ],
  });

  /* ---- 스테이킹 ---------------------------------------------------- */
  // 스테이킹 총액과 일평균 배당은 계산값이 아니라 사용자가 직접 유지하는 값이다.
  // 다시 입력하기 전까지 직전 값이 그대로 이월된다.
  const yieldAccts = accounts.filter((a) => a.yield);
  if (yieldAccts.length) {
    const s4 = section('스테이킹');
    const g4 = document.createElement('div');
    g4.className = 'yield-grid';
    const inCur = (v) => v * (state.currency === 'KRW' ? last.fx : 1);

    for (const a of yieldAccts) {
      const st = inCur(last.per[a.id].staked);
      const av = inCur(last.per[a.id].avgDiv);
      g4.appendChild(
        tile(`${a.name} 스테이킹 총액`, cur.full(st), {
          note: st > 0 ? `총 평가액의 ${((st / (last[`val${K}`] || 1)) * 100).toFixed(1)}%` : '없음',
        })
      );
      g4.appendChild(
        tile(`${a.name} 일평균 배당`, cur.full(av), {
          note: av > 0 && st > 0 ? `스테이킹의 일 ${((av / st) * 100).toFixed(3)}%` : '직접 입력',
        })
      );
    }

    s4.appendChild(g4);
    app.appendChild(s4);
  }

  /* ---- 입출금 내역 ------------------------------------------------- */
  app.appendChild(buildFlows(state.data.flows, rows, cur, K));

  /* ---- 표 보기 (모든 값은 표에서도 읽을 수 있다) --------------------- */
  app.appendChild(buildTable(rows, accounts, cur, K));

  /* ---- 각주 ------------------------------------------------------- */
  const note = document.createElement('p');
  note.className = 'foot-note';
  note.textContent =
    state.currency === 'KRW'
      ? '원화 기준 수익에는 USDT/원 환율 변동 효과가 포함됩니다. 순수 코인 운용 성과만 보려면 통화를 USDT로 바꾸세요.'
      : 'USDT 기준 수익은 환율 변동을 제외한 순수 운용 성과입니다. 원화 입금액은 입금 시점 환율로 USDT 환산했습니다.';
  app.appendChild(note);
}

function acctValue(row, id, currency) {
  const p = row.per[id];
  const u = acctUsdt(p); // 자유 잔고 + 스테이킹
  return currency === 'KRW' ? u * row.fx + p.krw : u + p.krw / row.fx;
}

function heroRow(k, v, dir) {
  const r = document.createElement('div');
  r.className = 'row';
  const ks = document.createElement('span');
  ks.className = 'k';
  ks.textContent = k;
  const vs = document.createElement('span');
  vs.className = 'v ' + dirClass(dir);
  vs.textContent = v;
  r.append(ks, vs);
  return r;
}

function dirClass(v) {
  const s = signOf(v);
  return s > 0 ? 'up' : s < 0 ? 'down' : 'flat';
}

/** "미래분 제외값 (포함값)" — 보너스가 0이면 한 값만 */
function withEx(row, key, cur, K) {
  if (!(row[`future${K}`] > 0)) return signed(row[`${key}${K}`], cur.full);
  return `${signed(row[`${key}Ex${K}`], cur.full)} (${signed(row[`${key}${K}`], cur.full)})`;
}

function signed(v, fmt) {
  const s = signOf(v);
  return (s > 0 ? '+' : s < 0 ? '-' : '') + fmt(Math.abs(v));
}

/**
 * 입출금 내역 — 원금이 어떻게 만들어졌는지 보여준다.
 * 입금/출금은 손익이 아니라 원금의 이동이므로 수익 색(적/청)을 쓰지 않는다.
 */
function buildFlows(allFlows, rows, cur, K) {
  const s = section('입출금');
  const key = K === 'Krw' ? 'krw' : 'usdt'; // buildSeries가 부호까지 넣어 둔 값

  // 이 표는 시계열이 아니라 원장이다. 기간 필터로 자르지 않는다 —
  // 합계와 순 입금액이 전체 기준인데 목록만 잘리면 서로 안 맞는다.
  // 스냅샷보다 앞선 입금이 통째로 사라지는 문제도 여기서 생겼다.
  const MAX = 20;
  const recent = allFlows.slice().reverse();
  const shown = recent.slice(0, MAX);
  const from = rows[0].date;

  const sum = (list) => list.reduce((a, f) => a + Math.abs(f[key]), 0);
  const deposits = allFlows.filter((f) => f.sign > 0);
  const withdrawals = allFlows.filter((f) => f.sign < 0);

  const g = grid('wide');
  const c = card('입출금 내역', allFlows.length ? `전체 ${allFlows.length}건` : null);

  if (!allFlows.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '입금 기록이 없습니다. 원금이 있어야 수익을 계산할 수 있습니다.';
    c.appendChild(p);
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const t = document.createElement('table');
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const h of ['날짜', '구분', '금액', '메모']) {
      const th = document.createElement('th');
      th.textContent = h;
      if (h === '메모') th.style.textAlign = 'left';
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    t.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const f of shown) {
      const tr = document.createElement('tr');
      // 현재 보고 있는 기간보다 앞선 건은 날짜를 흐리게 — 차트에는 안 그려지지만
      // 원금에는 포함된다는 걸 드러낸다
      const older = f.date < from;
      const cells = [
        f.date,
        f.sign > 0 ? '입금' : '출금',
        signed(f[key], cur.full),
        f.note || '—',
      ];
      cells.forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v;
        if (i === 0 && older) td.style.color = 'var(--muted)';
        if (i === 3) {
          td.style.textAlign = 'left';
          td.style.color = 'var(--muted)';
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    t.appendChild(tbody);
    wrap.appendChild(t);
    c.appendChild(wrap);

    if (recent.length > MAX) {
      const n = document.createElement('p');
      n.className = 'foot-note';
      n.style.marginTop = '10px';
      n.textContent = `최근 ${MAX}건만 표시했습니다 (전체 ${recent.length}건). 합계에는 모두 포함됩니다.`;
      c.appendChild(n);
    }
  }

  const side = document.createElement('div');
  side.className = 'yield-grid';
  side.append(
    tile('총 입금', cur.full(sum(deposits)), { note: `${deposits.length}건` }),
    tile('총 출금', cur.full(sum(withdrawals)), { note: `${withdrawals.length}건` })
  );

  g.append(c, side);
  s.appendChild(g);
  return s;
}

function buildTable(rows, accounts, cur, K) {
  const d = document.createElement('details');
  d.className = 'tableview';
  // 기본은 펼침. ?table=0 으로 접은 상태를 북마크할 수 있다.
  d.open = params.get('table') !== '0';
  const sm = document.createElement('summary');
  sm.textContent = `표로 보기 (${rows.length}일)`;
  d.appendChild(sm);

  const c = card();
  c.style.marginTop = '10px';
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const t = document.createElement('table');

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  const heads = ['날짜', ...accounts.map((a) => a.name), '총 평가액', '순 입금', '누적 수익', '일별 손익', '입출금'];
  heads.forEach((h, i) => {
    const th = document.createElement('th');
    if (i >= 1 && i <= accounts.length) {
      const box = document.createElement('span');
      box.className = 'acct-head';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = acctColor(accounts[i - 1].id);
      const tx = document.createElement('span');
      tx.textContent = h;
      box.append(sw, tx);
      th.appendChild(box);
      th.style.textAlign = 'right';
    } else {
      th.textContent = h;
    }
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  t.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const r of rows.slice().reverse()) {
    const tr = document.createElement('tr');
    const cells = [
      r.date,
      ...accounts.map((a) => cur.compact(acctValue(r, a.id, state.currency))),
      cur.full(r[`valEx${K}`]),
      cur.compact(r[`dep${K}`]),
      signed(r[`profitEx${K}`], cur.full),
      signed(r[`dProfitEx${K}`], cur.compact),
      r[`flow${K}`] ? signed(r[`flow${K}`], cur.compact) : '—',
    ];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      td.textContent = v;
      if (heads[i] === '누적 수익' || heads[i] === '일별 손익') {
        const raw = heads[i] === '누적 수익' ? r[`profitEx${K}`] : r[`dProfitEx${K}`];
        td.className = dirClass(raw);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  wrap.appendChild(t);
  c.appendChild(wrap);
  d.appendChild(c);
  return d;
}

/* ------------------------------------------------------------------ 시작 */

const savedTheme = params.get('theme') || localStorage.getItem('cdb.theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
boot();
