let deferredPrompt = null;
let timer = null;
let running = false;

const el = (id) => document.getElementById(id);

const pairEl = el("pair");
const tfEl = el("tf");
const freqEl = null; // 今回は勝率優先で固定（必要なら後で復活）

const statusPill = el("statusPill");
const countdownEl = el("countdown");
const signalText = el("signalText");
const signalMeta = el("signalMeta");

const entryCountdownEl = el("entryCountdown");
const entryPlanEl = el("entryPlan");
const entryLeadEl = el("entryLead");

const learnMeta = el("learnMeta");

const confModeEl = el("confMode");
const confThEl = el("confTh");
const guardModeEl = el("guardMode");

const priceInputEl = el("priceInput");
const btnAddPriceEl = el("btnAddPrice");
const priceStatusEl = el("priceStatus");

function setStatus(text) { statusPill.textContent = text; }
function nowMs() { return Date.now(); }

function nextBoundaryMs(tfSec) {
  const tfMs = tfSec * 1000;
  const t = nowMs();
  return Math.ceil(t / tfMs) * tfMs;
}
function formatCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** ===== パラメータ（FX/BTC/ETH 自動切替） ===== */
function isCryptoPair(pair) { return pair.includes("BTC") || pair.includes("ETH"); }
function isBTC(pair){ return pair.includes("BTC"); }
function isETH(pair){ return pair.includes("ETH"); }
function paramsFor(pair) {
  if (!isCryptoPair(pair)) {
    return { roundStep: 0.05, swingNear: 0.06, spike5s: 0.06, volHigh: 0.0008, trendStrong: 0.0002 };
  }
  if (isBTC(pair)) {
    return { roundStep: 100, swingNear: 150, spike5s: 150, volHigh: 0.0020, trendStrong: 0.0006 };
  }
  return { roundStep: 10, swingNear: 12, spike5s: 12, volHigh: 0.0020, trendStrong: 0.0006 };
}

/** ===== 通知 ===== */
async function ensureNotificationPermission() {
  if (!("Notification" in window)) { alert("通知に未対応です（Android Chrome推奨）"); return false; }
  const p = await Notification.requestPermission();
  return p === "granted";
}
function notify(title, body) { if (Notification.permission === "granted") new Notification(title, { body }); }

/** ===== PWA ===== */
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("./sw.js"); } catch (e) { console.warn("SW登録失敗:", e); }
}
function setupInstallButton() {
  const btn = el("btnInstall");
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    btn.style.display = "block";
  });
  btn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt = null;
    btn.style.display = "none";
  });
}

/** ===== 10分バケット ===== */
function getBucket10Key(pair, tfSec) {
  const d = new Date();
  const weekday = d.getDay();
  const hour = d.getHours();
  const min = d.getMinutes();
  const bucket10 = Math.floor(min / 10); // 0..5
  return `${pair}|${tfSec}|${weekday}|${hour}|${bucket10}`;
}

/** ===== 価格蓄積（手動） ===== */
const PRICE_KEY = "theoption_prices_v1";
function loadPrices() {
  const raw = localStorage.getItem(PRICE_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
function savePrices(obj) { localStorage.setItem(PRICE_KEY, JSON.stringify(obj)); }
function addPriceTick(pair, price) {
  const db = loadPrices();
  if (!db[pair]) db[pair] = [];
  db[pair].push({ t: Date.now(), p: price });

  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 直近2時間
  db[pair] = db[pair].filter(x => x.t >= cutoff);

  savePrices(db);
  priceStatusEl.textContent = `価格データ: ${db[pair].length}件（${pair}）`;
}
function getTicks(pair) {
  const db = loadPrices();
  return (db[pair] || []).slice().sort((a,b) => a.t - b.t);
}

/** ===== tick→ローソク ===== */
function buildCandlesFromTicks(ticks, tfSec) {
  const tfMs = tfSec * 1000;
  if (!ticks.length) return [];
  const candles = [];
  let bucketStart = Math.floor(ticks[0].t / tfMs) * tfMs;
  let o = ticks[0].p, h = ticks[0].p, l = ticks[0].p, c = ticks[0].p;

  for (const x of ticks) {
    const b = Math.floor(x.t / tfMs) * tfMs;
    if (b !== bucketStart) {
      candles.push({ t: bucketStart, o, h, l, c });
      bucketStart = b;
      o = h = l = c = x.p;
    } else {
      h = Math.max(h, x.p);
      l = Math.min(l, x.p);
      c = x.p;
    }
  }
  candles.push({ t: bucketStart, o, h, l, c });
  return candles;
}

/** ===== EMA/ATR/レジーム ===== */
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i = period; i < values.length; i++) e = values[i]*k + e*(1-k);
  return e;
}
function atrPercent(candles, period=14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i-1];
    const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
    trs.push(tr);
  }
  const last = trs.slice(-period);
  const atr = last.reduce((a,b)=>a+b,0) / period;
  const price = candles[candles.length-1].c;
  return atr / price;
}
function detectRegime(candles, pair) {
  const closes = candles.map(x => x.c);
  const eFast = ema(closes, 10);
  const eSlow = ema(closes, 30);
  const vol = atrPercent(candles, 14);
  if (eFast == null || eSlow == null || vol == null) return { type: "unknown", highVol: false, vol: null, trend: 0 };

  const trend = eFast - eSlow;
  const price = closes[closes.length-1];
  const trendNorm = trend / price;

  const pr = paramsFor(pair);
  const highVol = vol >= pr.volHigh;
  const trendStrong = Math.abs(trendNorm) >= pr.trendStrong;
  const type = trendStrong ? "trend" : "range";
  return { type, highVol, vol, trend: trendNorm };
}

/** ===== ライン（スイング/キリ番） + 急変 ===== */
function swingLevels(candles, lookback=40) {
  const xs = candles.slice(-lookback);
  if (xs.length < 5) return null;
  const swingHigh = Math.max(...xs.map(x=>x.h));
  const swingLow  = Math.min(...xs.map(x=>x.l));
  return { swingHigh, swingLow };
}
function nearestRound(price, step) {
  const k = Math.round(price / step);
  return k * step;
}
function detectSpike(ticks, seconds=5, pair="") {
  if (ticks.length < 2) return false;
  const now = Date.now();
  const recent = ticks.filter(x => x.t >= now - seconds*1000);
  if (recent.length < 2) return false;
  const diff = Math.abs(recent[recent.length-1].p - recent[0].p);
  const th = paramsFor(pair).spike5s;
  return diff >= th;
}

/** ===== A: コンフルエンス（本物） ===== */
function getConfluenceSignalsReal({ pair, tfSec, side }) {
  const ticks = getTicks(pair);
  const candles = buildCandlesFromTicks(ticks, tfSec);

  // 勝率優先：最低ローソク数が足りなければ撃たない
  const minCandles =
    tfSec <= 30 ? 60 :
    tfSec === 60 ? 40 : 30;

  if (candles.length < minCandles) {
    return { ok: false, reason: `ローソク不足（${candles.length}/${minCandles}）` };
  }

  const price = candles[candles.length-1].c;
  const reg = detectRegime(candles, pair);
  const sw = swingLevels(candles, 40);

  const pr = paramsFor(pair);

  const nearSwing = sw
    ? (Math.min(Math.abs(price - sw.swingHigh), Math.abs(price - sw.swingLow)) <= pr.swingNear)
    : false;

  const step = pr.roundStep;
  const rd = nearestRound(price, step);
  const nearRound = Math.abs(price - rd) <= (isCryptoPair(pair) ? step * 0.15 : step * 0.3);

  // 急変（5秒）＋超短期は1秒も追加
  const spike5 = detectSpike(ticks, 5, pair);
  const spike1 = (tfSec <= 30) ? detectSpike(ticks, 1, pair) : false;
  const noSpike = !(spike5 || spike1);

  // レジーム一致
  let regimeOk = true;
  if (reg.type === "trend") {
    if (side === "HIGH") regimeOk = reg.trend > 0;
    if (side === "LOW")  regimeOk = reg.trend < 0;
  }

  // 高ボラは短期ほどブロック
  const highVolBlock = reg.highVol && (tfSec <= 30);

  return {
    ok: true,
    nearSwing,
    nearRound,
    noSpike,
    regimeOk: regimeOk && !highVolBlock,
    meta: { reg, price, swing: sw, round: rd }
  };
}

function confluenceScore(side) {
  const pair = pairEl.value;
  const tfSec = Number(tfEl.value);
  const s = getConfluenceSignalsReal({ pair, tfSec, side });
  if (!s.ok) return { score: 0, reasons: [s.reason] };

  let score = 0;
  const reasons = [];

  if (s.nearSwing) { score += 1; reasons.push("スイング付近"); }
  if (s.nearRound) { score += 1; reasons.push("キリ番付近"); }
  if (s.noSpike)   { score += 1; reasons.push("直前急変なし"); }
  if (s.regimeOk)  { score += 1; reasons.push("レジーム一致"); }

  return { score, reasons };
}

/** ===== B: 直近成績ガード ===== */
const GUARD_KEY = "theoption_guard_v1";
function loadGuard() {
  const raw = localStorage.getItem(GUARD_KEY);
  if (!raw) return { recent: [], stopUntil: 0 };
  try { return JSON.parse(raw); } catch { return { recent: [], stopUntil: 0 }; }
}
function saveGuard(g) { localStorage.setItem(GUARD_KEY, JSON.stringify(g)); }
function isGuardStopped() {
  const g = loadGuard();
  return Date.now() < (g.stopUntil || 0);
}
function guardStatusText() {
  const g = loadGuard();
  const recent = g.recent || [];
  const wins = recent.filter(x => x === 1).length;
  const total = recent.length;
  const rate = total ? Math.round((wins/total)*100) : 0;
  const stop = g.stopUntil && Date.now() < g.stopUntil;
  return stop ? `停止中（直近${total}回 勝率${rate}%）` : `直近${total}回 勝率${rate}%`;
}
function updateGuardAfterResult(win) {
  const g = loadGuard();
  g.recent = Array.isArray(g.recent) ? g.recent : [];
  g.recent.push(win ? 1 : 0);
  if (g.recent.length > 10) g.recent = g.recent.slice(-10);

  const wins = g.recent.filter(x => x === 1).length;
  const total = g.recent.length;
  const rate = total ? wins / total : 1;

  if (total >= 10 && rate < 0.65) {
    g.stopUntil = Date.now() + 30 * 60 * 1000;
  }
  saveGuard(g);
}

/** ===== C: 遅延最適化（0-3秒） ===== */
const DELAY_KEY = "theoption_delay_v1";
function loadDelay() {
  const raw = localStorage.getItem(DELAY_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
function saveDelay(d) { localStorage.setItem(DELAY_KEY, JSON.stringify(d)); }
function bayesP(w, t) { return (w + 1) / (t + 2); }

function pickBestLeadSec(bucketKey, side) {
  const d = loadDelay();
  const key = `${bucketKey}|${side}`;
  const row = d[key];
  if (!row) return Number(entryLeadEl?.value ?? 1);

  let best = { lead: Number(entryLeadEl?.value ?? 1), p: 0, total: 0 };
  for (const lead of ["0","1","2","3"]) {
    const rec = row[lead] || { wins: 0, total: 0 };
    const total = rec.total || 0;
    if (total < 10) continue;
    const p = bayesP(rec.wins || 0, total);
    if (p > best.p) best = { lead: Number(lead), p, total };
  }
  return best.p > 0 ? best.lead : Number(entryLeadEl?.value ?? 1);
}
function updateDelayAfterResult(bucketKey, side, leadSec, win) {
  const d = loadDelay();
  const key = `${bucketKey}|${side}`;
  if (!d[key]) d[key] = { "0":{wins:0,total:0}, "1":{wins:0,total:0}, "2":{wins:0,total:0}, "3":{wins:0,total:0} };
  const rec = d[key][String(leadSec)] || { wins: 0, total: 0 };
  rec.total += 1;
  if (win) rec.wins += 1;
  d[key][String(leadSec)] = rec;
  saveDelay(d);
}

/** ===== “勝率80% + 母数 + ベイズ” を端末内で作る（案①） =====
 *  ここでは「10分枠×方向」単位の勝率を端末内で学習する形にしています。
 */
const STATS_KEY = "theoption_stats_v1";
// { "<bucketKey>|<side>": { wins, total } }
function loadStatsLocal() {
  const raw = localStorage.getItem(STATS_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
function saveStatsLocal(s) { localStorage.setItem(STATS_KEY, JSON.stringify(s)); }

function minN(tfSec, pair) {
  // 勝率優先：厳しめ
  const crypto = isCryptoPair(pair);
  if (tfSec <= 30) return crypto ? 80 : 50;
  if (tfSec === 60) return crypto ? 50 : 30;
  return crypto ? 30 : 20;
}

function getWinProb(bucketKey, side) {
  const s = loadStatsLocal();
  const key = `${bucketKey}|${side}`;
  const rec = s[key] || { wins: 0, total: 0 };
  const p = bayesP(rec.wins, rec.total);
  return { ...rec, p };
}

function updateStatsAfterResult(bucketKey, side, win) {
  const s = loadStatsLocal();
  const key = `${bucketKey}|${side}`;
  if (!s[key]) s[key] = { wins: 0, total: 0 };
  s[key].total += 1;
  if (win) s[key].wins += 1;
  saveStatsLocal(s);
}

/** ===== エントリー予約状態 ===== */
let entryPlan = null; // { entryAtMs, side, pair, tfSec, conf, reason, bucketKey, leadSec, notified }

/** ===== 表示 ===== */
function renderSignal(sig) {
  signalText.textContent = sig.side;
  let cls = "warn";
  if (sig.side === "HIGH") cls = "ok";
  if (sig.side === "LOW") cls = "bad";
  signalText.className = `signal ${cls}`;
  signalMeta.textContent = `確信度: ${Math.round(sig.conf * 100)}% / 根拠: ${sig.reason}`;
}

/** ===== 採用ロジック（勝率優先） ===== */
function decideSignal(pair, tfSec) {
  const bucketKey = getBucket10Key(pair, tfSec);

  // 今回は「方向」も統計に含める（HIGH/LOW別に勝率が違う前提）
  // まずは両方向の勝率を見て高い方を候補にする
  const hi = getWinProb(bucketKey, "HIGH");
  const lo = getWinProb(bucketKey, "LOW");

  const best = (hi.p >= lo.p) ? { side: "HIGH", ...hi } : { side: "LOW", ...lo };
  const needN = minN(tfSec, pair);

  // 80% & 母数
  if (best.total < needN) {
    return { side: "見送り", conf: 0.5, reason: `母数不足（${best.total}/${needN}）`, bucketKey };
  }
  if (best.p < 0.80) {
    return { side: "見送り", conf: best.p, reason: `勝率未達（${Math.round(best.p*100)}% < 80%）`, bucketKey };
  }

  // A: コンフルエンス（ONの時のみ）
  if ((confModeEl?.value ?? "on") === "on") {
    const th = Number(confThEl?.value ?? 2);
    const c = confluenceScore(best.side);
    if (c.score < th) {
      return { side: "見送り", conf: Math.min(best.p, 0.79), reason: `コンフル不足（${c.score}/${th}）: ${c.reasons.join("・")}`, bucketKey };
    }
    return { side: best.side, conf: best.p, reason: `勝率${Math.round(best.p*100)}% & コンフルOK: ${c.reasons.join("・")}`, bucketKey };
  }

  return { side: best.side, conf: best.p, reason: `勝率${Math.round(best.p*100)}%（ベイズ補正）`, bucketKey };
}

/** ===== ループ ===== */
function tick() {
  const tfSec = Number(tfEl.value);
  const pair = pairEl.value;

  // B: 直近成績ガード
  if ((guardModeEl?.value ?? "on") === "on" && isGuardStopped()) {
    setStatus(guardStatusText());
    countdownEl.textContent = formatCountdown(nextBoundaryMs(tfSec) - Date.now());
    renderSignal({ side: "見送り", conf: 0.5, reason: "直近成績ガードにより停止中" });
    return;
  } else {
    setStatus("稼働中");
  }

  const boundary = nextBoundaryMs(tfSec);
  const msLeft = boundary - nowMs();
  countdownEl.textContent = formatCountdown(msLeft);

  // エントリー表示更新
  if (entryPlan) {
    const ms = entryPlan.entryAtMs - nowMs();
    if (ms > 0) {
      entryCountdownEl.textContent = `${Math.ceil(ms/1000)}秒`;
      entryPlanEl.textContent = `${entryPlan.side} / ${entryPlan.pair} / ${entryPlan.tfSec}秒（確信度 ${Math.round(entryPlan.conf*100)}%）`;
    } else {
      entryCountdownEl.textContent = "--";
      entryPlanEl.textContent = "エントリー時刻を経過";
      // エントリー時刻ちょうど通知（1回）
      if (!entryPlan.notified) {
        entryPlan.notified = true;
        notify("エントリー", `${entryPlan.side}（${entryPlan.pair}） 今エントリー推奨`);
      }
      // 10秒くらい表示残してからクリアしたいならここ調整
      if (ms < -10_000) entryPlan = null;
    }
  } else {
    entryCountdownEl.textContent = "--";
    entryPlanEl.textContent = "条件未成立";
  }

  // 開始3秒前に判定
  const preSignalMs = 3000;
  if (msLeft <= preSignalMs && msLeft > preSignalMs - 250) {
    const sig = decideSignal(pair, tfSec);
    renderSignal(sig);

    // HIGH/LOWのみ：通知＋エントリー予約
    if (sig.side === "HIGH" || sig.side === "LOW") {
      // C: 遅延最適化（枠ごと）
      const leadSec = pickBestLeadSec(sig.bucketKey, sig.side);
      const entryAtMs = boundary - leadSec * 1000;

      // 同じ10分枠は最大1回（勝率優先：連打防止）
      const alreadyPlanned = entryPlan && entryPlan.bucketKey === sig.bucketKey;
      if (!alreadyPlanned && entryAtMs > nowMs()) {
        entryPlan = {
          entryAtMs,
          side: sig.side,
          pair,
          tfSec,
          conf: sig.conf,
          reason: sig.reason,
          bucketKey: sig.bucketKey,
          leadSec,
          notified: false
        };
        notify("エントリー予約", `あと${Math.ceil((entryAtMs-nowMs())/1000)}秒：${sig.side}（${pair}）`);
      }
    }
  }
}

function start() {
  if (running) return;
  running = true;
  setStatus("稼働中");
  tick();
  timer = setInterval(tick, 200);
}
function stop() {
  running = false;
  setStatus("停止中");
  if (timer) clearInterval(timer);
  timer = null;
  countdownEl.textContent = "--";
}

/** ===== リセット ===== */
function resetAllLearn() {
  localStorage.removeItem(GUARD_KEY);
  localStorage.removeItem(DELAY_KEY);
  localStorage.removeItem(STATS_KEY);
  learnMeta.textContent = "状態: 未学習";
}

/** ===== 起動 ===== */
document.addEventListener("DOMContentLoaded", async () => {
  await registerSW();
  setupInstallButton();

  // 初期表示
  const pair = pairEl.value;
  const ticks = getTicks(pair);
  priceStatusEl.textContent = `価格データ: ${ticks.length}件（${pair}）`;
  learnMeta.textContent = `状態: ${guardStatusText()} / 遅延学習あり（母数>=10で反映）`;

  // 価格追加
  btnAddPriceEl.addEventListener("click", () => {
    const v = (priceInputEl.value || "").replace(/,/g, "").trim();
    const p = Number(v);
    if (!isFinite(p) || p <= 0) { alert("価格を数値で入力してください"); return; }
    addPriceTick(pairEl.value, p);
    priceInputEl.value = "";
  });

  // 通貨ペア切替で表示更新
  pairEl.addEventListener("change", () => {
    const t = getTicks(pairEl.value);
    priceStatusEl.textContent = `価格データ: ${t.length}件（${pairEl.value}）`;
  });

  // 通知
  el("btnPerm").addEventListener("click", async () => {
    const ok = await ensureNotificationPermission();
    alert(ok ? "通知を許可しました" : "通知が許可されませんでした");
  });
  el("btnTest").addEventListener("click", () => notify("テスト通知", "通知が動作しています。"));

  // 開始/停止
  el("btnStart").addEventListener("click", start);
  el("btnStop").addEventListener("click", stop);

  // 結果入力（案①）
  el("btnLearn").addEventListener("click", () => {
    if (!entryPlan) { alert("直近のエントリー予約がありません"); return; }
    const r = prompt("結果を入力（win / lose）");
    if (!r) return;
    const win = r.toLowerCase() === "win";
    const lose = r.toLowerCase() === "lose";
    if (!win && !lose) { alert("win か lose を入力してください"); return; }

    // 統計更新（10分枠×方向）
    updateStatsAfterResult(entryPlan.bucketKey, entryPlan.side, win);

    // B: ガード更新
    if ((guardModeEl?.value ?? "on") === "on") updateGuardAfterResult(win);

    // C: 遅延学習更新（0-3秒）
    updateDelayAfterResult(entryPlan.bucketKey, entryPlan.side, entryPlan.leadSec, win);

    learnMeta.textContent = `学習更新：${win ? "勝ち" : "負け"} / ${guardStatusText()}`;
    notify("学習反映", `${win ? "勝ち" : "負け"} を記録しました`);
  });

  el("btnReset").addEventListener("click", () => {
    resetAllLearn();
    notify("リセット", "学習データをリセットしました");
  });

  setStatus("待機中");
});
