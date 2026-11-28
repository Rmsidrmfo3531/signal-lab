import test from 'node:test';
import assert from 'node:assert/strict';
import {
 TWO_PCT_DEFAULTS,
 TWO_PCT_INTERVAL_MS,
 isStrongBullishCandle,
 isStrongTrendCandle,
 findDailyResistances,
 findDailyLevels,
 detectTwoPctSetup,
} from '../two_pct_strategy.mjs';
import {
 ScalpExecutor,
 scalpExecConfig,
 scalpLiveExecConfig,
 SCALP_PUMP_STRATEGIES,
} from '../scalp_executor.mjs';
import { scalpEventText } from '../scalp_telegram.mjs';
import { journalLine } from '../scalp_journal.mjs';
import { scalpPositionCardHTML } from '../public/live_control.js';

const M15 = TWO_PCT_INTERVAL_MS;
const DAY = 24 * 60 * 60 * 1000;
const BASE_T = Date.parse('2026-11-26T00:00:00Z');

function bar15(idx, o, h, l, c, vol = 1000) {
 const ot = BASE_T + idx * M15;
 return [ot, String(o), String(h), String(l), String(c), String(vol), ot + M15 - 1, '0'];
}

function makeDailyRows({ now, highs = [0.068, 0.072, 0.064, 0.065, 0.063], base = 0.055 } = {}) {
 const start = Math.floor(now / DAY) * DAY - highs.length * DAY;
 return highs.map((h, i) => {
  const ot = start + i * DAY;
  const o = base;
  const c = Math.min(h * 0.96, base * 1.01);
  const l = Math.min(o, c) * 0.96;
  return [ot, String(o), String(h), String(l), String(c), '50000', ot + DAY - 1, '0'];
 });
}

function makeDailySupportRows({ now, lows = [0.052, 0.049, 0.054, 0.053, 0.055], base = 0.064 } = {}) {
 const start = Math.floor(now / DAY) * DAY - lows.length * DAY;
 return lows.map((l, i) => {
  const ot = start + i * DAY;
  const o = base;
  const c = Math.max(l * 1.04, base * 0.99);
  const h = Math.max(o, c) * 1.03;
  return [ot, String(o), String(h), String(l), String(c), '50000', ot + DAY - 1, '0'];
 });
}

function fakeVenue({ fillAt = 0.0622, maxLev = 25, venueSymbol = 'BULLA-USDT' } = {}) {
 const orders = [];
 let posSize = 0, posAvg = fillAt, oid = 1, setLev = null;
 const client = {
  mode: 'TESTNET',
  positionMode: async () => ({ dualSidePosition: false }),
  marginType: async () => ({ marginType: 'CROSSED' }),
  setMarginType: async () => ({ marginType: 'CROSSED' }),
  leverage: async () => ({ maxLongLeverage: maxLev, maxShortLeverage: maxLev, availableLongVol: 1e9, availableShortVol: 1e9 }),
  setLeverage: async (_s, _side, lev) => { setLev = lev; return { leverage: lev }; },
  positions: async (sym) => Math.abs(posSize) > 0
   ? [{ symbol: sym || venueSymbol, positionAmt: String(posSize), positionSide: 'BOTH', avgPrice: String(posAvg), markPrice: String(fillAt), unrealizedProfit: '0' }]
   : [],
  openOrders: async () => orders.filter(o => o.status === 'NEW'),
  getOrder: async (_s, q) => orders.find(o => (q.orderId && String(o.orderId) === String(q.orderId)) || (q.clientOrderId && o.clientOrderId === q.clientOrderId)) ?? null,
  cancelOrder: async (_s, id) => {
   const o = orders.find(x => String(x.orderId) === String(id));
   if (o) o.status = 'CANCELED';
   return o || { orderId: id, status: 'CANCELED' };
  },
  placeOrder: async (p) => {
   const id = String(oid++);
   if (p.type === 'MARKET') {
    const qty = Number(p.quantity);
    posSize += p.side === 'BUY' ? qty : -qty;
    posAvg = fillAt;
    const rec = { ...p, orderId: id, status: 'FILLED', executedQty: String(qty), avgPrice: String(fillAt) };
    orders.push(rec);
    if (p.stopLoss) {
     const sl = JSON.parse(p.stopLoss);
     orders.push({ symbol: p.symbol, side: p.side === 'BUY' ? 'SELL' : 'BUY', type: sl.type || 'STOP_MARKET', stopPrice: String(sl.stopPrice), closePosition: 'true', workingType: sl.workingType || 'MARK_PRICE', orderId: String(oid++), status: 'NEW', parentOrderId: id });
    }
    return rec;
   }
   const rec = { ...p, orderId: id, status: 'NEW', executedQty: '0' };
   orders.push(rec);
   return rec;
  },
 };
 return { client, orders, getLev: () => setLev, setMark: px => { fillAt = px; }, setPosSize: q => { posSize = q; } };
}

test('isStrongBullishCandle: requires >=2% body, strong body ratio, and short upper wick (Marubozu)', () => {
 assert.equal(isStrongBullishCandle(bar15(0, 100, 103.2, 99.8, 103.0)).ok, true, '3% marubozu bullish candle passes');
 assert.equal(isStrongBullishCandle(bar15(0, 100, 101.9, 99.9, 101.8)).ok, false, '<2% body rejected');
 assert.equal(isStrongBullishCandle(bar15(0, 100, 106.0, 99.9, 102.2)).ok, false, 'huge upper wick shooting star rejected');
 assert.equal(isStrongBullishCandle(bar15(0, 103, 103.5, 99.5, 100.0)).ok, false, 'bearish candle rejected');
});

test('findDailyResistances: clusters 1D swing/rolling highs above entry and preserves sub-cent precision', () => {
 const now = BASE_T + 5 * M15;
 // Sub-cent altcoin (e.g. 0.00001234) must never round to 0
 const subDaily = makeDailyRows({ now, highs: [0.0000145, 0.0000158, 0.0000135, 0.0000132, 0.0000128], base: 0.0000110 });
 const sub = findDailyResistances(subDaily, { now, entry: 0.00001234 });
 assert.equal(sub.ok, true);
 assert.ok(sub.nearest && sub.nearest.price > 0.00001234, `preserved precision: ${JSON.stringify(sub.nearest)}`);
 assert.ok(sub.nearest.targetPrice > 0.00001234 && sub.nearest.targetPrice < sub.nearest.price);

 // ATH price discovery when entry is above all historical 1D highs
 const ath = findDailyResistances(makeDailyRows({ now, highs: [0.050, 0.055, 0.052, 0.054, 0.058], base: 0.045 }), { now, entry: 0.062 });
 assert.equal(ath.ok, true);
 assert.equal(ath.nearest, null);
 assert.equal(ath.isPriceDiscovery, true);
});

test('detectTwoPctSetup: enforces 15m timeframe, >=2% base candle, lower-wick green flip, SL<=2.2% bounds, capped 1D TP, and 2-stage TP1(1:2)+TP2', () => {
 const now = BASE_T + 2 * M15 + 120_000; // 2 min into bar 2
 const dailyGood = makeDailyRows({ now, highs: [0.0680, 0.0720, 0.0675, 0.0665, 0.0660], base: 0.056 });
 const baseBars = [
  bar15(0, 0.0580, 0.0592, 0.0578, 0.0590),
  bar15(1, 0.0590, 0.0621, 0.0589, 0.0620), // +5.08% strong marubozu
 ];

 // 1) Forming bar still red -> wait (no entry while bearish)
 const red = detectTwoPctSetup({
  rows15m: [...baseBars, bar15(2, 0.0620, 0.0620, 0.0612, 0.0616)],
  rows1d: dailyGood,
  livePrice: 0.0616,
  now,
 });
 assert.equal(red.ok, false);
 assert.equal(red.reason, 'TWO_PCT_WAIT_GREEN_FLIP');

 // 2) Forming bar green with NO lower wick -> reject
 const noWick = detectTwoPctSetup({
  rows15m: [...baseBars, bar15(2, 0.0620, 0.0625, 0.0620, 0.0623)],
  rows1d: dailyGood,
  livePrice: 0.0623,
  now,
 });
 assert.equal(noWick.ok, false);
 assert.equal(noWick.reason, 'TWO_PCT_NO_LOWER_WICK');

 // 3) Forming bar dipped to 0.0613 (-1.13% lower wick) then flipped green to 0.0622 -> PASS with SL=0.0613, 2-stage [tp1(1:2), tp2(1D)]
 const ok = detectTwoPctSetup({
  rows15m: [...baseBars, bar15(2, 0.0620, 0.0623, 0.0613, 0.0622)],
  rows1d: dailyGood,
  livePrice: 0.0622,
  now,
  leverage: 20,
 });
 assert.equal(ok.ok, true, JSON.stringify(ok));
 assert.equal(ok.direction, 'LONG');
 assert.equal(ok.stop, 0.0613);
 assert.equal(ok.tpSource, 'DAILY_RESISTANCE');
 assert.ok(ok.netRR >= 2.0, `netRR=${ok.netRR}`);
 assert.equal(ok.splitPartial, true);
 assert.equal(ok.targets.length, 2);
 assert.ok(ok.targets[0] > 0.0622 && ok.targets[0] < ok.targets[1]);
 assert.ok(ok.tp > 0.065 && ok.tp <= 0.066);

 // 4) Nearest 1D resistance too close (RR < 1:2) -> reject TWO_PCT_RR_BELOW_MIN
 const dailyTight = makeDailyRows({ now, highs: [0.0632, 0.0635, 0.0630, 0.0634, 0.0631], base: 0.056 });
 const lowRR = detectTwoPctSetup({
  rows15m: [...baseBars, bar15(2, 0.0620, 0.0623, 0.0613, 0.0622)],
  rows1d: dailyTight,
  livePrice: 0.0622,
  now,
  leverage: 20,
 });
 assert.equal(lowRR.ok, false);
 assert.equal(lowRR.reason, 'TWO_PCT_RR_BELOW_MIN');

 // 5) Priority 3: Tightened SL cap (2.2% / 45% ROE at 20x) rejects 2.5% SL as TWO_PCT_STOP_TOO_WIDE
 const wideSL = detectTwoPctSetup({
  rows15m: [...baseBars, bar15(2, 0.0620, 0.0623, 0.0606, 0.0622)], // ~2.57% SL -> 51.4% ROE at 20x
  rows1d: makeDailyRows({ now, highs: [0.085, 0.090, 0.082, 0.084, 0.081], base: 0.056 }),
  livePrice: 0.0622,
  now,
  leverage: 20,
 });
 assert.equal(wideSL.ok, false);
 assert.equal(wideSL.reason, 'TWO_PCT_STOP_TOO_WIDE');

 // 6) Priority 3: Unrealistic distant 1D resistance (+100%) is capped by maxTpRR (6.0) / maxTpDistPct (8.0%)
 const distantDaily = makeDailyRows({ now, highs: [0.140, 0.135, 0.130, 0.128, 0.125], base: 0.056 });
 const capped = detectTwoPctSetup({
  rows15m: [...baseBars, bar15(2, 0.0620, 0.0623, 0.0613, 0.0622)],
  rows1d: distantDaily,
  livePrice: 0.0622,
  now,
  leverage: 20,
 });
 assert.equal(capped.ok, true, JSON.stringify(capped));
 assert.equal(capped.tpCapped, true);
 assert.ok(capped.netRR <= TWO_PCT_DEFAULTS.maxTpRR + 0.05, `capped RR=${capped.netRR}`);
 assert.ok((capped.tp - 0.0622) / 0.0622 * 100 <= TWO_PCT_DEFAULTS.maxTpDistPct + 0.05, `capped dist=${(capped.tp - 0.0622) / 0.0622 * 100}%`);
 assert.equal(capped.targets.length, 2);

 // 7) Follow-up candle (bar 3) after uptrend holds -> passes; if bar 2 closed below base.open -> TWO_PCT_TREND_BROKEN
 const now3 = BASE_T + 3 * M15 + 120_000;
 const followOk = detectTwoPctSetup({
  rows15m: [...baseBars, bar15(2, 0.0620, 0.0624, 0.0615, 0.0618), bar15(3, 0.0618, 0.0623, 0.0611, 0.0620)],
  rows1d: makeDailyRows({ now: now3, highs: [0.0680, 0.0720, 0.0675, 0.0665, 0.0660], base: 0.056 }),
  livePrice: 0.0620,
  now: now3,
 });
 assert.equal(followOk.ok, true, JSON.stringify(followOk));
 const broken = detectTwoPctSetup({
  rows15m: [...baseBars, bar15(2, 0.0620, 0.0621, 0.0580, 0.0585), bar15(3, 0.0585, 0.0592, 0.0580, 0.0590)],
  rows1d: makeDailyRows({ now: now3, highs: [0.0680, 0.0720, 0.0675, 0.0665, 0.0660], base: 0.056 }),
  livePrice: 0.0590,
  now: now3,
 });
 assert.equal(broken.ok, false);
 assert.equal(broken.reason, 'TWO_PCT_TREND_BROKEN');

 // 8) 5m candle feed rejected as SCALP_INTERVAL_UNSUPPORTED
 const m5 = 5 * 60_000;
 const badTf = detectTwoPctSetup({
  rows15m: [
   [BASE_T, '100', '103', '99.9', '102.9', '100', BASE_T + m5 - 1, '0'],
   [BASE_T + m5, '102.9', '103.5', '102.1', '103.1', '100', BASE_T + 2 * m5 - 1, '0'],
  ],
  rows1d: dailyGood,
  now: BASE_T + m5 + 60_000,
 });
 assert.equal(badTf.ok, false);
 assert.equal(badTf.reason, 'SCALP_INTERVAL_UNSUPPORTED');
});

test('ScalpExecutor TWO_PCT default integration: 2-stage 50% TP1 (1:2 RR) + auto breakeven stop on fill + 50% TP2 (1D resistance)', async () => {
 assert.equal(scalpExecConfig({}).pumpStrategy, SCALP_PUMP_STRATEGIES.TWO_PCT);
 assert.equal(scalpExecConfig({}).twoPctLeverage, 20);
 assert.equal(scalpExecConfig({}).twoPctMinNetRR, 2);
 assert.equal(scalpExecConfig({}).twoPctPartialTpRR, 2);
 assert.equal(scalpExecConfig({}).twoPctMaxStopPct, 2.2);
 assert.equal(scalpLiveExecConfig({ SCALP_LIVE_MODE: 'LIVE', SCALP_LIVE_CONFIRM: 'REAL_MONEY_SCALP' }).pumpStrategy, SCALP_PUMP_STRATEGIES.REVERSAL);
 assert.equal(scalpLiveExecConfig({ SCALP_LIVE_MODE: 'LIVE', SCALP_LIVE_CONFIRM: 'REAL_MONEY_SCALP' }).pumpAlerts, false);

 const clock = { t: BASE_T + 2 * M15 + 60_000 };
 let livePrice = 0.0616; // initially red (open 0.0620)
 const v = fakeVenue({ fillAt: 0.0622, maxLev: 20 });
 const BULLA = { symbol: 'BULLAUSDT', venueSymbol: 'BULLA-USDT', tickSize: '0.00001', quantityStep: '1', minQuantityBase: '1', minNotionalUSDT: 5, takerFeeRate: 0.0005, tradable: true };
 const BTC_C = { symbol: 'BTCUSDT', venueSymbol: 'BTC-USDT', tickSize: '0.1', quantityStep: '0.001', minQuantityBase: '0.001', minNotionalUSDT: 2, tradable: true };

 const ex = new ScalpExecutor({
  config: { ...scalpExecConfig({}), stopLossEnabled: false, management: 'TRADER_LADDER', makerEntry: false, trendMode: 'off', minScore: 95, dailyLossPct: 15, twoPctPollMs: 15000 },
  client: v.client,
  now: () => clock.t,
  contracts: async () => new Map([['BULLAUSDT', BULLA], ['BTCUSDT', BTC_C]]),
  tickers: async () => [{ symbol: 'BTC-USDT', quoteVolume: '900000000', lastPrice: '90000' }, { symbol: 'BULLA-USDT', quoteVolume: '50000000', lastPrice: String(livePrice) }],
  balance: async () => ({ equity: 3000, available: 2800 }),
  priceOf: async () => livePrice,
  markOf: async () => livePrice,
  candles: async (sym, iv) => {
   if (sym === 'BTCUSDT' && iv === '5m') {
    const b = Math.floor(clock.t / 300_000);
    return [[(b - 1) * 300_000, '90000', '90050', '89950', '90000', '100', b * 300_000 - 1, '0']];
   }
   if (iv === '15m') {
    return [
     bar15(0, 0.0580, 0.0592, 0.0578, 0.0590),
     bar15(1, 0.0590, 0.0621, 0.0589, 0.0620), // +5.08% marubozu
     bar15(2, 0.0620, Math.max(0.0620, livePrice), 0.0613, livePrice), // dipped to 0.0613
    ];
   }
   if (iv === '1d') {
    return makeDailyRows({ now: clock.t, highs: [0.0680, 0.0720, 0.0675, 0.0665, 0.0660], base: 0.056 });
   }
   return [];
  },
 });
 ex.arm();

 // 1) UP alert arrives while forming 15m candle is still red -> waits without entering
 const upRes = await ex.pumpAlert({ symbol: 'BULLAUSDT', dir: 'UP', pct: 14.1, low: 0.05906, high: 0.06737, price: 0.0616, at: clock.t - 1000, key: 'g:2' });
 assert.equal(upRes.entered, false);
 assert.equal(upRes.reason, 'TWO_PCT_WAIT_GREEN_FLIP');
 assert.equal(ex.pumpWatch.size, 1);
 assert.equal(ex.store.open.length, 0);

 // 2) 15s later: candle flips green to 0.0622 -> tick() triggers LONG entry with 2-stage TP1 + TP2!
 clock.t += 16_000;
 livePrice = 0.0622;
 await ex.tick(clock.t);
 assert.equal(ex.store.open.length, 1, JSON.stringify(ex.store.skips.slice(-4)));
 assert.equal(ex.pumpWatch.size, 0, 'watch cleared after entry');

 const [p] = ex.store.open;
 assert.equal(p.direction, 'LONG');
 assert.equal(p.trigger, 'PUMP_ALERT');
 assert.equal(p.interval, '15m');
 assert.equal(p.leverage, 20);
 assert.equal(v.getLev(), 20);
 assert.equal(p.management, 'CURRENT', 'TWO_PCT never uses TRADER_LADDER');
 assert.equal(p.stopLossEnabled, true, 'TWO_PCT always uses fixed exchange SL');
 assert.equal(p.stop, 0.0613, 'SL is at lower-wick low');
 assert.equal(p.targets.length, 2, `2-stage TP1+TP2: ${p.targets}`);
 assert.ok(p.targets[0] > 0.063 && p.targets[0] < p.targets[1], `TP1 < TP2: ${p.targets}`);
 assert.ok(p.targets[1] > 0.065 && p.targets[1] <= 0.066, `1D resistance TP2: ${p.targets}`);
 assert.equal(p.parts[0] + p.parts[1], p.filled);
 assert.ok(p.parts[0] > 0 && p.parts[1] > 0 && Math.abs(p.parts[0] - p.parts[1]) <= 1, `50/50 split: ${p.parts}`);
 assert.equal(p.scalpScore ?? null, null, 'no meaningless 5m reversal score attached');
 assert.ok(p.twoPct && p.twoPct.netRR >= 2.0 && p.twoPct.splitPartial === true, JSON.stringify(p.twoPct));

 // Verify exchange orders: 1 MARKET BUY + 1 STOP_MARKET at 0.0613 + 2 TAKE_PROFIT_MARKET (50% TP1 + 50% TP2)
 const slOrders = v.orders.filter(o => o.type === 'STOP_MARKET' && o.status === 'NEW');
 const tpOrders = v.orders.filter(o => o.type === 'TAKE_PROFIT_MARKET' && o.status === 'NEW');
 assert.equal(slOrders.length, 1);
 assert.equal(Number(slOrders[0].stopPrice), 0.0613);
 assert.equal(tpOrders.length, 2);
 assert.equal(Number(tpOrders[0].quantity), p.parts[0]);
 assert.equal(Number(tpOrders[1].quantity), p.parts[1]);

 // 3) Reconcile before TP1 must preserve wick SL and never scale in / early exit
 clock.t += 60 * 60_000; // +1h
 v.setMark(0.0630);
 await ex.reconcile();
 assert.equal(ex.store.open.length, 1, 'still open letting 1:2+ RR play out');
 assert.equal(p.breakevenMoved, false);
 assert.equal(v.orders.filter(o => o.type === 'STOP_MARKET' && o.status === 'NEW').length, 1, 'exchange SL preserved on reconcile');
 assert.equal(v.orders.filter(o => o.type === 'MARKET').length, 1, 'no scale-in or early exit orders sent');

 // 4) Priority 2: Simulate TP1 (50%) filling on venue -> reconcile() automatically moves STOP_MARKET to breakeven!
 v.setPosSize(p.parts[1]);
 v.setMark(p.targets[0] + 0.0002);
 clock.t += 30_000;
 await ex.reconcile();
 assert.equal(p.tpDone[0], true, 'TP1 marked filled');
 assert.equal(p.breakevenMoved, true, 'SL automatically moved to breakeven after TP1 fill');
 assert.ok(p.stop >= p.avg, `breakeven stop (${p.stop}) >= avg (${p.avg})`);
 assert.ok(ex.store.events.some(e => e.type === 'STOP_TO_BREAKEVEN'), 'STOP_TO_BREAKEVEN event emitted');

 // 5) Telegram notice, Journal line, and UI card
 const openedEv = ex.store.events.find(e => e.type === 'OPENED');
 const tg = scalpEventText(openedEv);
 assert.match(tg, /공습·2%/);
 assert.match(tg, /20배/);
 assert.match(tg, /아래꼬리 손절/);
 assert.match(tg, /1차 목표/);
 assert.match(tg, /50% · 1:2 RR\+본전스탑/);
 assert.match(tg, /2차 목표/);
 assert.match(tg, /일봉 저항/);
 assert.match(tg, /손익비 1:/);

 const jLine = journalLine({ ...p, closedAt: clock.t + 60_000, closeReason: 'ALL_TARGETS', netUSD: 45 });
 assert.equal(jLine.interval, '15m');
 assert.equal(jLine.trigger, 'PUMP_ALERT');
 assert.equal(jLine.plan.stop, 0.0613);
 assert.ok(jLine.twoPct);

 const card = scalpPositionCardHTML(ex.status().positions[0]);
 assert.match(card, /공습·2%/);
 assert.match(card, /15m 2% 매매법/);
 assert.match(card, /일봉\(1D\) 저항/);
 assert.match(card, /1차 목표 뒤 본전/);
 assert.doesNotMatch(card, /점 [A-F]/);
});

test('SHORT symmetric 2% 매매법: @ggangalt2_bot DOWN enters SHORT with upper-wick SL & 2-stage TP1(1:2) + TP2(1D support)', async () => {
 const now = BASE_T + 2 * M15 + 60_000;
 // Pure unit checks for SHORT candle & 1D support
 assert.equal(isStrongTrendCandle(bar15(1, 0.0630, 0.0631, 0.0598, 0.0600), 'SHORT').ok, true, '-4.76% bearish marubozu passes');
 assert.equal(isStrongTrendCandle(bar15(1, 0.0630, 0.0631, 0.0550, 0.0610), 'SHORT').ok, false, 'huge lower wick bearish hammer rejected');
 const sup = findDailyLevels(makeDailySupportRows({ now, lows: [0.052, 0.049, 0.054, 0.053, 0.055], base: 0.064 }), { now, entry: 0.0598, direction: 'SHORT' });
 assert.equal(sup.ok, true);
 assert.equal(sup.nearest.price, 0.055, 'nearest 1D support below entry chosen first');
 assert.ok(sup.nearest.targetPrice > 0.055 && sup.nearest.targetPrice < 0.0598, 'front-run 0.1% above support');

 // ATL breakdown price discovery fallback
 const atl = findDailyLevels(makeDailySupportRows({ now, lows: [0.065, 0.068, 0.064, 0.066, 0.063], base: 0.072 }), { now, entry: 0.0598, direction: 'SHORT' });
 assert.equal(atl.ok, true);
 assert.equal(atl.nearest, null);
 assert.equal(atl.isPriceDiscovery, true);

 // Full ScalpExecutor integration for DOWN alert -> SHORT
 const clock = { t: now };
 let livePrice = 0.0604; // initially green bounce above 0.0600 open (must wait!)
 const v = fakeVenue({ fillAt: 0.0598, maxLev: 20, venueSymbol: 'FLNC-USDT' });
 const FLNC = { symbol: 'FLNCUSDT', venueSymbol: 'FLNC-USDT', tickSize: '0.00001', quantityStep: '1', minQuantityBase: '1', minNotionalUSDT: 5, takerFeeRate: 0.0005, tradable: true };
 const BTC_C = { symbol: 'BTCUSDT', venueSymbol: 'BTC-USDT', tickSize: '0.1', quantityStep: '0.001', minQuantityBase: '0.001', minNotionalUSDT: 2, tradable: true };

 const ex = new ScalpExecutor({
  config: { ...scalpExecConfig({}), stopLossEnabled: false, management: 'TRADER_LADDER', makerEntry: false, trendMode: 'off', minScore: 95, dailyLossPct: 15, twoPctPollMs: 15000 },
  client: v.client,
  now: () => clock.t,
  contracts: async () => new Map([['FLNCUSDT', FLNC], ['BTCUSDT', BTC_C]]),
  tickers: async () => [{ symbol: 'BTC-USDT', quoteVolume: '900000000', lastPrice: '90000' }, { symbol: 'FLNC-USDT', quoteVolume: '50000000', lastPrice: String(livePrice) }],
  balance: async () => ({ equity: 3000, available: 2800 }),
  priceOf: async () => livePrice,
  markOf: async () => livePrice,
  candles: async (sym, iv) => {
   if (sym === 'BTCUSDT' && iv === '5m') {
    const b = Math.floor(clock.t / 300_000);
    return [[(b - 1) * 300_000, '90000', '90050', '89950', '90000', '100', b * 300_000 - 1, '0']];
   }
   if (iv === '15m') {
    return [
     bar15(0, 0.0640, 0.0642, 0.0628, 0.0630),
     bar15(1, 0.0630, 0.0631, 0.0598, 0.0600), // -4.76% strong bearish marubozu
     bar15(2, 0.0600, 0.0607, Math.min(0.0600, livePrice), livePrice), // bounced to 0.0607 upper wick
    ];
   }
   if (iv === '1d') {
    return makeDailySupportRows({ now: clock.t, lows: [0.052, 0.049, 0.054, 0.053, 0.055], base: 0.064 });
   }
   return [];
  },
 });
 ex.arm();

 // 1) DOWN alert arrives while forming 15m candle is still green -> waits for bearish flip
 const downRes = await ex.pumpAlert({ symbol: 'FLNCUSDT', dir: 'DOWN', pct: 11.6, low: 0.0598, high: 0.0676, price: 0.0604, at: clock.t - 1000, key: 'g:s1' });
 assert.equal(downRes.entered, false);
 assert.equal(downRes.reason, 'TWO_PCT_WAIT_GREEN_FLIP');
 assert.equal(ex.pumpWatch.size, 1);
 assert.equal(ex.pumpWatch.get('FLNCUSDT').direction, 'SHORT');

 // 2) 15s later: candle flips red to 0.0598 -> enters SHORT with upper-wick SL=0.0607 & 2-stage [TP1(1:2), TP2(1D support)]
 clock.t += 16_000;
 livePrice = 0.0598;
 await ex.tick(clock.t);
 assert.equal(ex.store.open.length, 1, JSON.stringify(ex.store.skips.slice(-4)));
 const [p] = ex.store.open;
 assert.equal(p.direction, 'SHORT');
 assert.equal(p.interval, '15m');
 assert.equal(p.leverage, 20);
 assert.equal(p.stopLossEnabled, true);
 assert.equal(p.management, 'CURRENT');
 assert.equal(p.stop, 0.0607, 'SL at upper-wick high');
 assert.equal(p.targets.length, 2, `2-stage SHORT TP1+TP2: ${p.targets}`);
 assert.ok(p.targets[0] < 0.0598 && p.targets[0] > p.targets[1], `TP1 > TP2 for SHORT: ${p.targets}`);
 assert.ok(p.targets[1] >= 0.055 && p.targets[1] < 0.056, `1D support TP2: ${p.targets}`);
 assert.equal(p.twoPct.tpSource, 'DAILY_SUPPORT');
 assert.ok(p.twoPct.netRR >= 2.0, `netRR=${p.twoPct.netRR}`);
 assert.equal(p.scalpScore ?? null, null);

 const slOrders = v.orders.filter(o => o.type === 'STOP_MARKET' && o.status === 'NEW');
 const tpOrders = v.orders.filter(o => o.type === 'TAKE_PROFIT_MARKET' && o.status === 'NEW');
 assert.equal(slOrders.length, 1);
 assert.equal(Number(slOrders[0].stopPrice), 0.0607);
 assert.equal(tpOrders.length, 2);
 assert.equal(tpOrders[0].side, 'BUY');
 assert.equal(tpOrders[1].side, 'BUY');

 // Telegram & UI card reflect SHORT terminology cleanly
 const tg = scalpEventText(ex.store.events.find(e => e.type === 'OPENED'));
 assert.match(tg, /숏 20배 진입 · 공습·2%/);
 assert.match(tg, /윗꼬리 손절/);
 assert.match(tg, /1차 목표/);
 assert.match(tg, /일봉 지지/);
 assert.match(tg, /15m 기준 음봉 −/);

 const card = scalpPositionCardHTML(ex.status().positions[0]);
 assert.match(card, /기준 음봉 −/);
 assert.match(card, /윗꼬리 손절 \+/);
 assert.match(card, /일봉\(1D\) 지지/);
});

test('Priority 3 & 4: TWO_PCT per-symbol cooldowns (4h loss / 1h win) and EU session 0.5x sizing', async () => {
 const euBase = Date.parse('2026-11-26T10:00:00Z'); // 10:00 UTC = 19:00 KST (EUROPE session)
 const euBar = (idx, o, h, l, c) => [euBase + idx * M15, String(o), String(h), String(l), String(c), '1000', euBase + (idx + 1) * M15 - 1, '0'];
 const makeEx = (clock, closed = []) => {
  const v = fakeVenue({ fillAt: 0.0622, maxLev: 20 });
  const BULLA = { symbol: 'BULLAUSDT', venueSymbol: 'BULLA-USDT', tickSize: '0.00001', quantityStep: '1', minQuantityBase: '1', minNotionalUSDT: 5, takerFeeRate: 0.0005, tradable: true };
  const BTC_C = { symbol: 'BTCUSDT', venueSymbol: 'BTC-USDT', tickSize: '0.1', quantityStep: '0.001', minQuantityBase: '0.001', minNotionalUSDT: 2, tradable: true };
  const ex = new ScalpExecutor({
   config: { ...scalpExecConfig({}), stopLossEnabled: false, management: 'TRADER_LADDER', makerEntry: false, trendMode: 'off', minScore: 95, dailyLossPct: 15, twoPctPollMs: 15000, sessionWeighting: true, sessionEuMult: 0.5 },
   client: v.client,
   now: () => clock.t,
   contracts: async () => new Map([['BULLAUSDT', BULLA], ['BTCUSDT', BTC_C]]),
   tickers: async () => [{ symbol: 'BTC-USDT', quoteVolume: '900000000', lastPrice: '90000' }, { symbol: 'BULLA-USDT', quoteVolume: '50000000', lastPrice: '0.0622' }],
   balance: async () => ({ equity: 3000, available: 2800 }),
   priceOf: async () => 0.0622,
   markOf: async () => 0.0622,
   candles: async (sym, iv) => {
    if (sym === 'BTCUSDT' && iv === '5m') {
     const b = Math.floor(clock.t / 300_000);
     return [[(b - 1) * 300_000, '90000', '90050', '89950', '90000', '100', b * 300_000 - 1, '0']];
    }
    if (iv === '15m') {
     return [
      euBar(0, 0.0580, 0.0592, 0.0578, 0.0590),
      euBar(1, 0.0590, 0.0621, 0.0589, 0.0620),
      euBar(2, 0.0620, 0.0623, 0.0613, 0.0622),
     ];
    }
    if (iv === '1d') return makeDailyRows({ now: clock.t, highs: [0.0680, 0.0720, 0.0675, 0.0665, 0.0660], base: 0.056 });
    return [];
   },
  });
  ex.store.closed.push(...closed);
  ex.arm();
  return ex;
 };

 // 1) Loss cooldown (4h): blocked 2h after a TWO_PCT loss on the same symbol
 {
  const clock = { t: euBase + 2 * M15 + 60_000 };
  const ex = makeEx(clock, [{ symbol: 'BULLAUSDT', twoPct: { netRR: 3 }, netUSD: -25, closeReason: 'STOP', closedAt: clock.t - 120 * 60_000 }]);
  const res = await ex.pumpAlert({ symbol: 'BULLAUSDT', dir: 'UP', pct: 10, low: 0.059, high: 0.063, price: 0.0622, at: clock.t - 1000, key: 'c:1' });
  assert.equal(res.entered, false);
  assert.equal(res.reason, 'TWO_PCT_LOSS_COOLDOWN');
 }

 // 2) Win cooldown (1h): blocked 15m after a TWO_PCT win on the same symbol (prevents THEUSDT chase-loss)
 {
  const clock = { t: euBase + 2 * M15 + 60_000 };
  const ex = makeEx(clock, [{ symbol: 'BULLAUSDT', twoPct: { netRR: 3 }, netUSD: 40, closeReason: 'ALL_TARGETS', closedAt: clock.t - 15 * 60_000 }]);
  const res = await ex.pumpAlert({ symbol: 'BULLAUSDT', dir: 'UP', pct: 10, low: 0.059, high: 0.063, price: 0.0622, at: clock.t - 1000, key: 'c:2' });
  assert.equal(res.entered, false);
  assert.equal(res.reason, 'TWO_PCT_WIN_COOLDOWN');
 }

 // 3) EU session 0.5x sizing: riskUSD halved compared to non-EU session (0.75% of $3k = $22.50 -> ~$11.25 in EU)
 {
  const clockEu = { t: euBase + 2 * M15 + 60_000 };
  const exEu = makeEx(clockEu);
  const resEu = await exEu.pumpAlert({ symbol: 'BULLAUSDT', dir: 'UP', pct: 10, low: 0.059, high: 0.063, price: 0.0622, at: clockEu.t - 1000, key: 'c:3' });
  assert.equal(resEu.entered, true, JSON.stringify(resEu));
  const [pEu] = exEu.store.open;
  const exNonEu = makeEx({ t: euBase + 2 * M15 + 60_000 });
  exNonEu.config.sessionWeighting = false;
  const resBase = await exNonEu.pumpAlert({ symbol: 'BULLAUSDT', dir: 'UP', pct: 10, low: 0.059, high: 0.063, price: 0.0622, at: clockEu.t - 1000, key: 'c:4' });
  assert.equal(resBase.entered, true, JSON.stringify(resBase));
  const [pBase] = exNonEu.store.open;
  const ratio = pEu.riskUSD / pBase.riskUSD;
  assert.ok(ratio >= 0.45 && ratio <= 0.55, `expected EU 0.5x riskUSD ratio, got ${ratio.toFixed(3)} (eu=$${pEu.riskUSD.toFixed(2)}, base=$${pBase.riskUSD.toFixed(2)})`);
 }
});
