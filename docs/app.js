"use strict";

const DAY = 864e5;
const S = { days: 365, tab: "sum", D: null };
const $ = (s) => document.querySelector(s);
const fmt = (v, d = 1) => (v == null || !isFinite(v) ? "–" : v.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d }));
const fdate = (t) => { const d = new Date(t); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* ---------- 데이터 준비 ---------- */

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function sd(a) { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); }
function rank(a, v) { return (a.filter((x) => x <= v).length / a.length) * 100; }
function since(rows, t0) { return rows.filter((r) => r.t >= t0); }
function lastOf(rows, f) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i][f] != null) return rows[i]; return null; }

function prep(raw) {
  const gdp = raw.meta?.gdp || {};
  const gy = Object.keys(gdp).map(Number).sort((a, b) => a - b);
  const gdpFor = (y) => { let v = null; for (const k of gy) if (k <= y) v = gdp[k]; return v; };

  const dep = (raw.deposits || []).map((r) => ({ ...r, t: Date.parse(r.d) })).sort((a, b) => a.t - b.t);
  const mk = (raw.market || []).map((r) => ({ ...r, t: Date.parse(r.d) })).sort((a, b) => a.t - b.t);

  let j = 0, cur = null;
  const win = [];
  for (const r of mk) {
    const cap = (r.cap_k || 0) + (r.cap_q || 0);
    const g = gdpFor(+r.d.slice(0, 4));
    r.buf = cap && g ? (cap / g) * 100 : null;
    r.trd = r.trd_k != null ? r.trd_k + (r.trd_q || 0) : null;
    if (r.trd != null) { win.push(r.trd); if (win.length > 20) win.shift(); }
    r.trd20 = win.length >= 5 ? mean(win) : null;
    while (j < dep.length && dep[j].t <= r.t) cur = dep[j++];
    r.dep = cur && r.t - cur.t < 7 * DAY ? cur.deposit : null;
    r.turn = r.trd20 != null && r.dep ? (r.trd20 / r.dep) * 100 : null;
  }

  const ipo = (raw.ipo || []).map((r) => ({ ...r, t: Date.parse(r.d) })).sort((a, b) => b.t - a.t);
  const retail = (raw.retail || []).map((r) => ({ ...r, t: Date.parse(r.m + "-15") })).sort((a, b) => a.t - b.t);
  return { mk, dep, ipo, retail, meta: raw.meta || {}, rules: raw.meta?.rules || {}, gdp };
}

/* ---------- 판정 ---------- */

function bandOf(rows, f, years = 10) {
  const last = rows[rows.length - 1];
  if (!last) return null;
  const xs = since(rows, last.t - years * 365.25 * DAY).map((r) => r[f]).filter((v) => v != null);
  if (xs.length < 60) return null;
  const m = mean(xs), s = sd(xs);
  return { m, lo: m - s, hi: m + s };
}

function signals(D) {
  const R = D.rules, out = [];
  const add = (o) => out.push(o);
  const mk = D.mk, endT = mk.length ? mk[mk.length - 1].t : Date.now();

  for (const [f, name] of [["per", "코스피 PER"], ["pbr", "코스피 PBR"]]) {
    const r = lastOf(mk, f), b = bandOf(mk, f);
    if (!r || !b) { add({ name, s: "none", val: "–", why: "데이터 수집 대기", go: "val" }); continue; }
    const v = r[f];
    add({ name, val: fmt(v, 2) + "배", s: v > b.hi ? "hot" : v < b.lo ? "cold" : "mid",
      why: `10년 평균 ${fmt(b.m, 2)}배, 보통 범위 ${fmt(b.lo, 2)}~${fmt(b.hi, 2)}배`, go: "val" });
  }

  {
    const r = lastOf(mk, "buf");
    const hotAt = R.buffett_hot ?? 120;
    if (!r) add({ name: "버핏지수", s: "none", val: "–", why: "config.json에 그해 GDP가 있어야 계산됩니다", go: "val" });
    else add({ name: "버핏지수", val: fmt(r.buf, 0) + "%", s: r.buf > hotAt ? "hot" : r.buf < 80 ? "cold" : "mid",
      why: `과열 기준 ${hotAt}%`, go: "val" });
  }

  {
    const r = lastOf(D.dep, "credit");
    if (!r) add({ name: "신용거래융자 잔고", s: "none", val: "–", why: "데이터 수집 대기", go: "flow" });
    else {
      const yr = since(D.dep, r.t - 365 * DAY).map((x) => x.credit).filter((v) => v != null);
      const hi = Math.max(...yr), pct = (r.credit / hi) * 100;
      const k = lastOf(mk, "kospi"), k60 = mk.filter((x) => x.t <= (k ? k.t : 0) - 60 * DAY).pop();
      const rising = k && k60 ? k.kospi > k60.kospi : false;
      const s = pct >= (R.credit_near_high ?? 95) && rising ? "hot" : pct <= (R.credit_cold ?? 75) ? "cold" : "mid";
      add({ name: "신용거래융자 잔고", val: fmt(r.credit, 1) + "조", s,
        why: `1년 최고치(${fmt(hi, 1)}조)의 ${fmt(pct, 0)}%, 코스피 3개월 ${rising ? "상승" : "하락"} 중`
          + (r.credit_kosdaq ? `, 코스닥 비중 ${fmt((r.credit_kosdaq / r.credit) * 100, 0)}%` : ""), go: "flow" });
    }
  }

  {
    const r = lastOf(D.dep, "deposit");
    if (!r) add({ name: "투자자예탁금", s: "none", val: "–", why: "데이터 수집 대기", go: "flow" });
    else {
      const idx = D.dep.indexOf(r), base = D.dep[Math.max(0, idx - 20)];
      const ch = base ? (r.deposit / base.deposit - 1) * 100 : 0;
      const yr = since(D.dep, r.t - 365 * DAY).map((x) => x.deposit);
      const surge = R.deposit_surge ?? 15;
      add({ name: "투자자예탁금", val: fmt(r.deposit, 1) + "조", s: ch >= surge ? "hot" : ch <= -surge ? "cold" : "mid",
        why: `한 달(20영업일) ${ch >= 0 ? "+" : ""}${fmt(ch, 1)}%, 1년 최고 ${fmt(Math.max(...yr), 1)}조`, go: "flow" });
    }
  }

  {
    const r = lastOf(mk, "turn");
    if (!r) add({ name: "예탁금 회전율", s: "none", val: "–", why: "거래대금과 예탁금이 모두 있어야 계산됩니다", go: "flow" });
    else {
      const yr = since(mk, r.t - 365 * DAY).map((x) => x.turn).filter((v) => v != null);
      const p = rank(yr, r.turn);
      add({ name: "예탁금 회전율", val: fmt(r.turn, 1) + "%", s: p >= (R.turnover_rank_hot ?? 90) ? "hot" : p <= (R.turnover_rank_cold ?? 30) ? "cold" : "mid",
        why: `최근 1년 중 상위 ${fmt(100 - p, 0)}% 수준`, go: "flow" });
    }
  }

  {
    const recent = D.ipo.filter((r) => r.t >= endT - 60 * DAY);
    const withComp = recent.filter((r) => r.comp != null), withOpen = recent.filter((r) => r.open_pct != null);
    if (!recent.length) add({ name: "공모주 청약 열기", s: "none", val: "–", why: "최근 60일 신규상장 없음", go: "mood" });
    else {
      const share = withComp.length ? (withComp.filter((r) => r.comp >= 1000).length / withComp.length) * 100 : null;
      const open = withOpen.length ? mean(withOpen.map((r) => r.open_pct)) : null;
      const hot = (share != null && share >= (R.ipo_hot_share ?? 50)) || (open != null && open >= (R.ipo_hot_open ?? 100));
      const cold = share != null && share < (R.ipo_cold_share ?? 20) && (open == null || open < 20);
      add({ name: "공모주 청약 열기", val: share == null ? "–" : fmt(share, 0) + "%", s: hot ? "hot" : cold ? "cold" : "mid",
        why: `최근 60일 ${recent.length}곳 중 1000:1 이상 비중, 시초가 평균 ${open == null ? "–" : (open >= 0 ? "+" : "") + fmt(open, 0) + "%"}`, go: "mood" });
    }
  }

  {
    const r = lastOf(D.retail, "kosdaq");
    if (!r) add({ name: "코스닥 개인 비중", s: "none", val: "–", why: "데이터 수집 대기", go: "mood" });
    else {
      const xs = since(D.retail, r.t - 3 * 365 * DAY).map((x) => x.kosdaq).filter((v) => v != null);
      const p = rank(xs, r.kosdaq);
      add({ name: "코스닥 개인 비중", val: fmt(r.kosdaq, 1) + "%", s: p >= (R.retail_rank_hot ?? 80) ? "hot" : p <= (R.retail_rank_cold ?? 20) ? "cold" : "mid",
        why: `${r.m} 기준, 최근 3년 중 상위 ${fmt(100 - p, 0)}%`, go: "mood" });
    }
  }
  return out;
}

/* ---------- 차트 ---------- */

const tip = $("#tip");
function showTip(x, y, html) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let l = x + 14; if (l + w > innerWidth - 8) l = x - 14 - w; if (l < 8) l = 8;
  let t = y - h - 12; if (t < 8) t = y + 16;
  tip.style.left = l + "px"; tip.style.top = t + "px";
}
function hideTip() { tip.hidden = true; }

function thin(pts, max = 400) {
  if (pts.length <= max) return pts;
  const step = Math.ceil(pts.length / max), out = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || Math.abs(hi) || 1, raw = span / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * p).find((s) => span / s <= n) || 10 * p;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, ts = [];
  for (let v = a; v <= b + step / 2; v += step) ts.push(+v.toFixed(10));
  return ts;
}

function measure(svg, s) {
  const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
  t.setAttribute("class", "ax"); t.textContent = s; svg.appendChild(t);
  const w = t.getComputedTextLength(); t.remove(); return w;
}

/** series: [{name, color, pts:[{t,v}], bars?:true, axis?:'r'}] */
function chart(el, { series, yFmt, tFmt, band, refs = [], h = 200, rFmt }) {
  el.innerHTML = "";
  const S0 = series.map((s) => ({ ...s, pts: s.bars ? s.pts : thin(s.pts) })).filter((s) => s.pts.length);
  const left = S0.filter((s) => s.axis !== "r"), right = S0.filter((s) => s.axis === "r");
  const allL = left.flatMap((s) => s.pts.map((p) => p.v));
  if (!S0.length || S0.reduce((n, s) => n + s.pts.length, 0) < 2) { el.innerHTML = '<p class="empty">이 기간에 표시할 데이터가 없습니다.</p>'; return; }

  const W = Math.max(280, el.clientWidth), H = h;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (S0.length > 1) {
    const lg = document.createElement("div"); lg.className = "legend";
    lg.innerHTML = S0.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}${s.axis === "r" ? " (오른쪽 축)" : ""}</span>`).join("");
    el.appendChild(lg);
  }
  el.appendChild(svg);

  let lo = Math.min(...allL), hi = Math.max(...allL);
  if (band) { lo = Math.min(lo, band.lo); hi = Math.max(hi, band.hi); }
  refs.forEach((r) => { lo = Math.min(lo, r.v); hi = Math.max(hi, r.v); });
  if (left.some((s) => s.bars)) lo = Math.min(0, lo);
  const pad = (hi - lo) * 0.06; if (!left.some((s) => s.bars)) lo -= pad; hi += pad;
  const ticks = niceTicks(Math.max(lo, left.some((s) => s.bars) ? 0 : -Infinity), hi);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];

  let rt = null, ry0, ry1;
  if (right.length) {
    const vs = right.flatMap((s) => s.pts.map((p) => p.v));
    rt = niceTicks(Math.min(0, ...vs), Math.max(...vs)); ry0 = rt[0]; ry1 = rt[rt.length - 1];
  }
  const ml = Math.max(...ticks.map((t) => measure(svg, yFmt(t)))) + 8;
  const mr = rt ? Math.max(...rt.map((t) => measure(svg, rFmt(t)))) + 8 : 6;
  const mt = 8, mb = 22;
  const ts = S0.flatMap((s) => s.pts.map((p) => p.t));
  let t0 = Math.min(...ts), t1 = Math.max(...ts);
  const barSeries = S0.some((s) => s.bars);
  if (barSeries) { t0 -= 16 * DAY; t1 += 16 * DAY; }
  if (t1 === t0) { t0 -= DAY; t1 += DAY; }
  const X = (t) => ml + ((t - t0) / (t1 - t0)) * (W - ml - mr);
  const Y = (v) => mt + (1 - (v - y0) / (y1 - y0)) * (H - mt - mb);
  const YR = (v) => mt + (1 - (v - ry0) / (ry1 - ry0)) * (H - mt - mb);
  let g = "";

  if (band) g += `<rect class="bandr" x="${ml}" width="${W - ml - mr}" y="${Y(band.hi)}" height="${Math.max(0, Y(band.lo) - Y(band.hi))}"/>`;
  ticks.forEach((t) => { g += `<line class="grid" x1="${ml}" x2="${W - mr}" y1="${Y(t)}" y2="${Y(t)}"/><text class="ax" x="${ml - 6}" y="${Y(t)}" dy="0.32em" text-anchor="end">${esc(yFmt(t))}</text>`; });
  if (rt) rt.forEach((t) => { g += `<text class="ax" x="${W - mr + 6}" y="${YR(t)}" dy="0.32em">${esc(rFmt(t))}</text>`; });

  const spanY = (t1 - t0) / (365 * DAY);
  const xt = [];
  const d0 = new Date(t0);
  const stepM = spanY > 6 ? 24 : spanY > 2.5 ? 12 : spanY > 1.2 ? 6 : spanY > 0.5 ? 3 : 1;
  let cur = new Date(d0.getFullYear(), Math.ceil((d0.getMonth() + (d0.getDate() > 1 ? 1 : 0)) / stepM) * stepM, 1);
  while (cur.getTime() <= t1) { xt.push(cur.getTime()); cur = new Date(cur.getFullYear(), cur.getMonth() + stepM, 1); }
  const maxTicks = Math.max(2, Math.floor((W - ml - mr) / 64));
  xt.filter((_, i) => i % Math.ceil(xt.length / maxTicks) === 0).forEach((t) => {
    const d = new Date(t);
    const lab = stepM >= 12 ? `${d.getFullYear()}` : `${String(d.getFullYear()).slice(2)}.${String(d.getMonth() + 1).padStart(2, "0")}`;
    g += `<text class="ax" x="${X(t)}" y="${H - 6}" text-anchor="middle">${lab}</text>`;
  });
  g += `<line class="grid" x1="${ml}" x2="${W - mr}" y1="${H - mb}" y2="${H - mb}"/>`;

  refs.forEach((r) => { g += `<line class="ref" x1="${ml}" x2="${W - mr}" y1="${Y(r.v)}" y2="${Y(r.v)}"/><text class="ax" x="${W - mr}" y="${Y(r.v) - 5}" text-anchor="end">${esc(r.label)}</text>`; });

  S0.forEach((s) => {
    const yy = s.axis === "r" ? YR : Y;
    if (s.bars) {
      const n = s.pts.length, bw = Math.min(26, ((W - ml - mr) / Math.max(n, 1)) * 0.6);
      s.pts.forEach((p) => { g += `<rect x="${X(p.t) - bw / 2}" y="${yy(p.v)}" width="${bw}" height="${Math.max(0, yy(Math.max(y0, 0)) - yy(p.v))}" rx="3" fill="${s.color}" opacity=".85"/>`; });
    } else {
      const d = s.pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${yy(p.v).toFixed(1)}`).join("");
      g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      if (s.pts.length < 40) s.pts.forEach((p) => { g += `<circle cx="${X(p.t)}" cy="${yy(p.v)}" r="2.5" fill="${s.color}"/>`; });
    }
  });
  g += `<line class="cursor" id="cur" y1="${mt}" y2="${H - mb}" visibility="hidden"/>`;
  svg.innerHTML = g;

  const curEl = svg.querySelector("#cur");
  const onMove = (ev) => {
    const r = svg.getBoundingClientRect(), k = W / r.width;
    const px = (ev.clientX - r.left) * k;
    let bestT = null, bd = Infinity;
    S0.forEach((s) => s.pts.forEach((p) => { const d = Math.abs(X(p.t) - px); if (d < bd) { bd = d; bestT = p.t; } }));
    if (bestT == null) return;
    curEl.setAttribute("x1", X(bestT)); curEl.setAttribute("x2", X(bestT)); curEl.setAttribute("visibility", "visible");
    const near = (s) => s.pts.reduce((a, p) => (Math.abs(p.t - bestT) < Math.abs(a.t - bestT) ? p : a));
    const lines = S0.map((s) => { const p = near(s); return Math.abs(p.t - bestT) < 20 * DAY ? `<div>${S0.length > 1 ? `<i style="background:${s.color}"></i>${esc(s.name)} ` : ""}${esc((s.tFmt || tFmt)(p.v))}</div>` : ""; }).join("");
    const label = barSeries ? fdate(bestT).slice(0, 7) : fdate(bestT);
    showTip(ev.clientX, ev.clientY, `<div class="d">${label}</div>${lines}`);
  };
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerdown", onMove);
  svg.addEventListener("pointerleave", () => { hideTip(); curEl.setAttribute("visibility", "hidden"); });
}


/* ---------- 차트 아래 최근 수치 표 ---------- */

const WD = ["일", "월", "화", "수", "목", "금", "토"];
function dayLabel(r) {
  if (r.m) return `${r.m.slice(2, 4)}년 ${+r.m.slice(5)}월`;
  const d = new Date(r.t);
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
}

/** cols: [{label, f, dec, unit, chg}] — chg가 있는 열은 바로 앞 행 대비 변화도 보여 줍니다. */
function recent(chartId, rows, cols, { n = 7, title = "최근 7영업일" } = {}) {
  const chartEl = document.getElementById(chartId);
  let box = chartEl.nextElementSibling;
  if (!box || !box.classList.contains("recent")) {
    box = document.createElement("div"); box.className = "recent";
    chartEl.after(box);
  }
  const xs = rows.filter((r) => r[cols[0].f] != null);
  const body = [];
  for (let k = xs.length - 1; k >= Math.max(0, xs.length - n); k--) {
    const r = xs[k], prev = xs[k - 1];
    const cells = cols.map((c) => {
      const v = r[c.f];
      let h = `<td class="n">${v == null ? "–" : fmt(v, c.dec) + (c.unit || "")}</td>`;
      if (c.chg) {
        const pv = prev ? prev[c.f] : null;
        if (v == null || pv == null) h += '<td class="n">–</td>';
        else {
          const dv = v - pv, cu = c.unit === "%" ? "%p" : (c.unit || "");
          const cls = Math.abs(dv) < 10 ** -(c.dec + 1) ? "" : dv > 0 ? "up" : "down";
          h += `<td class="n ${cls}">${dv > 0 ? "+" : ""}${fmt(dv, c.dec)}${cu}</td>`;
        }
      }
      return h;
    }).join("");
    body.push(`<tr><td>${dayLabel(r)}</td>${cells}</tr>`);
  }
  if (!body.length) { box.innerHTML = ""; return; }
  const head = cols.map((c) => `<th class="n">${esc(c.label)}</th>${c.chg ? '<th class="n">전일 대비</th>' : ""}`).join("");
  const chgLabel = rows.length && rows[0].m ? "전월 대비" : "전일 대비";
  box.innerHTML = `<p class="recent-t">${esc(title)}</p><div class="tbl-wrap"><table class="tbl tbl-s"><thead><tr><th>${rows.length && rows[0].m ? "월" : "날짜"}</th>${head.replaceAll("전일 대비", chgLabel)}</tr></thead><tbody>${body.join("")}</tbody></table></div>`;
}

/* ---------- 화면 ---------- */

const STATE_TXT = { hot: "과열", cold: "냉각", mid: "중립", none: "대기" };

function renderHero(sig) {
  const valid = sig.filter((s) => s.s !== "none"), hot = sig.filter((s) => s.s === "hot");
  $("#hot-n").textContent = valid.length ? hot.length : "–";
  $("#all-n").textContent = valid.length || "–";
  $("#strip").innerHTML = sig.map((s) => `<span data-s="${s.s}" title="${esc(s.name)}: ${STATE_TXT[s.s]}"></span>`).join("");
  $("#strip").setAttribute("aria-label", sig.map((s) => `${s.name} ${STATE_TXT[s.s]}`).join(", "));
  const cold = sig.filter((s) => s.s === "cold");
  $("#hero-note").innerHTML = !valid.length ? "첫 수집이 끝나면 지표가 채워집니다."
    : (hot.length ? `과열: <b>${hot.map((s) => esc(s.name)).join(", ")}</b>. ` : "과열 신호가 켜진 지표가 없습니다. ")
      + (cold.length ? `냉각: ${cold.map((s) => esc(s.name)).join(", ")}.` : "");
}

function renderSignals(sig) {
  $("#signals").innerHTML = sig.map((s) => `
    <li data-s="${s.s}" data-go="${s.go}" tabindex="0" role="button" aria-label="${esc(s.name)} 추세 보기">
      <span class="bar"></span><span class="name">${esc(s.name)}</span><span class="val">${esc(s.val)}</span>
      <span class="why">${esc(s.why)}</span><span class="state">${STATE_TXT[s.s]}</span>
    </li>`).join("");
  document.querySelectorAll("#signals li").forEach((li) => {
    const go = () => setTab(li.dataset.go);
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

function renderCharts() {
  const D = S.D; if (!D) return;
  const c1 = css("--s1"), c2 = css("--s2"), hot = css("--hot"), cold = css("--cold");
  const end = Math.max(D.mk.length ? D.mk[D.mk.length - 1].t : 0, D.dep.length ? D.dep[D.dep.length - 1].t : 0) || Date.now();
  const t0 = end - S.days * DAY;
  const P = (rows, f) => rows.filter((r) => r.t >= t0 && r[f] != null).map((r) => ({ t: r.t, v: r[f] }));
  const f0 = (v) => fmt(v, 0), f1 = (v) => fmt(v, 1), f2 = (v) => fmt(v, 2);

  if (S.tab === "val") {
    chart($("#ch-kospi"), { series: [{ name: "코스피", color: c1, pts: P(D.mk, "kospi") }], yFmt: f0, tFmt: f2 });
    chart($("#ch-per"), { series: [{ name: "PER", color: c1, pts: P(D.mk, "per") }], band: bandOf(D.mk, "per"), yFmt: f0, tFmt: (v) => fmt(v, 2) + "배" });
    chart($("#ch-pbr"), { series: [{ name: "PBR", color: c1, pts: P(D.mk, "pbr") }], band: bandOf(D.mk, "pbr"), yFmt: f1, tFmt: (v) => fmt(v, 2) + "배" });
    const hb = D.rules.buffett_hot ?? 120;
    chart($("#ch-buf"), { series: [{ name: "버핏지수", color: c1, pts: P(D.mk, "buf") }], refs: [{ v: hb, label: `과열 ${hb}%` }], yFmt: (v) => f0(v) + "%", tFmt: (v) => fmt(v, 1) + "%" });
    recent("ch-kospi", D.mk, [{ label: "종가", f: "kospi", dec: 2, chg: true }]);
    recent("ch-per", D.mk, [{ label: "PER", f: "per", dec: 2, unit: "배", chg: true }]);
    recent("ch-pbr", D.mk, [{ label: "PBR", f: "pbr", dec: 2, unit: "배", chg: true }]);
    recent("ch-buf", D.mk, [{ label: "버핏지수", f: "buf", dec: 1, unit: "%", chg: true }]);
  }
  if (S.tab === "flow") {
    chart($("#ch-credit"), { series: [{ name: "전체", color: hot, pts: P(D.dep, "credit") }, { name: "코스닥", color: c2, pts: P(D.dep, "credit_kosdaq") }], yFmt: f0, tFmt: (v) => fmt(v, 2) + "조" });
    chart($("#ch-dep"), { series: [{ name: "예탁금", color: cold, pts: P(D.dep, "deposit") }], yFmt: f0, tFmt: (v) => fmt(v, 2) + "조" });
    chart($("#ch-turn"), { series: [{ name: "회전율", color: c1, pts: P(D.mk, "turn") }], yFmt: (v) => f0(v) + "%", tFmt: (v) => fmt(v, 1) + "%" });
    chart($("#ch-trd"), { series: [{ name: "거래대금", color: c2, pts: P(D.mk, "trd20") }], yFmt: f0, tFmt: (v) => fmt(v, 1) + "조" });
    recent("ch-credit", D.dep, [{ label: "전체", f: "credit", dec: 2, unit: "조", chg: true }, { label: "코스닥", f: "credit_kosdaq", dec: 2, unit: "조" }]);
    recent("ch-dep", D.dep, [{ label: "예탁금", f: "deposit", dec: 2, unit: "조", chg: true }]);
    recent("ch-turn", D.mk, [{ label: "회전율", f: "turn", dec: 1, unit: "%", chg: true }]);
    recent("ch-trd", D.mk, [{ label: "당일", f: "trd", dec: 1, unit: "조", chg: true }, { label: "20일 평균", f: "trd20", dec: 1, unit: "조" }]);
  }
  if (S.tab === "mood") {
    chart($("#ch-retail"), {
      series: [{ name: "코스닥", color: c2, pts: P(D.retail, "kosdaq") }, { name: "코스피", color: c1, pts: P(D.retail, "kospi") }],
      yFmt: f0, tFmt: (v) => fmt(v, 1) + "%",
    });
    recent("ch-retail", D.retail, [{ label: "코스닥", f: "kosdaq", dec: 1, unit: "%", chg: true }, { label: "코스피", f: "kospi", dec: 1, unit: "%" }], { n: 6, title: "최근 6개월" });
    const by = {};
    D.ipo.filter((r) => r.t >= t0).forEach((r) => {
      const m = r.d.slice(0, 7), a = (by[m] ||= { c: [], o: [] });
      if (r.comp != null) a.c.push(r.comp); if (r.open_pct != null) a.o.push(r.open_pct);
    });
    const months = Object.keys(by).sort();
    const tm = (m) => Date.parse(m + "-15");
    chart($("#ch-ipo"), {
      series: [
        { name: "1000:1 이상", color: c2, bars: true, pts: months.filter((m) => by[m].c.length).map((m) => ({ t: tm(m), v: (by[m].c.filter((x) => x >= 1000).length / by[m].c.length) * 100 })) },
        { name: "시초가 평균", color: c1, axis: "r", pts: months.filter((m) => by[m].o.length).map((m) => ({ t: tm(m), v: mean(by[m].o) })), tFmt: (v) => (v >= 0 ? "+" : "") + fmt(v, 0) + "%" },
      ],
      yFmt: (v) => f0(v) + "%", rFmt: (v) => f0(v) + "%", tFmt: (v) => fmt(v, 0) + "%",
    });
    const pc = (v) => (v == null ? "–" : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${fmt(v, 1)}</span>`);
    $("#ipo-rows").innerHTML = D.ipo.slice(0, 20).map((r) => `<tr><td>${esc(r.name)}</td><td>${r.d.slice(5).replace("-", "/")}</td><td class="n">${r.comp == null ? "–" : fmt(r.comp, 0)}</td><td class="n">${pc(r.open_pct)}</td><td class="n">${pc(r.close_pct)}</td></tr>`).join("")
      || '<tr><td colspan="5">수집된 상장 내역이 없습니다.</td></tr>';
  }
}

function renderRules(D) {
  const R = D.rules;
  $("#rules").innerHTML = `<dl>
    <dt>PER·PBR</dt><dd>최근 10년 평균 ±1 표준편차를 넘으면 과열, 밑돌면 냉각.</dd>
    <dt>버핏지수</dt><dd>${R.buffett_hot ?? 120}% 초과면 과열. 명목 GDP는 config.json의 연도별 값을 씁니다(현재 ${Object.keys(D.gdp).join(", ") || "없음"}년).</dd>
    <dt>신용거래융자 잔고</dt><dd>1년 최고치의 ${R.credit_near_high ?? 95}% 이상이고 코스피가 3개월 전보다 높으면 과열, ${R.credit_cold ?? 75}% 이하면 냉각.</dd>
    <dt>투자자예탁금</dt><dd>20영업일 사이 ${R.deposit_surge ?? 15}% 이상 늘면 과열(급증), 그만큼 줄면 냉각.</dd>
    <dt>예탁금 회전율</dt><dd>최근 1년 분포에서 상위 ${100 - (R.turnover_rank_hot ?? 90)}% 안이면 과열, 하위 ${R.turnover_rank_cold ?? 30}% 안이면 냉각.</dd>
    <dt>공모주 청약 열기</dt><dd>최근 60일 상장 중 경쟁률 1000:1 이상 비중이 ${R.ipo_hot_share ?? 50}% 이상이거나 시초가 평균이 +${R.ipo_hot_open ?? 100}% 이상이면 과열.</dd>
    <dt>코스닥 개인 비중</dt><dd>최근 3년 월별 분포에서 상위 ${100 - (R.retail_rank_hot ?? 80)}% 안이면 과열.</dd>
  </dl>`;
}

function renderMeta(meta) {
  const u = meta.updated ? new Date(meta.updated) : null;
  $("#stamp").textContent = u ? `${fdate(u.getTime())} ${String(u.getHours()).padStart(2, "0")}:${String(u.getMinutes()).padStart(2, "0")} 데이터 수집` : "";
  const n = $("#notice");
  if (meta.errors && meta.errors.length) {
    n.hidden = false;
    n.innerHTML = `최근 수집에서 실패한 출처가 있어 일부 지표가 이전 값입니다: ${meta.errors.map((e) => `<b>${esc(e.source)}</b>`).join(", ")}. GitHub 저장소의 Actions 탭에서 실행 기록을 확인하세요.`;
  } else n.hidden = true;
}

const TABS = ["sum", "val", "flow", "mood"];

function setTab(t, dir = 0) {
  S.tab = t;
  document.querySelectorAll(".tab").forEach((s) => {
    s.hidden = s.dataset.tab !== t;
    s.classList.remove("in-l", "in-r");
    if (!s.hidden && dir) { void s.offsetWidth; s.classList.add(dir > 0 ? "in-r" : "in-l"); }
  });
  document.querySelectorAll(".tabbar button").forEach((b) => (b.getAttribute("data-t") === t ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  $(".period").hidden = t === "sum";
  hideTip();
  renderCharts();
  window.scrollTo({ top: t === "sum" ? 0 : $(".period").offsetTop - 12 });
}

/* 좌우로 밀어서 탭 이동. 차트 위에서는 값 보기와 겹치지 않게 빠르게 튕길 때만 넘어갑니다. */
(function swipe() {
  let x0 = null, y0 = 0, t0 = 0, onChart = false;
  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { x0 = null; return; }
    const el = e.target;
    const wide = el.closest(".tbl-wrap");
    if (el.closest(".tabbar, .period, summary") || (wide && wide.scrollWidth > wide.clientWidth + 2)) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
    onChart = !!el.closest(".chart");
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const p = e.changedTouches[0], dx = p.clientX - x0, dy = p.clientY - y0, dt = Date.now() - t0;
    x0 = null;
    const minDx = onChart ? 80 : 60, maxDt = onChart ? 350 : 800;
    if (Math.abs(dx) < minDx || Math.abs(dx) < Math.abs(dy) * 1.5 || dt > maxDt) return;
    const i = TABS.indexOf(S.tab), j = dx < 0 ? i + 1 : i - 1;
    if (j < 0 || j >= TABS.length) return;
    setTab(TABS[j], dx < 0 ? 1 : -1);
  }, { passive: true });
})();

document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.t)));
document.querySelectorAll(".period button").forEach((b) => b.addEventListener("click", () => {
  S.days = +b.dataset.p;
  document.querySelectorAll(".period button").forEach((x) => x.setAttribute("aria-pressed", x === b));
  renderCharts();
}));
let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(renderCharts, 150); });
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", renderCharts);
document.addEventListener("scroll", hideTip, { passive: true });

async function load() {
  try {
    const r = await fetch("data/data.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const D = prep(await r.json());
    S.D = D;
    const sig = signals(D);
    renderMeta(D.meta); renderHero(sig); renderSignals(sig); renderRules(D);
    setTab(S.tab);
  } catch (e) {
    $("#stamp").textContent = "";
    $("#hero-note").textContent = "아직 수집된 데이터가 없습니다. GitHub 저장소의 Actions 탭에서 ‘과열 지표 수집’을 한 번 실행하세요.";
    $(".period").hidden = true;
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
load();
