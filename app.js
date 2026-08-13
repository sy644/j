// ============================================
// 自选股存储
// ============================================
const STORAGE_KEY = 'stocks_v1';
const DEFAULT_STOCKS = [
  { code: 'sh600519', name: '贵州茅台', market: 'sh' },
  { code: 'sz000001', name: '平安银行', market: 'sz' },
  { code: 'sz300750', name: '宁德时代', market: 'sz' },
  { code: 'sh000001', name: '上证指数', market: 'sh' },
  { code: 'sz399001', name: '深证成指', market: 'sz' },
];

function loadStocks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_STOCKS];
    const list = JSON.parse(raw);
    return list.length ? list : [...DEFAULT_STOCKS];
  } catch { return [...DEFAULT_STOCKS]; }
}
function saveStocks(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}
function addStock(code) {
  const list = loadStocks();
  let c = code.toLowerCase().trim();
  // 只接受代码:6 位纯数字 自动补前缀,或 sh/sz/bj + 6位
  if (/^\d{6}$/.test(c)) {
    const head = c[0];
    if (c.startsWith('000') || c.startsWith('6') || c.startsWith('9') || c.startsWith('5')) c = 'sh' + c;
    else if (c.startsWith('399') || c.startsWith('1') || c.startsWith('0') || c.startsWith('3')) c = 'sz' + c;
    else if (head === '4' || head === '8') c = 'bj' + c;
    else c = 'sh' + c;
  } else if (!/^([a-z]{2,3})\d{6}$/.test(c)) {
    return { list, added: false, reason: 'invalid' };
  }
  if (list.some(s => s.code === c)) return { list, added: false, reason: 'duplicate' };
  const m = c.startsWith('sh') ? 'sh' : c.startsWith('sz') ? 'sz' : 'bj';
  // 识别类型
  const num = c.replace(/^[a-z]+/, '');
  const h1 = num[0], h2 = num[1];
  let type = 'stock';
  if (h1 === '5' && (h2 === '0' || h2 === '1' || h2 === '8')) type = 'etf';
  else if (h1 === '1' && h2 === '5') type = 'etf';
  else if (h1 === '1' && (h2 === '6' || h2 === '7')) type = 'lof';
  else if (h1 === '0' && h2 === '0' && m === 'sh') type = 'index';
  else if (h1 === '3' && h2 === '9' && m === 'sz') type = 'index';
  const name = c.toUpperCase();  // 初始名 = 代码,详情页可点标题改名
  // 置顶:unshift 到列表头
  list.unshift({ code: c, name, market: m, type });
  saveStocks(list);
  return { list, added: true };
}

const TYPE_LABEL = {
  stock: { label: '股', cls: 'type-stock' },
  etf:   { label: 'ETF', cls: 'type-etf' },
  lof:   { label: 'LOF', cls: 'type-lof' },
  index: { label: '指数', cls: 'type-index' },
};
function typeLabel(t) {
  const m = TYPE_LABEL[t] || TYPE_LABEL.stock;
  return `<span class="type-pill ${m.cls}">${m.label}</span>`;
}
function removeStock(code) {
  const list = loadStocks().filter(s => s.code !== code);
  saveStocks(list);
  return list;
}

// ============================================
// 数据抓取(腾讯 K 线 API,自带 CORS 头)
// 字段: [date, open, close, high, low, volume, ...optional]
// ============================================
async function fetchKLine(code, count = 250) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(code)},day,,,${count},qfq`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.code !== 0) throw new Error('API error: ' + data.msg);
  const key = Object.keys(data.data)[0];
  const arr = (data.data[key] && (data.data[key].qfqday || data.data[key].day)) || [];
  if (!arr.length) throw new Error('无数据');
  return arr.map(row => ({
    date: row[0],
    open: +row[1],
    close: +row[2],
    high: +row[3],
    low: +row[4],
    volume: +row[5],
  })).filter(r => r.date && !isNaN(r.open));
}

// 拿基本面数据(PE/PB/换手/市值/52周高/低/涨跌停/名称/量比)
// qt 数组字段映射: 1=名称, 2=代码, 38=换手%, 39=PE动, 44=流通市值(亿), 45=总市值(亿), 46=PB, 47=涨停, 48=跌停, 49=量比, 56=振幅%, 67=52周高, 68=52周低
async function fetchBasic(code) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(code)},day,,,1,qfq`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.code !== 0) return null;
  const key = Object.keys(data.data)[0];
  const node = data.data[key];
  const qt = (node && node.qt && node.qt[key]) || [];
  if (!Array.isArray(qt) || qt.length < 10) return null;
  const num = i => (qt[i] !== '' && qt[i] != null) ? +qt[i] : null;
  return {
    name: qt[1] || code,
    code: qt[2] || code,
    price: num(3),
    turnover: num(38),          // 换手率%
    pe: num(39),                // 市盈率(动)
    circCap: num(44),           // 流通市值 亿
    totalCap: num(45),          // 总市值 亿
    pb: num(46),                // 市净率
    upperLimit: num(47),        // 涨停价
    lowerLimit: num(48),        // 跌停价
    volRatio: num(49),          // 量比
    amplitude: num(56),         // 振幅%
    high52w: num(67),           // 52周高
    low52w: num(68),            // 52周低
  };
}

// ============================================
// 技术指标(纯 JS 计算)
// ============================================
function calcMA(closes, n) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= n) sum -= closes[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
function calcEMA(closes, n) {
  const out = new Array(closes.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) continue;
    if (prev === null) {
      let s = 0;
      for (let j = 0; j < n; j++) s += closes[i - j];
      prev = s / n;
    } else {
      prev = closes[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}
function calcRSI(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (i <= n) {
      if (diff > 0) gain += diff; else loss -= diff;
      if (i === n) {
        const rs = gain / (loss || 1e-9);
        out[i] = 100 - 100 / (1 + rs);
      }
    } else {
      const g = diff > 0 ? diff : 0;
      const l = diff < 0 ? -diff : 0;
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      const rs = gain / (loss || 1e-9);
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const dif = closes.map((_, i) => emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null);
  // DEA = EMA(DIF, signal) — 用简单递归实现
  const dea = new Array(closes.length).fill(null);
  let prev = null;
  const k = 2 / (signal + 1);
  for (let i = 0; i < closes.length; i++) {
    if (dif[i] === null) continue;
    if (prev === null) prev = dif[i];
    else prev = dif[i] * k + prev * (1 - k);
    dea[i] = prev;
  }
  const hist = dif.map((d, i) => d !== null && dea[i] !== null ? (d - dea[i]) * 2 : null);
  return { dif, dea, hist };
}
function calcKDJ(highs, lows, closes, n = 9, m1 = 3, m2 = 3) {
  const k = new Array(closes.length).fill(null);
  const d = new Array(closes.length).fill(null);
  const j = new Array(closes.length).fill(null);
  let prevK = 50, prevD = 50;
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) continue;
    let h = -Infinity, l = Infinity;
    for (let x = i - n + 1; x <= i; x++) {
      if (highs[x] > h) h = highs[x];
      if (lows[x] < l) l = lows[x];
    }
    const rsv = h === l ? 50 : ((closes[i] - l) / (h - l)) * 100;
    const curK = (prevK * (m1 - 1) + rsv) / m1;
    const curD = (prevD * (m2 - 1) + curK) / m2;
    k[i] = curK; d[i] = curD; j[i] = 3 * curK - 2 * curD;
    prevK = curK; prevD = curD;
  }
  return { k, d, j };
}
function calcBOLL(closes, n = 20, k = 2) {
  const mid = calcMA(closes, n);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) continue;
    let s = 0;
    for (let x = i - n + 1; x <= i; x++) s += (closes[x] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}
function calcATR(highs, lows, closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  const trs = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { trs.push(highs[i] - lows[i]); continue; }
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trs.push(tr);
  }
  let prev = null;
  for (let i = 0; i < trs.length; i++) {
    if (i < n - 1) continue;
    if (prev === null) {
      let s = 0;
      for (let x = i - n + 1; x <= i; x++) s += trs[x];
      prev = s / n;
    } else {
      prev = (prev * (n - 1) + trs[i]) / n;
    }
    out[i] = prev;
  }
  return out;
}
function calcROC(closes, n = 12) {
  const out = new Array(closes.length).fill(null);
  for (let i = n; i < closes.length; i++) {
    out[i] = ((closes[i] - closes[i - n]) / closes[i - n]) * 100;
  }
  return out;
}
function calcWR(closes, highs, lows, n = 14) {
  const out = new Array(closes.length).fill(null);
  for (let i = n - 1; i < closes.length; i++) {
    let h = -Infinity, l = Infinity;
    for (let x = i - n + 1; x <= i; x++) {
      if (highs[x] > h) h = highs[x];
      if (lows[x] < l) l = lows[x];
    }
    out[i] = h === l ? -50 : ((h - closes[i]) / (h - l)) * -100;
  }
  return out;
}

// OBV 能量潮:以收盘价涨跌为正负乘以成交量累加
function calcOBV(closes, volumes) {
  const out = new Array(closes.length).fill(0);
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { out[i] = volumes[i] || 0; continue; }
    if (closes[i] > closes[i - 1]) out[i] = out[i - 1] + (volumes[i] || 0);
    else if (closes[i] < closes[i - 1]) out[i] = out[i - 1] - (volumes[i] || 0);
    else out[i] = out[i - 1];
  }
  return out;
}

// OBV 移动平均 + 方向
function obvTrend(obv, short = 5, long = 20) {
  const last = obv.length - 1;
  const sma = (arr, n) => {
    const s = arr.slice(Math.max(0, arr.length - n)).reduce((a, b) => a + b, 0);
    return s / Math.min(n, arr.length);
  };
  const shortAvg = sma(obv, short);
  const longAvg = sma(obv, long);
  return {
    shortAvg, longAvg,
    direction: shortAvg > longAvg ? 'up' : shortAvg < longAvg ? 'down' : 'flat',
    value: obv[last],
  };
}

// VR 成交量比率 = N日内上涨日成交量总和 / 下跌日成交量总和 × 100
function calcVR(closes, volumes, n = 26) {
  const out = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    let upV = 0, downV = 0, sameV = 0;
    for (let x = Math.max(0, i - n + 1); x <= i; x++) {
      if (x === 0) continue;
      if (closes[x] > closes[x - 1]) upV += volumes[x] || 0;
      else if (closes[x] < closes[x - 1]) downV += volumes[x] || 0;
      else sameV += volumes[x] || 0;
    }
    if (downV === 0) { out[i] = upV > 0 ? 999 : 100; continue; }
    out[i] = ((upV + sameV * 0.5) / downV) * 100;
  }
  return out;
}

// 均量(用于放量/缩量判断)
function calcVolMA(volumes, n = 5) {
  const out = new Array(volumes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < volumes.length; i++) {
    sum += volumes[i];
    if (i >= n) sum -= volumes[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
function calcCCI(highs, lows, closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const ma = calcMA(tp, n);
  for (let i = n - 1; i < closes.length; i++) {
    let s = 0;
    for (let x = i - n + 1; x <= i; x++) s += Math.abs(tp[x] - ma[i]);
    const md = s / n;
    out[i] = md === 0 ? 0 : (tp[i] - ma[i]) / (0.015 * md);
  }
  return out;
}
function calcADX(highs, lows, closes, n = 14) {
  // 简化版:算 +DM / -DM / TR,再算 +DI / -DI / DX / ADX
  const out = new Array(closes.length).fill(null);
  const trArr = [null], pDM = [null], nDM = [null];
  for (let i = 1; i < closes.length; i++) {
    const up = highs[i] - highs[i - 1];
    const dn = lows[i - 1] - lows[i];
    pDM.push(up > dn && up > 0 ? up : 0);
    nDM.push(dn > up && dn > 0 ? dn : 0);
    trArr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  // Wilder smoothing
  const smooth = arr => {
    const r = [null];
    let s = 0;
    for (let i = 1; i < arr.length; i++) {
      if (i < n) { s += arr[i]; r.push(null); continue; }
      if (i === n) { s += arr[i]; r.push(s); continue; }
      s = r[i - 1] - r[i - 1] / n + arr[i];
      r.push(s);
    }
    return r;
  };
  const trS = smooth(trArr);
  const pDMS = smooth(pDM);
  const nDMS = smooth(nDM);
  const dx = new Array(closes.length).fill(null);
  for (let i = n; i < closes.length; i++) {
    if (trS[i] === 0) continue;
    const pDI = 100 * pDMS[i] / trS[i];
    const nDI = 100 * nDMS[i] / trS[i];
    const sum = pDI + nDI;
    dx[i] = sum === 0 ? 0 : 100 * Math.abs(pDI - nDI) / sum;
  }
  // ADX = Wilder smooth of DX
  let s = 0;
  for (let i = n; i < n * 2 && i < closes.length; i++) s += dx[i] || 0;
  let prev = s / n;
  for (let i = n * 2; i < closes.length; i++) {
    prev = (prev * (n - 1) + (dx[i] || 0)) / n;
    out[i] = prev;
  }
  return out;
}

// ============================================
// 综合判定:基于多个指标投票
// ============================================
// 信号权重表:价格类(均线) > 动量类 > 震荡类
const MA_WEIGHT  = { MA5: 2.0, MA10: 1.5, MA20: 1.2, MA60: 1.0 };
const OSC_WEIGHT = { RSI: 1.3, MACD: 1.5, KDJ: 1.0, CCI: 0.8, WR: 0.8, ROC: 0.8, BOLL: 0.8, ADX: 0.5, ATR: 0.5 };

function summarize(closes, highs, lows, opens, volumes, pivots) {
  const last = closes.length - 1;
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const kdj = calcKDJ(highs, lows, closes);
  const ma5 = calcMA(closes, 5);
  const ma10 = calcMA(closes, 10);
  const ma20 = calcMA(closes, 20);
  const ma60 = calcMA(closes, 60);
  const boll = calcBOLL(closes);
  const atr = calcATR(highs, lows, closes);
  const cci = calcCCI(highs, lows, closes);
  const wr = calcWR(closes, highs, lows);
  const roc = calcROC(closes);
  const adx = calcADX(highs, lows, closes);
  const obv = calcOBV(closes, volumes);
  const obvInfo = obvTrend(obv, 5, 20);
  const vr = calcVR(closes, volumes, 26);
  const vol5 = calcVolMA(volumes, 5);
  const vol10 = calcVolMA(volumes, 10);

  // ============ 指标分组(趋势 / 动量 / 波动 / 量能) ============
  const trendGroup = [
    { name: 'MA5',  value: ma5[last],  min: 0, max: 0, weight: MA_WEIGHT.MA5, group: 'trend',
      signal: closes[last] > ma5[last]  ? '买入' : '卖出' },
    { name: 'MA10', value: ma10[last], min: 0, max: 0, weight: MA_WEIGHT.MA10, group: 'trend',
      signal: closes[last] > ma10[last] ? '买入' : '卖出' },
    { name: 'MA20', value: ma20[last], min: 0, max: 0, weight: MA_WEIGHT.MA20, group: 'trend',
      signal: closes[last] > ma20[last] ? '买入' : '卖出' },
    { name: 'MA60', value: ma60[last], min: 0, max: 0, weight: MA_WEIGHT.MA60, group: 'trend',
      signal: closes[last] > ma60[last] ? '买入' : '卖出' },
  ];
  const momentumGroup = [
    { name: 'RSI 14', value: rsi[last], min: 0, max: 100, weight: OSC_WEIGHT.RSI, group: 'momentum',
      signal: rsi[last] > 70 ? '卖出' : rsi[last] < 30 ? '买入' : '中性' },
    { name: 'MACD 柱', value: macd.hist[last], min: -2, max: 2, weight: OSC_WEIGHT.MACD, group: 'momentum',
      signal: (macd.dif[last] > macd.dea[last] && macd.hist[last] > 0) ? '买入' : (macd.dif[last] < macd.dea[last] && macd.hist[last] < 0) ? '卖出' : '中性' },
    { name: 'KDJ K', value: kdj.k[last], min: 0, max: 100, weight: OSC_WEIGHT.KDJ, group: 'momentum',
      signal: kdj.k[last] > 80 ? '卖出' : kdj.k[last] < 20 ? '买入' : '中性' },
    { name: 'ROC 12', value: roc[last], min: -10, max: 10, weight: OSC_WEIGHT.ROC, group: 'momentum',
      signal: roc[last] > 5 ? '买入' : roc[last] < -5 ? '卖出' : '中性' },
  ];
  const volaGroup = [
    { name: 'CCI 14', value: cci[last], min: -200, max: 200, weight: OSC_WEIGHT.CCI, group: 'vola',
      signal: cci[last] > 100 ? '卖出' : cci[last] < -100 ? '买入' : '中性' },
    { name: 'WR 14', value: wr[last], min: -100, max: 0, weight: OSC_WEIGHT.WR, group: 'vola',
      signal: wr[last] > -20 ? '卖出' : wr[last] < -80 ? '买入' : '中性' },
    { name: 'ADX 14', value: adx[last], min: 0, max: 50, weight: OSC_WEIGHT.ADX, group: 'vola',
      signal: adx[last] < 20 ? '无趋势' : adx[last] > 40 ? '中等波动' : '中性' },
  ];
  const bollPos = closes[last] > boll.upper[last] ? '超买' : closes[last] < boll.lower[last] ? '超卖' : '中性';
  volaGroup.push({
    name: 'BOLL', value: closes[last] - boll.mid[last],
    min: -((boll.upper[last] - boll.lower[last]) || 1),
    max: ((boll.upper[last] - boll.lower[last]) || 1),
    weight: OSC_WEIGHT.BOLL, group: 'vola',
    signal: bollPos,
  });
  // 量能组
  const volaRatio = vol5[last] && vol10[last] ? (vol5[last] / vol10[last]) : 1;
  const volGroup = [
    { name: 'VOL 5/10', value: volaRatio, min: 0, max: 2, weight: 1.0, group: 'vol',
      signal: volaRatio > 1.3 ? '放量' : volaRatio < 0.7 ? '缩量' : '中性' },
    { name: 'OBV', value: obvInfo.value, min: obvInfo.value - Math.abs(obvInfo.value) * 0.5, max: obvInfo.value + Math.abs(obvInfo.value) * 0.5, weight: 1.5, group: 'vol',
      signal: obvInfo.direction === 'up' ? '资金流入' : obvInfo.direction === 'down' ? '资金流出' : '中性' },
    { name: 'VR 26', value: vr[last] || 0, min: 0, max: 400, weight: 0.8, group: 'vol',
      signal: vr[last] > 250 ? '超买区' : vr[last] < 70 ? '超卖区' : '中性' },
  ];

  // 兼容旧名(供其他代码使用)
  const mas = trendGroup;
  const indicators = [...momentumGroup, ...volaGroup, ...volGroup];

  // ============ 加权计算 ============
  // buy/sell 计分(中性不扣分),按权重累加
  let buyScore = 0, sellScore = 0, totalWeight = 0;
  [...trendGroup, ...momentumGroup, ...volaGroup, ...volGroup].forEach(ind => {
    totalWeight += ind.weight;
    if (ind.signal === '买入' || ind.signal === '资金流入') buyScore += ind.weight;
    else if (ind.signal === '卖出' || ind.signal === '资金流出' ||
             ind.signal === '放量' || ind.signal === '超买' || ind.signal === '超买区') sellScore += ind.weight;
  });
  const netScore = buyScore - sellScore;          // 净加权分
  const scoreRatio = netScore / totalWeight;      // 标准化 [-1, +1]

  // ============ 趋势判断(以 MA60 方向 + 价格位置为骨) ============
  let trend = '震荡';
  let trendScore = 0;
  const ma60Dir = ma60[last] - ma60[last - 5] || 0;     // 5 日 MA60 变化
  const aboveMA60 = closes[last] > ma60[last];
  const aboveMA20 = closes[last] > ma20[last];
  const aboveMA5  = closes[last] > ma5[last];
  if (ma60Dir > 0 && aboveMA60 && aboveMA20 && aboveMA5) { trend = '强多头'; trendScore = 2; }
  else if (ma60Dir > 0 && aboveMA60)                     { trend = '多头';   trendScore = 1; }
  else if (ma60Dir < 0 && !aboveMA60 && !aboveMA20 && !aboveMA5) { trend = '强空头'; trendScore = -2; }
  else if (ma60Dir < 0 && !aboveMA60)                    { trend = '空头';   trendScore = -1; }
  else                                                    { trend = '震荡';   trendScore = 0; }

  // ============ 量价强制判据(入场前置阀门) ============
  // 判定今日相对昨日:
  //  - 放量定义:今日成交量 > 5日均量 * 1.5
  //  - 缩量定义:今日成交量 < 5日均量 * 0.7
  //  - 破位:收盘跌破关键位(MA20/MA60/枢轴 S1)
  //  - 突破:收盘站上关键位(MA20/MA60/枢轴 R1)
  const todayVol = volumes[last];
  const avgVol5 = vol5[last] || todayVol;
  const isFangLiang = todayVol > avgVol5 * 1.5;
  const isSuoLiang = todayVol < avgVol5 * 0.7;
  const yestClose = closes[last - 1] || closes[last];
  // 今日的关卡变化
  const brokeMA20 = yestClose >= ma20[last - 1] && closes[last] < ma20[last];
  const brokeMA60 = yestClose >= ma60[last - 1] && closes[last] < ma60[last];
  const aboveMA60Now = closes[last] > ma60[last];
  const aboveMA20Now = closes[last] > ma20[last];
  // 总结今日量价事件
  let vpEvent = 'normal';           // normal | fangBreak | suoBreak | fangBreakout | suoBreakout | upTrend
  let vpLabel = '正常量价';
  if (isFangLiang && (brokeMA20 || brokeMA60)) { vpEvent = 'fangBreak'; vpLabel = '放量跌破均线'; }
  else if (isSuoLiang && (brokeMA20 || brokeMA60)) { vpEvent = 'suoBreak'; vpLabel = '缩量跌破均线'; }
  else if (isFangLiang && aboveMA60Now && aboveMA20Now && obvInfo.direction === 'up') { vpEvent = 'fangBreakout'; vpLabel = '放量突破上涨'; }
  else if (isSuoLiang && aboveMA60Now && obvInfo.direction === 'up') { vpEvent = 'upTrend'; vpLabel = '缩量上涨(主力锁仓?)'; }
  // MA60 + 量价 红绿灯
  let vpScore = 0;  // -2 ~ +2
  if (vpEvent === 'fangBreak') vpScore = -2;
  else if (vpEvent === 'suoBreak') vpScore = -1;
  else if (vpEvent === 'fangBreakout') vpScore = 2;
  else if (vpEvent === 'upTrend') vpScore = 1;

  // ============ 枢轴点 + 破位检测 ============
  const price = closes[last];
  let pivotSignal = '中性', pivotBuy = 0, pivotSell = 0, pivotLabel = '';
  let pivotBreakdown = null, pivotBreakout = null;  // 破位 / 突破信息
  if (pivots) {
    const p = pivots.classic;
    if (price >= p.R3)      { pivotSignal = '强阻力'; pivotSell = 2; pivotLabel = '超买区 R3+'; }
    else if (price >= p.R2) { pivotSignal = '阻力区'; pivotSell = 1; pivotLabel = '阻力区 R2~R3'; }
    else if (price >= p.R1) { pivotSignal = '偏空';   pivotSell = 0; pivotLabel = '阻力位 R1~R2'; }
    else if (price >= p['轴心点']) { pivotSignal = '中性'; pivotLabel = '轴心附近'; }
    else if (price >= p.S1) { pivotSignal = '偏多';   pivotBuy = 0; pivotLabel = '轴心~S1'; }
    else if (price >= p.S2) { pivotSignal = '支撑区'; pivotBuy = 1; pivotLabel = '支撑区 S1~S2'; }
    else                    { pivotSignal = '强支撑'; pivotBuy = 2; pivotLabel = '超卖区 S3-'; }
    // 破位:昨日收在 S1 上方、今日跌破 S1
    const prev = closes[last - 1];
    if (prev >= p.S1 && price < p.S1) {
      pivotBreakdown = { level: 'S1', from: p.S1, to: p.S2, distance: p.S1 - price };
    }
    // 突破:昨日在 R1 下方、今日站上 R1
    if (prev < p.R1 && price >= p.R1) {
      pivotBreakout = { level: 'R1', from: p.R1, target: p.R2, distance: price - p.R1 };
    }
  }

  // ============ 综合判定(趋势过滤 + 加权 + 破位 + 量价前置) ============
  let overall = '中性', action = '观望', position = 0, confidence = 0;
  if (scoreRatio > 0.5 && trendScore >= 1) { overall = '强力买入'; action = '介入'; position = 80; }
  else if (scoreRatio > 0.2 && trendScore >= 0) { overall = '买入'; action = '建仓'; position = 50; }
  else if (scoreRatio > 0.2 && trendScore === -1) { overall = '左侧试探'; action = '极轻仓尝试'; position = 20; }
  else if (scoreRatio > 0.2 && trendScore === -2) { overall = '左侧试探'; action = '等待企稳'; position = 10; }
  else if (scoreRatio < -0.5 && trendScore <= -1) { overall = '强力卖出'; action = '清仓离场'; position = 0; }
  else if (scoreRatio < -0.2 && trendScore <= 0) { overall = '卖出'; action = '减仓'; position = 20; }
  else if (scoreRatio < -0.2 && trendScore >= 1) { overall = '高空防守'; action = '减仓防守'; position = 30; }
  else { overall = '中性'; action = '观望'; position = 30; }
  // 枢轴破位/突破
  if (pivotBreakdown) {
    if (position > 30) position = 30;
    action = `跌破 ${pivotBreakdown.level},看跌 ${pivotBreakdown.to},减仓防守`;
  }
  if (pivotBreakout) {
    position = Math.max(position, 50);
    action = `突破 ${pivotBreakout.level},上看 ${pivotBreakout.target},顺势加仓`;
  }
  // ============ 量价前置判据(覆盖其他) ============
  // 放量破位:无论原 overall 是什么,都强制为"减仓回避"或"卖出"
  if (vpEvent === 'fangBreak') {
    overall = '卖出';
    action = `放量跌破${brokeMA60?'MA60':brokeMA20?'MA20':'支撑'},建议减仓回避,若次日缩量且收复再回补`;
    position = Math.min(position, 20);
  } else if (vpEvent === 'suoBreak') {
    // 缩量破位:动能衰竭,可纳入观察池
    if (position > 30) position = 30;
    action = `缩量跌破${brokeMA60?'MA60':'MA20'},动能衰竭,左侧试错标的,严格止损`;
  } else if (vpEvent === 'fangBreakout') {
    // 放量突破:唯一可"满仓"场景
    overall = '强力买入';
    action = `放量突破 MA60 + OBV 上行,高权重看涨,可介入`;
    position = Math.max(position, 70);
  } else if (vpEvent === 'upTrend') {
    if (position < 30) position = 30;
    if (overall === '中性') { overall = '买入'; action = '缩量上涨,主力锁仓可能性大,关注放量确认'; }
  }
  // 量价背离检测:价格上涨 + OBV 流出 = 看跌信号
  const priceUp = closes[last] > closes[last - 5];
  const obvDown = obvInfo.direction === 'down';
  const vpDivergence = priceUp && obvDown;
  if (vpDivergence && position > 20) {
    // 不直接覆盖,但下调仓位
    position = Math.max(20, Math.min(position, 30));
    if (overall === '买入' || overall === '强力买入') {
      action += ' · ⚠ 量价背离,价格涨但资金流出';
    }
  }
  confidence = Math.round(Math.abs(scoreRatio) * 100);

  // ============ 历史胜率回测 ============
  const backtest = backtestSignal(closes, highs, lows, opens, volumes);

  // 胜率调整仓位
  if (backtest.buySamples >= 20) {
    const wr = backtest.buyWinRate;
    if (wr < 0.40) position = Math.round(position * 0.5);
    else if (wr < 0.50) position = Math.round(position * 0.75);
    else if (wr > 0.60) position = Math.min(100, Math.round(position * 1.1));
  }

  // 异动放量 K 线列表(用于图表标记)
  const anomalyIdx = [];
  for (let i = Math.max(5, last - 60); i <= last; i++) {
    const v5 = vol5[i];
    if (!v5) continue;
    if (volumes[i] > v5 * 1.5) anomalyIdx.push({ i, type: 'high' });
  }

  return {
    overall, action, position, confidence,
    buyScore: +buyScore.toFixed(2), sellScore: +sellScore.toFixed(2),
    netScore: +netScore.toFixed(2), scoreRatio: +scoreRatio.toFixed(3),
    buy: Math.round(buyScore), sell: Math.round(sellScore),
    trend, trendScore,
    mas, indicators, trendGroup, momentumGroup, volaGroup, volGroup,
    rsi, macd, kdj, ma5, ma10, ma20, ma60, boll, atr,
    obv, obvInfo, vr, vol5, vol10, volaRatio,
    pivotSignal, pivotLabel, pivotBuy, pivotSell,
    pivotBreakdown, pivotBreakout,
    pivots,
    backtest,
    vpEvent, vpLabel, vpScore, vpDivergence,
    isFangLiang, isSuoLiang, todayVol, avgVol5,
    anomalyIdx,
  };
}

// ============ 历史胜率回测 ============
// 对过去 N 日每一天,按当日指标给出"买入"或"卖出"信号,看 5 日后表现
function backtestSignal(closes, highs, lows, opens, volumes, lookback = 100, holdDays = 5) {
  const N = closes.length;
  if (N < lookback + holdDays) {
    return { samples: 0, winRate: 0, avgReturn: 0, note: '样本不足' };
  }
  let buySamples = 0, buyWins = 0, buySum = 0;
  let sellSamples = 0, sellWins = 0, sellSum = 0;
  const start = N - lookback;
  for (let i = start; i < N - holdDays; i++) {
    const subClose = closes.slice(0, i + 1);
    const subHigh = highs.slice(0, i + 1);
    const subLow = lows.slice(0, i + 1);
    const subOpen = opens.slice(0, i + 1);
    const subVol = volumes.slice(0, i + 1);
    if (subClose.length < 60) continue;
    const sig = quickSignal(subClose, subHigh, subLow, subOpen);
    const futureRet = (closes[i + holdDays] - closes[i]) / closes[i];
    if (sig === '买入') {
      buySamples++;
      buySum += futureRet;
      if (futureRet > 0) buyWins++;
    } else if (sig === '卖出') {
      sellSamples++;
      sellSum += futureRet;
      if (futureRet < 0) sellWins++;
    }
  }
  const buyWinRate = buySamples ? buyWins / buySamples : 0;
  const buyAvgRet = buySamples ? buySum / buySamples : 0;
  return {
    samples: buySamples + sellSamples,
    buySamples, buyWins, buyWinRate, buyAvgRet,
    sellSamples, sellWins,
    lookback, holdDays,
  };
}

// 快速信号(只看 MA5/20/60 + MACD + RSI,无需全指标)
function quickSignal(closes, highs, lows, opens) {
  const last = closes.length - 1;
  if (last < 60) return '中性';
  const ma5 = calcMA(closes, 5);
  const ma20 = calcMA(closes, 20);
  const ma60 = calcMA(closes, 60);
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const price = closes[last];
  let buy = 0, sell = 0;
  if (price > ma5[last]) buy += 1.5; else sell += 1.5;
  if (price > ma20[last]) buy += 1.2; else sell += 1.2;
  if (price > ma60[last]) buy += 1.0; else sell += 1.0;
  if (macd.hist[last] > 0 && macd.dif[last] > macd.dea[last]) buy += 1.5;
  else if (macd.hist[last] < 0 && macd.dif[last] < macd.dea[last]) sell += 1.5;
  if (rsi[last] < 30) buy += 1.3;
  else if (rsi[last] > 70) sell += 1.3;
  if (buy - sell >= 2) return '买入';
  if (sell - buy >= 2) return '卖出';
  return '中性';
}

// ============================================
// 枢轴点(经典 + 斐波那契)
// ============================================
function calcPivots(high, low, close) {
  const pp = (high + low + close) / 3;
  const classic = {
    R3: high + 2 * (pp - low),
    R2: pp + (high - low),
    R1: 2 * pp - low,
    '轴心点': pp,
    S1: 2 * pp - high,
    S2: pp - (high - low),
    S3: low - 2 * (high - pp),
  };
  const fib = {
    R3: pp + (high - low) * 1.000,
    R2: pp + (high - low) * 0.618,
    R1: pp + (high - low) * 0.382,
    '轴心点': pp,
    S1: pp - (high - low) * 0.382,
    S2: pp - (high - low) * 0.618,
    S3: pp - (high - low) * 1.000,
  };
  return { classic, fibonacci: fib };
}

// 根据当前价相对枢轴点的位置,生成每一档的判断
function pivotSignal(price, p) {
  // p: {R3,R2,R1,轴心点,S1,S2,S3}
  const last = p['轴心点'];
  if (price >= p.R3) return { label: '强阻力', cls: 'sell' };
  if (price >= p.R2) return { label: '阻力区', cls: 'sell' };
  if (price >= p.R1) return { label: '偏空', cls: 'neutral' };
  if (price >= p.S1) return { label: '中性', cls: 'neutral' };
  if (price >= p.S2) return { label: '偏多', cls: 'neutral' };
  if (price >= p.S3) return { label: '支撑区', cls: 'buy' };
  return { label: '强支撑', cls: 'buy' };
}

// ============================================
// URL helpers
// ============================================
function getCodeFromURL() {
  const p = new URLSearchParams(location.search);
  return p.get('code') || '';
}
function goStock(code) {
  location.href = `stock.html?code=${encodeURIComponent(code)}`;
}
