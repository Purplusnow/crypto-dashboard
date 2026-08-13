#!/usr/bin/env node
/**
 * cdb — 암호화폐 손익 대시보드 데이터 입력 CLI
 *
 *   node tools/cdb.mjs <command> [args] [--flags]
 *
 * 대시보드(assets/*.js)와 계산 로직(assets/core.js)을 공유하므로
 * 터미널에서 보는 숫자와 웹에서 보는 숫자가 항상 같다.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  buildSeries, today, isDate, addDays, signOf, acctUsdt,
  fmtKrw, fmtUsdt, fmtNum, fmtPct, fmtKrwCompact, fmtUsdtCompact,
} from '../assets/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const F = {
  config: path.join(DATA, 'config.json'),
  flows: path.join(DATA, 'flows.json'),
  snapshots: path.join(DATA, 'snapshots.json'),
};

/* ------------------------------------------------------------------ 유틸 */

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`${path.relative(ROOT, file)} 파싱 실패: ${e.message}`);
  }
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function die(msg) {
  console.error(C.red('✖ ') + msg);
  process.exit(1);
}

/** --flag value / --flag=value / -n 5 / bare positionals */
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else if (a.startsWith('-') && a.length === 2) {
      flags[a.slice(1)] = i + 1 < argv.length && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    } else pos.push(a);
  }
  return { flags, pos };
}

function numFlag(flags, key) {
  if (flags[key] === undefined) return undefined;
  const v = Number(String(flags[key]).replace(/[_,\s]/g, ''));
  if (!Number.isFinite(v)) die(`--${key} 값이 숫자가 아닙니다: ${flags[key]}`);
  return v;
}

/**
 * 계좌 플래그를 읽는다. 영문 id 와 config 의 한글 별칭을 모두 받는다 —
 * 한영전환 없이 `--나노 59` 로도 쓸 수 있게. suffix 는 `krw` 같은 하위 항목.
 */
function accFlag(flags, acc, suffix = '') {
  const names = [acc.id.toLowerCase(), ...[].concat(acc.alias || [])];
  const tails = suffix ? [`-${suffix}`, suffix === 'krw' ? '-원' : ''] : [''];
  for (const n of names) {
    for (const t of tails) {
      if (!t && suffix) continue;
      const v = numFlag(flags, n + t);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

function dateFlag(flags) {
  const d = flags.date || flags.d;
  if (d === undefined) return today();
  if (d === 'yesterday' || d === 'y') return addDays(today(), -1);
  if (/^-\d+$/.test(String(d))) return addDays(today(), Number(d));
  if (!isDate(String(d))) die(`--date 형식은 YYYY-MM-DD 입니다: ${d}`);
  return String(d);
}

function ctx() {
  const config = readJSON(F.config, null);
  if (!config) die('data/config.json 이 없습니다.');
  return {
    config,
    flows: readJSON(F.flows, []),
    snapshots: readJSON(F.snapshots, []),
    ids: config.accounts.map((a) => a.id),
  };
}

/** 해당 날짜의 스냅샷을 찾거나 새로 만들어 반환 (배열에 삽입 포함) */
function upsertSnapshot(snapshots, date) {
  let s = snapshots.find((x) => x.date === date);
  if (!s) {
    s = { date, balances: {} };
    snapshots.push(s);
    snapshots.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  s.balances = s.balances || {};
  return s;
}

/* ------------------------------------------------------------------ 환율 */

async function getJSON(url, ms = 8000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 원화로 USDT를 사고 파는 실제 시세를 쓴다. USD/KRW 환율이 아니라
// 국내 거래소의 USDT 가격이라야 실제 체결가에 가깝다 (김프/역프 포함).
const FX_SOURCES = {
  upbit: {
    label: 'Upbit KRW-USDT',
    async now() {
      const r = await getJSON('https://api.upbit.com/v1/ticker?markets=KRW-USDT');
      return Number(r?.[0]?.trade_price);
    },
    async on(date) {
      const to = `${addDays(date, 1)}T00:00:00Z`;
      const r = await getJSON(
        `https://api.upbit.com/v1/candles/days?market=KRW-USDT&count=1&to=${to}`
      );
      return Number(r?.[0]?.trade_price);
    },
  },
  bithumb: {
    label: 'Bithumb USDT_KRW',
    async now() {
      const r = await getJSON('https://api.bithumb.com/public/ticker/USDT_KRW');
      return Number(r?.data?.closing_price);
    },
    on: null, // 공개 API에 과거 일봉이 없어 Upbit 일봉으로 대체한다
  },
};

/**
 * 해당 날짜의 USDT/원 시세를 가져온다.
 * 실패하면 null을 돌려주고 호출부는 기존 동작(직전 환율 이월)으로 넘어간다.
 * 네트워크 때문에 기록 자체가 막히면 안 된다.
 */
async function fetchFx(date, sourceName) {
  const name = FX_SOURCES[sourceName] ? sourceName : 'upbit';
  const src = FX_SOURCES[name];
  const past = date !== today();
  try {
    const fn = past ? src.on || FX_SOURCES.upbit.on : src.now;
    const used = past && !src.on ? FX_SOURCES.upbit : src;
    const v = await fn(date);
    if (!Number.isFinite(v) || v <= 0) throw new Error('시세를 해석할 수 없습니다');
    return {
      fx: Math.round(v * 10) / 10,
      label: past ? `${used.label} ${date} 종가` : `${used.label} 현재가`,
    };
  } catch (e) {
    console.log(
      C.yellow('!') +
        C.dim(` 환율 조회 실패 (${e.message}) — 직전 환율을 이어 씁니다. --fx 로 직접 지정할 수 있습니다.`)
    );
    return null;
  }
}

/** --fx 가 있으면 그 값, 없으면 실시간 조회. --no-fx 면 조회하지 않는다. */
async function resolveFx(flags, date, config) {
  const manual = numFlag(flags, 'fx');
  if (manual) return { fx: manual, label: '직접 지정' };
  if (flags['no-fx']) return null;
  return fetchFx(date, config.fxSource);
}

function clearSample(config) {
  if (config.sample) {
    config.sample = false;
    writeJSON(F.config, config);
  }
}

/* --------------------------------------------------------------- 명령들 */

const commands = {};

commands.help = () => {
  console.log(`
${C.b('cdb')} — 암호화폐 손익 대시보드 데이터 입력

${C.b('입출금 (외부 자금 이동 = 원금)')}
  deposit <원화금액> [--date 2026-08-13] [--note "..."]    은행 → BT
  withdraw <원화금액> [--date ...] [--note "..."]          BT → 은행
      원화가 은행과 BT 사이를 오가는 것만 기록한다. BT의 원화 잔고도 같이 갱신된다.
      계좌 사이 이동(BT→OK 등)은 총액이 변하지 않으므로 기록할 필요가 없다.
      ${C.dim('--no-balance  잔고는 그대로 두고 원금만 기록 (과거 소급 입력용)')}

${C.b('일별 잔고')}
  snap [--date ...] [--fx 1382] --bt 20 --ok 1500 --na 800 --bc 900 --bf 400
      각 계좌의 그날 USDT 잔고. 생략한 계좌는 직전 값을 그대로 이월한다.
      --bt-krw 50000   BT에 남아 있는 원화 잔고
      --note "..."     메모

      ${C.dim('한글 별칭도 받는다 (한영전환 없이):')}
      ${C.dim('--비썸 = BT   --오케 = OK   --나노 = NA   --비씨 = BC   --벳퓨 = BF')}
      ${C.dim('예) cdb snap --나노 59 --벳퓨 0        원화는 --비썸-원 150000')}
      ${C.dim('별칭은 data/config.json 의 계좌별 "alias" 에서 바꾼다.')}

${C.b('스테이킹 (BC · BF)')}
  stake [--date ...] --bc 900 --bf 400     스테이킹 총액 (자산에 포함된다)
  div   [--date ...] --bc 0.42 --bf 0.19   일평균 배당 (USDT, 직접 유지하는 값)
      둘 다 다시 입력하기 전까지 직전 값이 그대로 이월된다.

${C.b('환율')}  ${C.dim('— 입력 시 자동으로 실시간 시세를 가져온다')}
  fx                       지금 시세를 가져와 오늘자로 기록
  fx --date 2026-08-01     그날 종가를 가져와 기록 (Upbit 일봉)
  fx 1410                  직접 지정
      deposit · withdraw · snap 도 --fx 를 생략하면 자동으로 시세를 붙인다.
      --fx 1410  직접 지정   |   --no-fx  조회하지 않음 (오프라인)
      소스는 data/config.json 의 "fxSource": "upbit" | "bithumb"

${C.b('조회 · 관리')}
  show [YYYY-MM-DD]        하루 요약 (웹 대시보드와 동일한 계산)
  list [-n 14]             최근 스냅샷 표
  flows [-n 20]            입출금 내역
  rm snap <YYYY-MM-DD>     스냅샷 삭제
  rm flow <id>             입출금 내역 삭제
  check                    데이터 정합성 검사
  seed                     샘플 데이터 생성
  reset                    모든 기록 삭제 (백업 후)
  serve [--port 8080]      로컬에서 대시보드 미리보기

${C.dim('날짜 단축: --date y (어제), --date -3 (3일 전)')}
`);
};

commands.deposit = (args) => flow(args, 'deposit');
commands.withdraw = (args) => flow(args, 'withdraw');

/**
 * 외부 입출금.
 * 입금은 은행 → BT 로 원화가 들어오는 것, 출금은 BT → 은행으로 원화가 나가는 것.
 * 그 외 경로는 없다고 확정했으므로 통화(원화)와 계좌(BT)는 고정이고,
 * BT의 원화 잔고도 이 명령이 함께 갱신한다.
 */
async function flow({ flags, pos }, type) {
  const { config, flows } = ctx();
  const amount = Number(String(pos[0] ?? '').replace(/[_,\s]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) die(`금액을 양수로 지정하세요. 예: cdb ${type} 5000000`);
  if (flags.asset && String(flags.asset).toUpperCase() !== 'KRW') {
    die('입출금은 은행↔BT 원화만 기록합니다. 코인 이동은 잔고(cdb snap)로만 반영하세요.');
  }
  const date = dateFlag(flags);
  const got = await resolveFx(flags, date, config);
  const fx = got?.fx;

  const entry = {
    id: `${type[0]}${date.replace(/-/g, '')}-${String(flows.length + 1).padStart(3, '0')}`,
    date,
    type,
    account: 'BT',
    currency: 'KRW',
    amount,
  };
  if (fx) entry.fx = fx;
  if (flags.note) entry.note = String(flags.note);

  const sign = type === 'deposit' ? 1 : -1;

  // BT의 원화 잔고를 함께 갱신한다. 이 돈은 반드시 BT를 거치므로 자동으로 맞출 수
  // 있다 — 원금만 넣고 잔고를 빠뜨려 없던 수익이 생기던 실수를 없앤다.
  // --no-balance 는 잔고가 이미 맞는 경우(과거 소급 입력, 기준 잔고 등)에 쓴다.
  const { snapshots } = ctx();
  let btBefore = null;
  let btAfter = null;
  if (!flags['no-balance']) {
    const { rows } = buildSeries(config, flows, snapshots);
    const base = rows.filter((r) => r.date <= date).pop();
    btBefore = base ? base.per.BT.krw : 0;
    btAfter = btBefore + sign * amount;
    if (btAfter < 0) {
      console.log(
        C.yellow('!') + C.dim(` BT 원화 잔고가 ${fmtKrw(btBefore)} 뿐인데 ${fmtKrw(amount)} 출금입니다. 잔고를 0으로 둡니다.`)
      );
      btAfter = 0;
    }
    const s = upsertSnapshot(snapshots, date);
    s.balances.BT = { ...(s.balances.BT || {}), krw: btAfter };
  }

  flows.push(entry);
  flows.sort((a, b) => (a.date < b.date ? -1 : 1));
  writeJSON(F.flows, flows);
  // 환율은 그날 스냅샷이 이미 있을 때만 채운다. 과거 입금을 소급 입력한다고
  // 잔고가 텅 빈 스냅샷을 만들면, 그날 평가액이 0으로 잡혀 없던 손실이 생긴다.
  if (fx) {
    const s = snapshots.find((x) => x.date === date);
    if (s && !s.fx) s.fx = fx;
  }
  writeJSON(F.snapshots, snapshots);
  clearSample(config);

  const label = type === 'deposit' ? '입금' : '출금';
  const path = type === 'deposit' ? '은행 → BT' : 'BT → 은행';
  console.log(
    `${C.green('✔')} ${date}  ${label} ${C.b(fmtKrw(amount))} ${C.dim(`(${path})`)}` +
    `${fx ? C.dim(`  @ ${fmtNum(fx, 1)}원/USDT · ${got.label}`) : ''}  ${C.dim(entry.id)}`
  );
  if (btAfter !== null) {
    console.log(C.dim(`  ↳ BT 원화 잔고 ${fmtKrw(btBefore)} → ${C.b(fmtKrw(btAfter))}`));
  } else {
    console.log(C.dim(`  ↳ 잔고는 건드리지 않았습니다 (--no-balance).`));
  }
  summary();
}

commands.snap = async ({ flags }) => {
  const { config, snapshots, ids } = ctx();
  const date = dateFlag(flags);
  const s = upsertSnapshot(snapshots, date);
  const got = await resolveFx(flags, date, config);
  const fx = got?.fx;
  if (fx) s.fx = fx;
  if (flags.note) s.note = String(flags.note);

  const touched = [];
  for (const acc of config.accounts) {
    const id = acc.id;
    const v = accFlag(flags, acc);
    if (v !== undefined) {
      s.balances[id] = { ...(s.balances[id] || {}), usdt: v };
      touched.push(`${id} ${fmtNum(v)}`);
    }
    const k = accFlag(flags, acc, 'krw');
    if (k !== undefined) {
      s.balances[id] = { ...(s.balances[id] || {}), krw: k };
      touched.push(`${id} ${fmtKrw(k)}`);
    }
  }
  if (!touched.length && !fx && !flags.note) {
    die(`기록할 잔고가 없습니다. 예: cdb snap ${ids.map((i) => `--${i.toLowerCase()} 0`).join(' ')}`);
  }
  writeJSON(F.snapshots, snapshots);
  clearSample(config);
  console.log(`${C.green('✔')} ${date}  잔고 기록  ${C.dim(touched.join(' · '))}${fx ? C.dim(`  @ ${fmtNum(fx, 1)} · ${got.label}`) : ''}`);
  summary();
};

commands.stake = ({ flags }) => balanceField(flags, 'staked', '스테이킹');
commands.div = ({ flags }) => balanceField(flags, 'avgDiv', '일평균 배당');

function balanceField(flags, field, label) {
  const { config, snapshots } = ctx();
  const date = dateFlag(flags);
  const s = upsertSnapshot(snapshots, date);
  const fx = numFlag(flags, 'fx');
  if (fx) s.fx = fx;

  const touched = [];
  for (const acc of config.accounts) {
    const v = accFlag(flags, acc);
    if (v === undefined) continue;
    s.balances[acc.id] = { ...(s.balances[acc.id] || {}), [field]: v };
    touched.push(`${acc.id} ${fmtNum(v, field === 'avgDiv' ? 4 : 2)}`);
  }
  if (!touched.length) die(`기록할 ${label}이 없습니다. 예: cdb ${field === 'staked' ? 'stake' : 'div'} --bc 900`);
  writeJSON(F.snapshots, snapshots);
  clearSample(config);
  console.log(`${C.green('✔')} ${date}  ${label} 기록  ${C.dim(touched.join(' · '))}`);
  summary();
}

commands.fx = async ({ flags, pos }) => {
  const { config, snapshots } = ctx();
  const date = dateFlag(flags);
  let rate = Number(pos[0]);
  let label = '직접 지정';
  if (!pos.length) {
    // 인자가 없으면 실시간(과거 날짜면 그날 종가) 시세를 가져온다
    const got = await fetchFx(date, config.fxSource);
    if (!got) die('환율을 가져오지 못했습니다. 값을 직접 지정하세요: cdb fx 1410');
    rate = got.fx;
    label = got.label;
  }
  if (!Number.isFinite(rate) || rate <= 0) die('환율을 지정하세요. 예: cdb fx 1410');
  const s = upsertSnapshot(snapshots, date);
  s.fx = rate;
  writeJSON(F.snapshots, snapshots);
  clearSample(config);
  console.log(`${C.green('✔')} ${date}  환율 ${C.b(fmtNum(rate, 1))} 원/USDT  ${C.dim(label)}`);
};

commands.show = ({ pos }) => {
  const { config, flows, snapshots } = ctx();
  const { rows, accounts } = buildSeries(config, flows, snapshots);
  if (!rows.length) return console.log(C.dim('기록된 스냅샷이 없습니다.'));
  const date = pos[0];
  const r = date ? rows.filter((x) => x.date <= date).pop() : rows[rows.length - 1];
  if (!r) return console.log(C.dim(`${date} 이전의 기록이 없습니다.`));

  const pn = (v, f) => {
    const s = signOf(v);
    return s > 0 ? C.red('+' + f(v)) : s < 0 ? C.blue('-' + f(-v)) : C.dim(f(0));
  };
  console.log(`\n${C.b(r.date)} ${C.dim(`· 1 USDT = ${fmtNum(r.fx, 1)}원`)}${r.note ? C.dim(' · ' + r.note) : ''}\n`);
  for (const a of accounts) {
    const p = r.per[a.id];
    const u = acctUsdt(p); // 자유 잔고 + 스테이킹
    const extra = [];
    if (p.krw) extra.push(fmtKrw(p.krw));
    if (p.staked) extra.push(`스테이킹 ${fmtNum(p.staked)}${p.usdt ? ` + 자유 ${fmtNum(p.usdt)}` : ''}`);
    if (p.avgDiv) extra.push(`일평균 배당 ${fmtNum(p.avgDiv, 4)}`);
    console.log(
      `  ${C.b(a.id.padEnd(3))} ${fmtNum(u).padStart(13)} USDT` +
      `  ${C.dim(fmtKrw(u * r.fx).padStart(14))}` +
      (extra.length ? `  ${C.dim('· ' + extra.join(' · '))}` : '')
    );
  }
  const line = '  ' + '─'.repeat(52);
  console.log(line);
  console.log(`  ${C.b('총 평가액')}  ${C.b(fmtKrw(r.valKrw))}   ${C.dim(fmtUsdt(r.valUsdt))}`);
  // 출금이 입금을 넘어서면 라벨을 뒤집는다 ("순 입금액 -30만"은 읽기 어렵다)
  const depLabel = r.depKrw < 0 ? '순 출금액' : '순 입금액';
  console.log(`  ${depLabel}  ${fmtKrw(Math.abs(r.depKrw))}   ${C.dim(fmtUsdt(Math.abs(r.depUsdt)))}`);
  // 입출금 기록이 아예 없으면 "수익 = 평가액"이 되어 버린다. 그건 수익이 아니다.
  // 반대로 순 입금액이 0이거나 음수여도(전액 회수) 수익은 계산할 수 있다.
  if (flows.some((f) => f.date <= r.date)) {
    console.log(`  ${'총 수익  '}  ${pn(r.profitKrw, fmtKrw)}   ${C.dim(pn(r.profitUsdt, fmtUsdt))}`);
  } else {
    console.log(`  ${'총 수익  '}  ${C.dim('—')}   ${C.dim('입금 기록이 없어 계산할 수 없습니다')}`);
  }
  console.log(`  ${'전일 대비'}  ${pn(r.dProfitKrw, fmtKrw)}`);
  if (r.stakedUsdt || r.avgDivUsdt) {
    console.log(`  ${'스테이킹 '}  ${fmtKrw(r.stakedKrw)}   ${C.dim(fmtUsdt(r.stakedUsdt) + ' · 자산에 포함')}`);
    console.log(`  ${'일평균배당'} ${fmtKrw(r.avgDivKrw)}   ${C.dim(fmtUsdt(r.avgDivUsdt) + ' · 직접 입력')}`);
  }
  console.log();
};

commands.list = ({ flags }) => {
  const { config, flows, snapshots } = ctx();
  const { rows, accounts } = buildSeries(config, flows, snapshots);
  if (!rows.length) return console.log(C.dim('기록된 스냅샷이 없습니다.'));
  const n = Number(flags.n || 14);
  const view = rows.slice(-n);

  const tint = (v, s) => (v > 0 ? C.red(s) : v < 0 ? C.blue(s) : C.dim(s));
  const head = ['날짜', ...accounts.map((a) => a.id), '평가액', '원금', '수익', '스테이킹', '전일'];
  const body = view.map((r) => [
    r.date,
    ...accounts.map((a) => fmtNum(acctUsdt(r.per[a.id]), 0)),
    fmtKrwCompact(r.valKrw),
    fmtKrwCompact(r.depKrw),
    tint(r.profitKrw, (r.profitKrw >= 0 ? '+' : '-') + fmtKrwCompact(Math.abs(r.profitKrw))),
    r.stakedKrw ? fmtKrwCompact(r.stakedKrw) : '—',
    tint(r.dProfitKrw, (r.dProfitKrw >= 0 ? '+' : '-') + fmtKrwCompact(Math.abs(r.dProfitKrw))),
  ]);
  printTable(head, body);
};

commands.flows = ({ flags }) => {
  const { flows } = ctx();
  if (!flows.length) return console.log(C.dim('입출금 기록이 없습니다.'));
  const n = Number(flags.n || 20);
  const view = flows.slice(-n);
  const head = ['id', '날짜', '구분', '금액', '환율', '메모'];
  const body = view.map((f) => [
    f.id || '',
    f.date,
    f.type === 'deposit' ? '입금' : '출금',
    (f.currency === 'USDT' ? fmtUsdt(f.amount) : fmtKrw(f.amount)),
    f.fx ? fmtNum(f.fx, 1) : '—',
    f.note || '',
  ]);
  printTable(head, body);
  const { config, snapshots } = ctx();
  const { latest } = buildSeries(config, flows, snapshots);
  if (latest) {
    const lab = latest.depKrw < 0 ? '순 출금액' : '순 입금액';
    console.log(`\n  ${lab} ${C.b(fmtKrw(Math.abs(latest.depKrw)))} ${C.dim('· ' + fmtUsdt(Math.abs(latest.depUsdt)))}`);
  }
};

commands.rm = ({ pos }) => {
  const kind = pos[0];
  const key = pos[1];
  if (!kind || !key) die('사용법: cdb rm snap 2026-08-13  |  cdb rm flow d20260801-001');
  if (kind === 'snap' || kind === 'snapshot') {
    const { snapshots } = ctx();
    const i = snapshots.findIndex((s) => s.date === key);
    if (i < 0) die(`${key} 스냅샷이 없습니다.`);
    snapshots.splice(i, 1);
    writeJSON(F.snapshots, snapshots);
    console.log(`${C.green('✔')} 스냅샷 ${key} 삭제`);
  } else if (kind === 'flow') {
    const { flows } = ctx();
    const i = flows.findIndex((f) => f.id === key);
    if (i < 0) die(`${key} 입출금 기록이 없습니다.`);
    const [gone] = flows.splice(i, 1);
    writeJSON(F.flows, flows);
    console.log(`${C.green('✔')} 입출금 ${key} 삭제 ${C.dim(`(${gone.date} ${gone.amount})`)}`);
  } else die('첫 인자는 snap 또는 flow 입니다.');
  summary();
};

commands.check = () => {
  const { config, flows, snapshots, ids } = ctx();
  const problems = [];
  const seen = new Set();
  for (const s of snapshots) {
    if (!isDate(s.date)) problems.push(`잘못된 날짜: ${JSON.stringify(s.date)}`);
    if (seen.has(s.date)) problems.push(`중복 스냅샷: ${s.date}`);
    seen.add(s.date);
    if (s.fx !== undefined && (!Number.isFinite(s.fx) || s.fx <= 0)) problems.push(`${s.date}: 환율 이상 (${s.fx})`);
    for (const k of Object.keys(s.balances || {})) {
      if (!ids.includes(k)) problems.push(`${s.date}: 알 수 없는 계좌 '${k}'`);
    }
  }
  const fid = new Set();
  for (const f of flows) {
    if (!isDate(f.date)) problems.push(`입출금 날짜 이상: ${JSON.stringify(f.date)}`);
    if (!['deposit', 'withdraw'].includes(f.type)) problems.push(`${f.id}: 알 수 없는 type '${f.type}'`);
    if (!(Number(f.amount) > 0)) problems.push(`${f.id}: 금액 이상 (${f.amount})`);
    if (f.id && fid.has(f.id)) problems.push(`중복 id: ${f.id}`);
    fid.add(f.id);
  }
  const { rows } = buildSeries(config, flows, snapshots);
  // 스냅샷 없이 입출금만 있는 날짜 경고
  for (const f of flows) {
    if (!rows.some((r) => r.date >= f.date)) {
      problems.push(`${f.date} 입출금 이후 스냅샷이 없어 손익에 반영되지 않습니다 (${f.id}).`);
    }
  }
  // 큰 폭의 일별 변동은 오타 가능성
  for (const r of rows) {
    if (r.depUsdt > 0 && Math.abs(r.dProfitUsdt) > r.depUsdt * 0.5) {
      problems.push(`${r.date}: 하루 손익이 원금의 50%를 넘습니다 (${fmtUsdt(r.dProfitUsdt)}). 입력 오타를 확인하세요.`);
    }
  }

  if (!problems.length) {
    console.log(`${C.green('✔')} 이상 없음 ${C.dim(`· 스냅샷 ${snapshots.length}건 · 입출금 ${flows.length}건`)}`);
  } else {
    for (const p of problems) console.log(`${C.yellow('!')} ${p}`);
    process.exitCode = 1;
  }
};

commands.reset = ({ flags }) => {
  const { config } = ctx();
  const stamp = today().replace(/-/g, '');
  for (const key of ['flows', 'snapshots']) {
    if (fs.existsSync(F[key])) {
      const bak = path.join(DATA, `.backup-${key}-${stamp}.json`);
      fs.copyFileSync(F[key], bak);
    }
  }
  writeJSON(F.flows, []);
  writeJSON(F.snapshots, []);
  config.sample = false;
  writeJSON(F.config, config);
  console.log(`${C.green('✔')} 데이터를 비웠습니다. ${C.dim(`백업: data/.backup-*-${stamp}.json`)}`);
};

commands.seed = () => {
  const { config, ids } = ctx();
  // 결정적 난수 (재실행해도 같은 샘플)
  let s = 20260813;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const days = 120;
  const start = addDays(today(), -(days - 1));
  const flows = [
    { id: 'd20260415-001', date: start, type: 'deposit', account: 'BT', currency: 'KRW', amount: 20000000, fx: 1372, note: '초기 입금' },
    { id: 'd20260415-002', date: addDays(start, 34), type: 'deposit', account: 'BT', currency: 'KRW', amount: 10000000, fx: 1391, note: '추가 입금' },
    { id: 'w20260415-003', date: addDays(start, 88), type: 'withdraw', account: 'BT', currency: 'KRW', amount: 4000000, fx: 1402, note: '일부 출금' },
  ];

  // bal = 자유 잔고, staked = 스테이킹 (별도 바구니, 계좌 총액은 둘의 합)
  const bal = { BT: 40, OK: 6000, NA: 4500, BC: 200, BF: 50 };
  const staked = { BC: 2800, BF: 950 };
  const snapshots = [];
  let fx = 1372;
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    fx = Math.max(1280, Math.min(1460, fx + (rnd() - 0.48) * 6));
    if (i === 34) { bal.OK += 4000; bal.NA += 3100; }
    if (i === 88) { bal.OK -= 1500; bal.NA -= 1350; }
    for (const k of ['OK', 'NA']) bal[k] *= 1 + (rnd() - 0.47) * 0.02;
    // 배당은 스테이킹 총액에 붙고, 자유 잔고(bal)는 별도 바구니로 남는다
    const divBC = staked.BC * 0.0006;
    const divBF = staked.BF * 0.0005;
    staked.BC += divBC;
    staked.BF += divBF;
    snapshots.push({
      date,
      fx: Math.round(fx * 10) / 10,
      balances: {
        BT: { usdt: r2(bal.BT) },
        OK: { usdt: r2(bal.OK) },
        NA: { usdt: r2(bal.NA) },
        BC: { usdt: r2(bal.BC), staked: r2(staked.BC), avgDiv: r2(divBC, 4) },
        BF: { usdt: r2(bal.BF), staked: r2(staked.BF), avgDiv: r2(divBF, 4) },
      },
    });
  }
  writeJSON(F.flows, flows);
  writeJSON(F.snapshots, snapshots);
  config.sample = true;
  writeJSON(F.config, config);
  console.log(`${C.green('✔')} 샘플 ${days}일치 생성 ${C.dim('· node tools/cdb.mjs reset 으로 지울 수 있습니다')}`);
  summary();
  void ids;
};

function r2(v, d = 2) {
  return Math.round(v * 10 ** d) / 10 ** d;
}

commands.serve = ({ flags }) => {
  const port = Number(flags.port || flags.p || 8080);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(port, () => {
    console.log(`${C.green('▶')} http://localhost:${port}  ${C.dim('(Ctrl+C 로 종료)')}`);
  });
};

/* ------------------------------------------------------------ 출력 헬퍼 */

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function printTable(head, body) {
  const cols = head.length;
  const w = new Array(cols).fill(0);
  for (let i = 0; i < cols; i++) {
    w[i] = Math.max(stripAnsi(head[i]).length, ...body.map((r) => stripAnsi(r[i] ?? '').length));
  }
  const pad = (v, i) => {
    const raw = stripAnsi(v);
    const sp = ' '.repeat(Math.max(0, w[i] - raw.length));
    return i === 0 || i === cols - 1 ? v + sp : sp + v;
  };
  console.log('\n  ' + C.dim(head.map(pad).join('  ')));
  console.log('  ' + C.dim('─'.repeat(w.reduce((a, b) => a + b, 0) + (cols - 1) * 2)));
  for (const r of body) console.log('  ' + r.map((v, i) => pad(v ?? '', i)).join('  '));
  console.log();
}

/** 명령 실행 후 한 줄 현황 */
function summary() {
  const { config, flows, snapshots } = ctx();
  const { latest } = buildSeries(config, flows, snapshots);
  if (!latest) return;
  const p = latest.profitKrw;
  const tag = flows.length === 0
    ? C.dim('— (입금 기록 없음)')
    : p > 0 ? C.red(`+${fmtKrw(p)}`)
    : p < 0 ? C.blue(`-${fmtKrw(-p)}`)
    : C.dim('±0');
  console.log(C.dim(`  ${latest.date} · 평가액 ${fmtKrw(latest.valKrw)} · 원금 ${fmtKrw(latest.depKrw)} · 수익 `) + tag);
}

/* ------------------------------------------------------------------ 진입 */

const [, , cmdRaw, ...rest] = process.argv;
const alias = { d: 'deposit', w: 'withdraw', s: 'snap', ls: 'list', avgdiv: 'div', '-h': 'help', '--help': 'help' };
const cmd = alias[cmdRaw] || cmdRaw || 'help';
if (!commands[cmd]) {
  console.error(C.red(`✖ 알 수 없는 명령: ${cmdRaw}`));
  commands.help();
  process.exit(1);
}
await commands[cmd](parseArgs(rest));
