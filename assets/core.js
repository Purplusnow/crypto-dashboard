/**
 * core.js — 데이터 정규화 및 파생 계산.
 * 브라우저(대시보드)와 Node(CLI)가 같은 로직을 공유하는 순수 ES 모듈.
 * DOM/파일시스템에 의존하지 않는다.
 */

/* ---------------------------------------------------------------- 날짜 유틸 */

export function today() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

export function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const nd = new Date(t);
  return [
    nd.getUTCFullYear(),
    String(nd.getUTCMonth() + 1).padStart(2, '0'),
    String(nd.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export function daysBetween(a, b) {
  const p = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((p(b) - p(a)) / 86400000);
}

/* ------------------------------------------------------------- 정규화 */

const EMPTY_ACC = () => ({ usdt: 0, krw: 0, staked: 0, avgDiv: 0 });

/**
 * 계좌의 USDT 총액 = 자유 잔고 + 스테이킹.
 * 스테이킹은 잔고의 일부가 아니라 **별도 바구니**다 — 거래소에서 스팟 잔고와
 * 스테이킹(Earn) 잔고가 따로 보이는 것과 같다. 그래서 둘을 더해야 총액이 된다.
 */
export function acctUsdt(p) {
  return (p?.usdt || 0) + (p?.staked || 0);
}

/**
 * 스냅샷 하나를 정규화한다.
 * 기입되지 않은 필드는 0이 아니라 undefined로 남긴다 — "직전 값 유지"가 맞기 때문.
 * carry-forward는 buildSeries가 필드 단위로 처리한다.
 */
function normalizeSnapshot(snap, accountIds) {
  const out = { date: snap.date, fx: snap.fx ?? null, note: snap.note || '', balances: {} };
  for (const id of accountIds) {
    const raw = snap.balances?.[id];
    if (raw === undefined || raw === null) continue;
    const v = typeof raw === 'number' ? { usdt: raw } : raw;
    const acc = {};
    for (const k of ['usdt', 'krw', 'staked', 'avgDiv']) {
      if (v[k] !== undefined && v[k] !== null) acc[k] = num(v[k]);
    }
    out.balances[id] = acc;
  }
  return out;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* --------------------------------------------------------- 시계열 파생 */

/**
 * @param {object} config   data/config.json
 * @param {Array}  flows    data/flows.json  (외부 입출금)
 * @param {Array}  snapshots data/snapshots.json (일별 잔고)
 * @returns {{rows: Array, accounts: Array, latest: object|null, flows: Array}}
 */
export function buildSeries(config, flows, snapshots) {
  const accounts = config.accounts.slice().sort((a, b) => a.slot - b.slot);
  const ids = accounts.map((a) => a.id);
  const defaultFx = num(config.defaultFx) || 1380;

  const snaps = (snapshots || [])
    .filter((s) => isDate(s.date))
    .map((s) => normalizeSnapshot(s, ids))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // fx carry-forward → backward-fill
  let lastFx = null;
  for (const s of snaps) {
    if (s.fx) lastFx = s.fx;
    else s.fx = lastFx;
  }
  let nextFx = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].fx) nextFx = snaps[i].fx;
    else snaps[i].fx = nextFx ?? defaultFx;
  }

  // fxMode: 'latest' — 모든 날짜에 가장 최근 환율 하나를 적용한다.
  // 일별 환율을 따로 관리하지 않겠다는 선택. 대신 환율이 움직이면 과거 날짜의
  // 원화 환산도 같이 바뀐다 (어제 본 원화 수익과 오늘 보는 값이 달라진다).
  // 'daily'(기본) 는 그날 환율을 그날에 고정해 시계열이 안 흔들린다.
  if (config.fxMode === 'latest' && snaps.length) {
    const latestFx = snaps[snaps.length - 1].fx;
    for (const s of snaps) s.fx = latestFx;
  }

  const fxAt = (date) => {
    let fx = null;
    for (const s of snaps) {
      if (s.date <= date) fx = s.fx;
      else break;
    }
    return fx ?? snaps[0]?.fx ?? defaultFx;
  };

  // 외부 입출금 정규화: KRW/USDT 양쪽 환산값을 미리 계산해 둔다.
  const fl = (flows || [])
    .filter((f) => isDate(f.date))
    .map((f) => {
      const sign = f.type === 'withdraw' ? -1 : 1;
      const cur = (f.currency || 'KRW').toUpperCase();
      const fx = num(f.fx) || fxAt(f.date);
      const amt = num(f.amount);
      return {
        ...f,
        currency: cur,
        fx,
        sign,
        krw: sign * (cur === 'KRW' ? amt : amt * fx),
        usdt: sign * (cur === 'USDT' ? amt : amt / fx),
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 계좌별 잔고 carry-forward
  const carried = Object.fromEntries(ids.map((id) => [id, EMPTY_ACC()]));
  const rows = [];
  let fi = 0;
  let cumDepKrw = 0;
  let cumDepUsdt = 0;
  let prev = null;

  for (const s of snaps) {
    // 이 날짜까지의 외부 입출금 누적
    while (fi < fl.length && fl[fi].date <= s.date) {
      cumDepKrw += fl[fi].krw;
      cumDepUsdt += fl[fi].usdt;
      fi++;
    }

    const per = {};
    for (const id of ids) {
      const given = s.balances[id] || {};
      const base = carried[id];
      // 전부 "현재 상태"라서 기입이 없으면 직전 값을 이월한다.
      // avgDiv(일평균 배당)는 그날 발생액이 아니라 사용자가 직접 유지하는
      // 값이므로, 다시 입력하기 전까지 계속 같은 값으로 남는다.
      const merged = {
        usdt: given.usdt ?? base.usdt,
        krw: given.krw ?? base.krw,
        staked: given.staked ?? base.staked,
        avgDiv: given.avgDiv ?? base.avgDiv,
      };
      carried[id] = { ...merged };
      per[id] = merged;
    }

    const fx = s.fx;
    const totalUsdt = ids.reduce((a, id) => a + acctUsdt(per[id]), 0);
    const totalKrwCash = ids.reduce((a, id) => a + per[id].krw, 0);
    // 평가액: 원화 잔고는 fx로 USDT 환산해 합산
    const valUsdt = totalUsdt + totalKrwCash / fx;
    const valKrw = totalUsdt * fx + totalKrwCash;

    const stakedUsdt = ids.reduce((a, id) => a + per[id].staked, 0);
    const avgDivUsdt = ids.reduce((a, id) => a + per[id].avgDiv, 0);

    const row = {
      date: s.date,
      fx,
      note: s.note,
      per,
      valUsdt,
      valKrw,
      depUsdt: cumDepUsdt,
      depKrw: cumDepKrw,
      profitUsdt: valUsdt - cumDepUsdt,
      profitKrw: valKrw - cumDepKrw,
      roiUsdt: cumDepUsdt > 0 ? (valUsdt - cumDepUsdt) / cumDepUsdt : 0,
      roiKrw: cumDepKrw > 0 ? (valKrw - cumDepKrw) / cumDepKrw : 0,
      stakedUsdt,
      stakedKrw: stakedUsdt * fx,
      avgDivUsdt,
      avgDivKrw: avgDivUsdt * fx,
      // 전일 대비
      dValUsdt: prev ? valUsdt - prev.valUsdt : 0,
      dValKrw: prev ? valKrw - prev.valKrw : 0,
      dProfitUsdt: prev ? valUsdt - cumDepUsdt - prev.profitUsdt : 0,
      dProfitKrw: prev ? valKrw - cumDepKrw - prev.profitKrw : 0,
      // 그날 순수 외부 입출금 (손익 왜곡 방지용 참고값)
      flowUsdt: 0,
      flowKrw: 0,
    };
    prev = row;
    rows.push(row);
  }

  // 각 스냅샷 날짜에 발생한 외부 입출금액 표시
  for (const f of fl) {
    const r = rows.find((x) => x.date >= f.date);
    if (r) {
      r.flowUsdt += f.usdt;
      r.flowKrw += f.krw;
    }
  }

  return { rows, accounts, flows: fl, latest: rows[rows.length - 1] || null };
}

/* ------------------------------------------------------------- 포맷터 */

export function fmtNum(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtKrw(v) {
  if (!Number.isFinite(v)) return '—';
  return '₩' + Math.round(v).toLocaleString('ko-KR');
}

export function fmtUsdt(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return fmtNum(v, digits) + ' USDT';
}

/** 한국식 축약: 1.52억 / 523만 / 8,400 */
export function fmtKrwCompact(v) {
  if (!Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e8) return sign + '₩' + trim(a / 1e8) + '억';
  if (a >= 1e4) return sign + '₩' + trim(a / 1e4) + '만';
  return sign + '₩' + Math.round(a).toLocaleString('ko-KR');
}

export function fmtUsdtCompact(v) {
  if (!Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e6) return sign + trim(a / 1e6) + 'M';
  if (a >= 1e4) return sign + trim(a / 1e3) + 'K';
  return sign + a.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
}

function trim(n) {
  const s = n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
  // 소수부의 뒤따르는 0만 정리한다. 정수부의 0을 지우면 2600 → 26 이 된다.
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function fmtPct(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return (v * 100).toFixed(digits) + '%';
}

/**
 * 표시용 부호(-1 / 0 / 1).
 * 원금과 평가액이 같은 날에도 두 값은 서로 다른 경로로 계산되므로 2.8e-14 같은
 * 잔차가 남는다. 그걸 "+0.00 (수익)"으로 보여주면 거짓말이 되므로 0으로 본다.
 */
export function signOf(v, eps = 1e-6) {
  return v > eps ? 1 : v < -eps ? -1 : 0;
}

export function fmtSigned(v, fmt) {
  const s = signOf(v);
  return (s > 0 ? '+' : s < 0 ? '-' : '') + fmt(Math.abs(v));
}

/** 통화 모드에 따른 포맷터 묶음 */
export function currencyFns(mode) {
  return mode === 'USDT'
    ? { full: fmtUsdt, compact: fmtUsdtCompact, key: 'Usdt', unit: 'USDT' }
    : { full: fmtKrw, compact: fmtKrwCompact, key: 'Krw', unit: '원' };
}
