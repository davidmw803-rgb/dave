export type Candle = { open: number; close: number };

export type OhlcCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type MomentumReport = {
  nCandles: number;
  nTransitions: number;
  baseRateUp: number;
  baseRateDown: number;
  pUpGivenPrevUp: number;
  pDownGivenPrevDown: number;
  hitRateFollowPrev: number;
  uu: number;
  ud: number;
  du: number;
  dd: number;
  longestUpRun: number;
  longestDownRun: number;
  strategyAvgPnlPerBet: number;
  strategyWinRate: number;
  strategyAvgWin: number;
  strategyAvgLoss: number;
  strategyExpectancy: number;
  directions: (-1 | 0 | 1)[];
};

function sign(x: number): -1 | 0 | 1 {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

export function classifyCandles(candles: Candle[]): (-1 | 0 | 1)[] {
  return candles.map((c) => sign(c.close - c.open));
}

export function analyze(candles: Candle[], dropDojis = true): MomentumReport {
  let working = candles;
  let directions = classifyCandles(working);

  if (dropDojis) {
    const kept: Candle[] = [];
    const keptDirs: (-1 | 1)[] = [];
    for (let i = 0; i < working.length; i++) {
      if (directions[i] !== 0) {
        kept.push(working[i]);
        keptDirs.push(directions[i] as -1 | 1);
      }
    }
    working = kept;
    directions = keptDirs;
  }

  const n = directions.length;
  if (n < 2) {
    throw new Error('Need at least 2 candles to analyze transitions.');
  }

  let uu = 0;
  let ud = 0;
  let du = 0;
  let dd = 0;
  for (let i = 0; i < n - 1; i++) {
    const prev = directions[i];
    const nxt = directions[i + 1];
    if (prev === 1 && nxt === 1) uu++;
    else if (prev === 1 && nxt === -1) ud++;
    else if (prev === -1 && nxt === 1) du++;
    else if (prev === -1 && nxt === -1) dd++;
  }

  const totalPrevUp = uu + ud;
  const totalPrevDn = du + dd;
  const total = totalPrevUp + totalPrevDn;

  const pUpGivenPrevUp = totalPrevUp ? uu / totalPrevUp : NaN;
  const pDownGivenPrevDown = totalPrevDn ? dd / totalPrevDn : NaN;
  const hitRateFollowPrev = total ? (uu + dd) / total : NaN;

  const upCount = directions.filter((d) => d === 1).length;
  const dnCount = directions.filter((d) => d === -1).length;
  const baseRateUp = upCount / n;
  const baseRateDown = dnCount / n;

  let longestUpRun = 0;
  let longestDownRun = 0;
  let curVal = directions[0];
  let curLen = 1;
  const finalizeRun = () => {
    if (curVal === 1 && curLen > longestUpRun) longestUpRun = curLen;
    if (curVal === -1 && curLen > longestDownRun) longestDownRun = curLen;
  };
  for (let i = 1; i < n; i++) {
    if (directions[i] === curVal) {
      curLen++;
    } else {
      finalizeRun();
      curVal = directions[i];
      curLen = 1;
    }
  }
  finalizeRun();

  const bodies = working.map((c) => c.close - c.open);
  const pnl: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const prev = directions[i];
    pnl.push(prev === 1 ? bodies[i + 1] : -bodies[i + 1]);
  }
  const avgPnl = pnl.reduce((a, b) => a + b, 0) / pnl.length;
  const wins = pnl.filter((x) => x > 0);
  const losses = pnl.filter((x) => x < 0);
  const winRate = wins.length / pnl.length;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;

  return {
    nCandles: n,
    nTransitions: total,
    baseRateUp,
    baseRateDown,
    pUpGivenPrevUp,
    pDownGivenPrevDown,
    hitRateFollowPrev,
    uu,
    ud,
    du,
    dd,
    longestUpRun,
    longestDownRun,
    strategyAvgPnlPerBet: avgPnl,
    strategyWinRate: winRate,
    strategyAvgWin: avgWin,
    strategyAvgLoss: avgLoss,
    strategyExpectancy: expectancy,
    directions,
  };
}

export function parseOhlcCsv(text: string): Candle[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSV has no data rows.');
  const header = lines[0].split(',').map((h) => h.toLowerCase().trim());
  const openIdx = header.indexOf('open');
  const closeIdx = header.indexOf('close');
  if (openIdx === -1 || closeIdx === -1) {
    throw new Error(`CSV must have open, close columns. Got: ${header.join(', ')}`);
  }
  const out: Candle[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const o = Number(cols[openIdx]);
    const c = Number(cols[closeIdx]);
    if (Number.isFinite(o) && Number.isFinite(c)) {
      out.push({ open: o, close: c });
    }
  }
  return out;
}
