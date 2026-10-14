import * as E from "./engine.js";

// ---------- State ----------
const $ = id => document.getElementById(id);
const W = E.DEFAULTS, SCALE = E.SCALE_DEFAULT;   // fixed: everyone sees the same ratings
let BASE = null;            // season calibration from /api/baseline
let SCHED = null;           // { date, today, games } for the day being viewed
const GAMES = new Map();    // game id -> game data from /api/game
let RATED = {}, CALS = null, calSource = "season";
let viewDate = null, current = null, mapFilter = "all", gameTab = "ratings", bestAll = false;
const open = new Set();
let lastUpdated = null, pollTimer = null;
let view = "scores", PLAYER = null, playerTab = "profile";
let CONTRACTS = null;
const PREVIEWS = new Map();  // game id -> { data } | { error } from /api/preview

const STARTED = ["LIVE", "CRIT", "OFF", "FINAL"];
const started = st => STARTED.includes(st);
const live = st => st === "LIVE" || st === "CRIT";
const done = st => st === "OFF" || st === "FINAL";

async function api(path){
  const r = await fetch(path);
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
const shiftDate = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0,10); };
const dayName = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday:"long", month:"short", day:"numeric", timeZone:"UTC" });
const shortDay = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric", timeZone:"UTC" });
const tinyDay = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month:"short", day:"numeric", timeZone:"UTC" });
const localTime = iso => new Date(iso).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" });
const prdName = p => p == null ? "" : p <= 3 ? ["1st","2nd","3rd"][p-1] : p === 4 ? "OT" : "SO";
const statusText = g => {
  if(live(g.st)) return g.inter ? `${prdName(g.prd)} intermission` : `${prdName(g.prd)} · ${g.clk || ""}`;
  if(done(g.st)) return g.end === "OT" ? "Final/OT" : g.end === "SO" ? "Final/SO" : "Final";
  if(g.st === "PRE") return "Pregame";
  if(g.st === "PPD") return "Postponed";
  return g.start ? localTime(g.start) : "Scheduled";
};

// ---------- Formatting ----------
const sign = v => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2);
const band = r => r == null ? "na" : r >= 8 ? "elite" : r >= 7 ? "good" : r >= 6 ? "mid" : "low";
const fmt = r => r == null ? "–" : r.toFixed(1);
const pctTxt = v => v == null ? "–" : Math.round(v*100) + "%";
const ord = p => { const v = p*100; return v >= 99.95 ? "99.9" : v >= 99 ? v.toFixed(1) : String(Math.round(v)); };
const topPct = p => { const t = (1-p)*100; return t < 0.1 ? "0.1%" : t < 1 ? t.toFixed(1) + "%" : Math.round(t) + "%"; };
const GRP_NAME = { F:"forward", D:"defenseman", G:"goalie" };
const POS_NAME = { C:"Center", L:"Left wing", R:"Right wing", D:"Defense", G:"Goalie" };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
const initials = n => { const parts = String(n).replace(/\./g, " ").trim().split(/\s+/); return esc(((parts[0]||"")[0] + ((parts[parts.length-1]||"")[0]||"")).toUpperCase()); };
const clock = s => { const p = Math.floor(s/1200) + 1, r = s % 1200; return `${p > 3 ? "OT" : "P" + p} ${String(Math.floor(r/60)).padStart(2,"0")}:${String(r%60).padStart(2,"0")}`; };
const COUNTRIES = { CAN:"Canada", USA:"United States", SWE:"Sweden", FIN:"Finland", RUS:"Russia", CZE:"Czechia", SVK:"Slovakia", CHE:"Switzerland", DEU:"Germany", LVA:"Latvia", DNK:"Denmark", NOR:"Norway", AUT:"Austria", FRA:"France", SVN:"Slovenia", BLR:"Belarus", UKR:"Ukraine", KAZ:"Kazakhstan", AUS:"Australia", GBR:"United Kingdom", NLD:"Netherlands", ITA:"Italy", POL:"Poland", JPN:"Japan", KOR:"South Korea", BRA:"Brazil", HRV:"Croatia", LTU:"Lithuania", EST:"Estonia", HUN:"Hungary", BEL:"Belgium", ESP:"Spain", UZB:"Uzbekistan", JAM:"Jamaica", NGA:"Nigeria", ZAF:"South Africa", VEN:"Venezuela", TWN:"Taiwan", CHN:"China", IRL:"Ireland", SCO:"Scotland", ROU:"Romania", SRB:"Serbia", BGR:"Bulgaria", GHA:"Ghana", KEN:"Kenya", MEX:"Mexico", ARG:"Argentina" };

// Team logos from the NHL's own image server (light and dark versions)
const LOGO = "https://assets.nhle.com/logos/nhl/svg/";
const logo = (ab, cls = "") => ab ? `<picture class="tlogo${cls ? " " + cls : ""}"><source srcset="${LOGO}${esc(ab)}_dark.svg" media="(prefers-color-scheme: dark)"><img src="${LOGO}${esc(ab)}_light.svg" alt="" loading="lazy" onerror="this.parentNode.remove()"></picture>` : "";

// ---------- Ratings for the day ----------
function dayGames(){ return (SCHED?.games || []).map(s => GAMES.get(s.id)).filter(Boolean); }
function rateAll(){
  const games = dayGames(), scored = {};
  games.forEach(g => { scored[g.id] = E.scoreGame(g, W); });
  if(BASE && BASE.cal.F.n >= 50){ CALS = BASE.cal; calSource = "season"; }
  else {
    const pools = { F:[], D:[], G:[] };
    const pool = games.filter(g => done(g.st)).length ? games.filter(g => done(g.st)) : games;
    pool.forEach(g => scored[g.id].forEach(p => { if(p.raw == null) return; if(p.goalie ? p.toi >= E.MIN_TOI_G_BASE : p.toi >= E.MIN_TOI_SK) pools[E.grpOf(p.pos)].push(p.raw); }));
    CALS = pools.F.length ? { F:E.makeCal(pools.F), D:E.makeCal(pools.D.length ? pools.D : [0]), G:E.makeCal(pools.G.length ? pools.G : [0]) } : null;
    calSource = "page";
  }
  RATED = {};
  games.forEach(g => {
    RATED[g.id] = scored[g.id].map(p => {
      if(p.raw == null) return { ...p, rating:null, note:"Did not play." };
      if(!p.goalie && p.toi < E.MIN_TOI_SK) return { ...p, rating:null, note: done(g.st) ? `Only ${E.fmtToi(p.toi)} of ice time, so no rating is given.` : `Rated once he passes 5:00 of ice time (${E.fmtToi(p.toi)} so far).` };
      if(!CALS) return { ...p, rating:null, note:"Ratings appear once the season comparison loads." };
      const grp = E.grpOf(p.pos), c = E.calibrate(p.raw, CALS[grp], SCALE);
      return { ...p, grp, rating:c.rating, pct:c.pct, z:c.z };
    });
  });
}

// ---------- Shared bits ----------
function chip(r, isStar){ return `<span class="chip ${band(r)}" aria-label="Rating ${fmt(r)}">${fmt(r)}${isStar ? '<span class="star-mark" aria-hidden="true">★</span>' : ""}</span>`; }
function avatar(pl, size, isStar){ return `<span class="av${size ? " " + size : ""} side${pl.side}"><span class="face" aria-hidden="true">${initials(pl.name)}</span>${chip(pl.rating, isStar)}</span>`; }

// ---------- Scores: date bar + strip ----------
function gameChip(s){
  const R = RATED[s.id], g = GAMES.get(s.id);
  const best = R ? R.filter(p => p.rating != null).sort((a,b) => b.rating - a.rating)[0] : null;
  const sc = [s.t[0].sc, s.t[1].sc], has = started(s.st);
  const win = has && done(s.st) ? (sc[0] > sc[1] ? 0 : 1) : -1;
  const status = live(s.st) ? `<span class="live-tag"><i aria-hidden="true"></i>${esc(statusText(s))}</span>` : `<span>${esc(statusText(s))}</span>`;
  const tm = i => `<span class="tm">${logo(s.t[i].ab)}<span>${esc(s.t[i].ab)}</span><span class="tnm">${esc(s.t[i].nm)}</span></span>`;
  const right = best ? `<span>${esc(best.name.split(". ").pop())} <span class="chip ${band(best.rating)}">${fmt(best.rating)}</span></span>`
    : has && !g ? "<span>Loading…</span>" : !has && s.st !== "PPD" ? "<span>Preview</span>" : "";
  return `<button type="button" class="gchip${has ? "" : " future"}" data-g="${s.id}" aria-current="${s.id === current}">
    <span class="row${win === 1 ? " lost" : ""}">${tm(0)}<span class="sc">${has ? sc[0] ?? 0 : ""}</span></span>
    <span class="row${win === 0 ? " lost" : ""}">${tm(1)}<span class="sc">${has ? sc[1] ?? 0 : ""}</span></span>
    <span class="foot">${status}${right}</span>
  </button>`;
}
function renderStrip(){
  $("date-h").textContent = dayName(viewDate);
  const n = SCHED.games.length, strip = $("strip");
  // Fewer games get bigger cards: 1-2 extra large, 3-4 large, 5-8 medium, more than that compact
  strip.className = `strip n${Math.min(n, 9)} ${n <= 2 ? "xl" : n <= 4 ? "lg" : n <= 8 ? "md" : "sm"}${n > 4 ? " many" : ""}`;
  strip.innerHTML = n ? SCHED.games.map(gameChip).join("") : `<div class="muted" style="padding:8px 2px">No NHL games on this date.</div>`;
  $("next-day").disabled = viewDate >= shiftDate(SCHED.today, 1);
  $("today-btn").hidden = viewDate === SCHED.today;
  const anyLive = SCHED.games.some(g => live(g.st));
  $("updated").innerHTML = lastUpdated ? `${anyLive ? '<span class="live-tag"><i aria-hidden="true"></i>Live</span> · ' : ""}Updated ${lastUpdated.toLocaleTimeString([], { hour:"numeric", minute:"2-digit" })}` : "";
}
function renderBest(){
  const all = [];
  dayGames().forEach(g => (RATED[g.id] || []).forEach(p => { if(p.rating != null) all.push({ ...p, g }); }));
  $("best").hidden = !all.length;
  document.querySelector(".scores-grid").classList.toggle("solo", !all.length);
  if(!all.length) return;
  all.sort((a,b) => b.rating - a.rating || b.raw - a.raw);
  const nLive = dayGames().filter(g => live(g.st)).length;
  $("best-h").textContent = nLive ? "Best performances so far" : "Best performances";
  $("best-sub").textContent = `${tinyDay(viewDate)} · ${dayGames().length} game${dayGames().length === 1 ? "" : "s"}${nLive ? ` · ${nLive} live` : ""}`;
  const n = bestAll ? 10 : 5;
  $("best-list").innerHTML = all.slice(0, n).map((p,i) => {
    const opp = p.g.t[1-p.side].ab;
    return `<li><button type="button" data-g="${p.g.id}" data-p="${p.id}">
      <span class="rk">${i+1}</span>
      <span class="who"><b>${esc(p.name)}</b><span>${logo(p.g.t[p.side].ab)}${esc(p.g.t[p.side].ab)} ${p.side === 0 ? "at" : "vs"} ${esc(opp)} · ${esc(p.line)}</span></span>
      ${chip(p.rating)}</button></li>`;
  }).join("");
  $("best-more").hidden = all.length <= 5;
  $("best-more").textContent = bestAll ? "Show top 5" : "Show top 10";
}

// ---------- Scores: game detail ----------
function renderGame(){
  const host = $("game");
  const g = GAMES.get(current);
  const sch = (SCHED?.games || []).find(s => s.id === current);
  if(sch && !started(sch.st)){ host.innerHTML = pregameNotice() + previewCard(sch); return; }
  if(!g || !RATED[g.id]){
    if(current){ host.innerHTML = `<div class="card loading">Loading game…</div>`; return; }
    host.innerHTML = SCHED && !SCHED.games.length ? `<div class="card empty-card">No games on this date. Use the arrows to pick another day.</div>` : "";
    return;
  }
  const R = RATED[g.id];
  const [A, H] = g.t, fin = done(g.st), win = fin ? (A.sc > H.sc ? 0 : 1) : -1;
  const xg = side => g.s.filter(s => s[1] === side && s[2] !== "B").reduce((a,s) => a + s[6], 0) / 1000;
  const per = g.per.map(a => a.slice());
  if(fin && g.end !== "REG" && per[0].length === 3){ per[0].push(0); per[1].push(0); }
  const perHead = per[0].map((_,i) => i < 3 ? ["1st","2nd","3rd"][i] : "OT");
  const so = g.end === "SO" && fin;
  const status = fin ? (g.end === "REG" ? "FINAL" : g.end === "OT" ? "FINAL · OT" : "FINAL · SHOOTOUT")
    : `<span class="live-tag"><i aria-hidden="true"></i>LIVE · ${esc(statusText(g))}</span>`;
  const tabs = [["ratings","Player ratings"],["stats","Team stats"],["map","Shot map"],["goals",`Goals (${g.gl.length})`]];
  host.innerHTML = `<article class="card game">
    <div class="board">
      <div class="meta"><span>${esc(shortDay(g.d))}</span><span>${esc(g.v)}</span></div>
      <div class="score">
        <div class="team away">${logo(A.ab, "big")}<span class="abbr">${esc(A.ab)}</span><span class="nm">${esc(A.nm)}</span></div>
        <div><div class="final"><span class="${win === 1 ? "lose" : ""}">${A.sc}</span><span class="dash">–</span><span class="${win === 0 ? "lose" : ""}">${H.sc}</span></div><div class="status">${status}</div></div>
        <div class="team home">${logo(H.ab, "big")}<span class="abbr">${esc(H.ab)}</span><span class="nm">${esc(H.nm)}</span></div>
      </div>
      <div class="xg-line">Expected goals <b class="mono">${xg(0).toFixed(2)}</b> – <b class="mono">${xg(1).toFixed(2)}</b></div>
      <div class="periods"><table aria-label="Goals by period">
        <thead><tr><th></th>${perHead.map(h => `<th>${h}</th>`).join("")}${so ? "<th>SO</th>" : ""}<th>T</th><th>SOG</th></tr></thead>
        <tbody>${[0,1].map(s => `<tr><td>${esc(g.t[s].ab)}</td>${per[s].map(v => `<td>${v}</td>`).join("")}${so ? `<td>${s === win ? 1 : 0}</td>` : ""}<td class="tot">${g.t[s].sc}</td><td class="tot">${g.t[s].sog}</td></tr>`).join("")}</tbody>
      </table></div>
    </div>
    <div class="tabs" role="tablist">${tabs.map(([k,l]) => `<button type="button" role="tab" data-gtab="${k}" aria-selected="${gameTab === k}">${l}</button>`).join("")}</div>
    <div class="panel" role="tabpanel">${gameTab === "ratings" ? ratingsPanel(g, R, fin) : gameTab === "stats" ? statsPanel(g) : gameTab === "map" ? mapPanel() : goalsPanel(g)}</div>
  </article>`;
  if(gameTab === "map") drawMap();
}

// ---------- Pregame preview ----------
function pregameNotice(){
  const games = SCHED?.games || [];
  if(games.some(s => started(s.st))) return "";
  const upcoming = games.filter(s => s.st !== "PPD" && s.start).sort((a,b) => a.start.localeCompare(b.start));
  if(!upcoming.length) return "";
  const prev = viewDate <= SCHED.today ? `<button type="button" class="pill-btn" id="see-prev">See the previous night</button>` : "";
  return `<div class="card notice"><p>No games have started yet. First puck drop is at ${esc(localTime(upcoming[0].start))}, and ratings appear as soon as it begins.</p>${prev}</div>`;
}
async function loadPreview(id){
  if(PREVIEWS.has(id)) return;
  PREVIEWS.set(id, { loading:true });
  try { PREVIEWS.set(id, { data: await api(`/api/preview?id=${id}`) }); }
  catch(e){ PREVIEWS.set(id, { error: e.message || String(e) }); }
  if(current === id && view === "scores") renderGame();
}
const nth = n => { if(n == null) return ""; const v = n % 100; return n + (v >= 11 && v <= 13 ? "th" : ["th","st","nd","rd"][n % 10] || "th"); };
const pct1 = v => v == null ? "–" : (v*100).toFixed(1) + "%";
const svp = v => v == null ? "–" : v.toFixed(3).replace(/^0/, "");
const CAT = { points:"Points", goals:"Goals", assists:"Assists", plusMinus:"Plus/minus", shots:"Shots" };
function previewCard(s){
  const P = PREVIEWS.get(s.id);
  if(!P) loadPreview(s.id);
  const [A, H] = s.t, d = P?.data, T = d?.teams || [];
  const when = s.st === "PPD" ? "Postponed" : s.start ? localTime(s.start) : "TBD";
  const sub = s.st === "PRE" ? "Pregame" : s.start ? new Date(s.start).toLocaleDateString([], { weekday:"long", month:"short", day:"numeric" }) : "";
  const team = (i, cls) => `<div class="team ${cls}">${logo(s.t[i].ab, "big")}<span class="abbr">${esc(s.t[i].ab)}</span><span class="nm">${esc(T[i]?.nm || s.t[i].nm)}</span>${T[i]?.record ? `<span class="rec">${esc(T[i].record)}${T[i].streak ? ` · ${esc(streakTxt(T[i].streak))}` : ""}</span>` : ""}</div>`;
  const head = `<div class="board">
      <div class="meta"><span>Preview</span><span>${esc([d?.venue, d?.city].filter(Boolean).join(", "))}</span></div>
      <div class="score">${team(0, "away")}<div class="when"><div class="t">${esc(when)}</div><div class="s">${esc(sub)}</div></div>${team(1, "home")}</div>
      ${d?.tv?.length ? `<div class="tv">Watch on ${esc(d.tv.join(", "))}</div>` : ""}
    </div>`;
  if(!P || P.loading) return `<article class="card game pv">${head}<div class="pv-sec muted">Loading the preview…</div></article>`;
  if(P.error) return `<article class="card game pv">${head}<div class="pv-sec muted">${esc(P.error)}</div></article>`;
  return `<article class="card game pv">${head}
    ${formSec(T)}${goalieSec(T)}${teamStatsSec(T)}${hotSec(d)}${seriesSec(d, T)}
  </article>`;
}
const streakTxt = st => { const m = /^([A-Z]+)(\d+)$/.exec(st); if(!m) return st; const n = +m[2];
  if(m[1] === "W") return n > 1 ? `won ${n} straight` : "won last game";
  if(m[1] === "L") return n > 1 ? `lost ${n} straight` : "lost last game";
  return n > 1 ? `${n} straight OT losses` : "lost last game in OT"; };
function formSec(T){
  if(!T.some(t => t.past?.length)) return "";
  return `<section class="pv-sec"><h3>Last 5 games</h3>${T.map((t,i) => `<div class="form-row" style="--team:var(--${i ? "home" : "away"})">
    <span class="ab">${logo(t.ab)}${esc(t.ab)}</span>
    <span class="pills">${t.past.map(r => `<span class="fx ${r.r}" title="${r.r === "W" ? "Win" : r.r === "L" ? "Loss" : "Overtime loss"} vs ${esc(r.opp)}">${r.r === "OTL" ? "OT" : r.r}</span>`).join("")}</span>
    <span class="sum"><b>${esc(t.l5 || "")}</b>${t.past.length ? ` · last: ${t.past[t.past.length-1].r === "W" ? "beat" : "lost to"} ${esc(t.past[t.past.length-1].opp)}` : ""}</span>
  </div>`).join("")}<div class="pv-note">Oldest to newest, left to right. OT means an overtime or shootout loss.</div></section>`;
}
function goalieSec(T){
  if(!T.some(t => t.proj)) return "";
  const card = (t, i) => { const g = t.proj; if(!g) return `<div class="gcard" style="--team:var(--${i ? "home" : "away"})"><span class="muted">No goalie stats yet.</span></div>`;
    const alt = t.goalies.filter(x => x.id !== g.id)[0];
    return `<div class="gcard" style="--team:var(--${i ? "home" : "away"})">
      <div class="top-line"><button type="button" class="gname" data-player="${g.id}">${esc(g.name)}${g.num != null ? ` <span class="muted">#${g.num}</span>` : ""}</button><span class="gtm">${logo(t.ab)}${esc(t.ab)}</span></div>
      <div class="nums"><div><b>${esc(g.rec || "–")}</b><span>Record</span></div><div><b>${svp(g.svp)}</b><span>Save %</span></div><div><b>${g.gaa == null ? "–" : g.gaa.toFixed(2)}</b><span>GAA</span></div><div><b>${g.gp}</b><span>Games</span></div></div>
      <div class="why">${esc(g.why)}.</div>
      ${alt ? `<div class="alt">Other option: ${esc(alt.name)} (${esc(alt.rec)}, ${svp(alt.svp)})</div>` : ""}
    </div>`; };
  return `<section class="pv-sec"><h3>Projected starting goalies</h3><div class="pv-two">${T.map(card).join("")}</div>
    <div class="pv-note">A projection from starts and rest. Teams confirm their starter close to puck drop.</div></section>`;
}
function teamStatsSec(T){
  const [a, h] = T.map(t => t.stats);
  if(!a || !h) return "";
  const rows = [
    ["Goals per game", a.gf, h.gf, 2, false, a.gfRk, h.gfRk], ["Goals against per game", a.ga, h.ga, 2, true, a.gaRk, h.gaRk],
    ["Power play", a.pp*100, h.pp*100, 1, false, a.ppRk, h.ppRk, "%"], ["Penalty kill", a.pk*100, h.pk*100, 1, false, a.pkRk, h.pkRk, "%"],
    ["Faceoffs won", a.fo*100, h.fo*100, 1, false, a.foRk, h.foRk, "%"]
  ].filter(r => r[1] != null && r[2] != null && !isNaN(r[1]) && !isNaN(r[2]));
  return `<section class="pv-sec"><h3>Season stats</h3><div class="tstats"><div class="ts-key"><span><i style="background:var(--away)"></i>${esc(T[0].ab)}</span><span>${esc(T[1].ab)}<i style="background:var(--home)"></i></span></div>` +
    rows.map(([n, x, y, dp, low, rx, ry, u = ""]) => { const tot = x + y || 1, ax = low ? x < y : x > y, hy = low ? y < x : y > x;
      return `<div class="ts-row"><span class="v${ax ? " lead" : ""}">${x.toFixed(dp)}${u}</span><span class="nm">${n}<br><span class="rk">${nth(rx)} · ${nth(ry)} in NHL</span></span><span class="v r${hy ? " lead" : ""}">${y.toFixed(dp)}${u}</span>
        <span class="bar" aria-hidden="true"><i class="a" style="width:${(x/tot*100).toFixed(1)}%"></i><i class="h" style="width:${(y/tot*100).toFixed(1)}%"></i></span></div>`; }).join("") + `</div></section>`;
}
function hotSec(d){
  const L = (d.leaders || []).filter(l => l.a || l.h);
  if(!L.length) return "";
  const pl = (x, cls) => x ? `<button type="button" class="pl ${cls}" data-player="${x.id}">${cls === "h" ? `<span class="n">${esc(x.name)}</span><span class="val">${x.val}</span>` : `<span class="val">${x.val}</span><span class="n">${esc(x.name)}</span>`}</button>` : "<span></span>";
  return `<section class="pv-sec"><h3>Hot players${d.leadersCtx === "last_5_games" ? " · last 5 games" : ""}</h3><div class="hot">${L.map(l => `<div class="hot-row">${pl(l.a, "a")}<span class="cat">${esc(CAT[l.cat] || l.cat)}</span>${pl(l.h, "h")}</div>`).join("")}</div></section>`;
}
function seriesSec(d, T){
  const S = d.series || [];
  const w = d.seriesWins;
  const head = S.length && w ? `${w[0] === w[1] ? `Series tied ${w[0]}–${w[1]}` : `${esc(T[w[0] > w[1] ? 0 : 1].ab)} lead ${Math.max(...w)}–${Math.min(...w)}`}` : "First meeting this season";
  return `<section class="pv-sec"><h3>Season series</h3><div class="series"><div><b>${head}</b></div>${S.map(m => `<div class="mtg"><span>${esc(tinyDay(m.d))}</span><span class="res">${esc(m.a)} ${m.as ?? ""} – ${m.hs ?? ""} ${esc(m.h)}${m.end && m.end !== "REG" ? ` (${esc(m.end)})` : ""}</span></div>`).join("")}</div></section>`;
}

function ratingsPanel(g, R, fin){
  const ranked = R.filter(p => p.rating != null).sort((a,b) => b.rating - a.rating || b.raw - a.raw);
  const bestId = ranked[0]?.id;
  const stars = ranked.length ? `<div class="stars">${ranked.slice(0,3).map((p,i) => `
    <button type="button" class="star" data-open="${p.id}">${avatar(p, "lg", false)}
      <span class="who"><span class="rank">${fin ? ["Player of the game","2nd star","3rd star"][i] : ["Leading","2nd","3rd"][i]}</span>
      <b>${esc(p.name)}</b><span>${esc(g.t[p.side].ab)} · Top ${topPct(p.pct)} of ${GRP_NAME[p.grp]} games</span></span></button>`).join("")}</div>` : "";
  return stars + `<div class="lineups">${[0,1].map(side => {
    const mine = R.filter(p => p.side === side);
    const groups = [["Forwards", mine.filter(p => !p.goalie && p.pos !== "D")], ["Defense", mine.filter(p => p.pos === "D")], ["Goalies", mine.filter(p => p.goalie && !p.dnp)]];
    const rated = mine.filter(p => p.rating != null), avg = rated.length ? rated.reduce((a,p) => a + p.rating, 0) / rated.length : null;
    return `<section class="side${side}" aria-label="${esc(g.t[side].nm)} lineup">
      <div class="lineup-head"><h3>${logo(g.t[side].ab)}${esc(g.t[side].nm)}</h3><span class="avg">${avg == null ? "" : `Average <b class="mono">${avg.toFixed(2)}</b>`}</span></div>
      ${groups.map(([lbl, arr]) => `<div class="group-label label">${lbl}</div>` + [...arr].sort((a,b) => (b.rating ?? -1) - (a.rating ?? -1)).map(p => playerRow(p, bestId)).join("")).join("")}
    </section>`; }).join("")}</div>`;
}
function statsPanel(g){
  const sum = (side, k) => g.p.slice(0, g.g0).filter(r => r[0] === side).reduce((a,r) => a + r[k], 0);
  const xg = side => g.s.filter(s => s[1] === side && s[2] !== "B").reduce((a,s) => a + s[6], 0) / 1000;
  const att = side => g.s.filter(s => s[1] === side).length;
  const hd = side => g.s.filter(s => s[1] === side && s[2] !== "B" && s[10]).length;
  const ppg = side => g.gl.filter(x => x[2] === side && x[5] === "PP").length;
  const rows = [
    ["Expected goals", xg(0), xg(1), 2], ["Shots on goal", g.t[0].sog, g.t[1].sog, 0], ["Shot attempts", att(0), att(1), 0],
    ["High-danger chances", hd(0), hd(1), 0], ["Power-play goals", ppg(0), ppg(1), 0], ["Faceoffs won", sum(0,16), sum(1,16), 0],
    ["Hits", sum(0,9), sum(1,9), 0], ["Blocked shots", sum(0,13), sum(1,13), 0], ["Takeaways", sum(0,15), sum(1,15), 0],
    ["Giveaways", sum(0,14), sum(1,14), 0], ["Penalty minutes", sum(0,8), sum(1,8), 0]
  ];
  return `<div class="tstats"><div class="ts-key"><span><i style="background:var(--away)"></i>${esc(g.t[0].ab)}</span><span>${esc(g.t[1].ab)}<i style="background:var(--home)"></i></span></div>` +
    rows.map(([n,a,b,d]) => { const tot = a + b || 1;
      return `<div class="ts-row"><span class="v${a > b ? " lead" : ""}">${a.toFixed(d)}</span><span class="nm">${n}</span><span class="v r${b > a ? " lead" : ""}">${b.toFixed(d)}</span>
        <span class="bar" aria-hidden="true"><i class="a" style="width:${(a/tot*100).toFixed(1)}%"></i><i class="h" style="width:${(b/tot*100).toFixed(1)}%"></i></span></div>`; }).join("") + `</div>`;
}
function mapPanel(){
  return `<div class="map-top"><div class="seg" role="group" aria-label="Game situation">
      <button type="button" data-f="all" aria-pressed="${mapFilter === "all"}">All</button>
      <button type="button" data-f="ev" aria-pressed="${mapFilter === "ev"}">Even strength</button>
      <button type="button" data-f="pp" aria-pressed="${mapFilter === "pp"}">Power play</button></div></div>
    <div class="map-wrap" id="map-wrap"></div>
    <div class="map-legend">
      <span><svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="var(--muted)" stroke="var(--surface)" stroke-width="1.5"/></svg>Goal</span>
      <span><svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="var(--muted)" fill-opacity=".35" stroke="var(--muted)"/></svg>Shot on goal</span>
      <span><svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="var(--surface)" stroke="var(--muted)" stroke-dasharray="2 1.2"/></svg>Missed net</span>
      <span>Bigger dot = higher expected-goal value</span>
    </div><div class="avg" id="map-summary" style="margin-top:6px"></div>`;
}
function goalsPanel(g){
  if(!g.gl.length) return `<div class="muted">No goals yet.</div>`;
  const names = g.p.map(r => r[3]);
  const stren = gl => gl[6] ? '<span class="tag">EN</span>' : gl[5] !== "EV" ? `<span class="tag">${gl[5]}</span>` : "";
  return `<ul class="goal-list">${g.gl.map(gl => `<li><span class="mono muted">${gl[0] > 3 ? "OT" : "P" + gl[0]} ${gl[1]}</span><span class="tm" style="color:var(--${gl[2] ? "home" : "away"})">${esc(g.t[gl[2]].ab)}</span><span><b>${esc(names[gl[3]] || "Unknown")}</b>${stren(gl)} <span class="muted">· ${gl[4].length ? gl[4].map(i => esc(names[i])).join(", ") : "Unassisted"}</span></span></li>`).join("")}</ul>`;
}

function advGrid(pl){
  const a = pl.adv; if(!a) return "";
  const cells = pl.goalie ? [
    [`${a.gsax >= 0 ? "+" : ""}${a.gsax.toFixed(2)}`, "Goals saved above expected"], [a.xga.toFixed(2), "Expected goals against"], [`${a.hdSaves}/${a.hdFaced}`, "High-danger saves"]
  ] : [
    [a.ixg.toFixed(2), "Expected goals"], [`${a.gax >= 0 ? "+" : ""}${a.gax.toFixed(2)}`, "Goals above expected"],
    [`${a.icf}`, `Shot attempts (${a.blockedBy} blocked, ${a.miss} missed)`], [pctTxt(a.xgpct), "Even-strength xG share"],
    [pctTxt(a.cfpct), "Even-strength shot-attempt share"], [a.fw + a.fl ? `${a.fw}–${a.fl}` : "–", "Faceoffs won–lost"]
  ];
  return `<div class="adv-grid">${cells.map(([v,l]) => `<div class="adv"><b>${v}</b><span>${l}</span></div>`).join("")}</div>`;
}
function playerRow(pl, bestId){
  const isOpen = open.has(pl.id);
  let bd = "";
  if(isOpen){
    bd = `<div class="breakdown" id="bd-${pl.id}">`;
    if(pl.rating != null){
      const cal = CALS[pl.grp], who = GRP_NAME[pl.grp];
      const pool = calSource === "season" ? `${cal.n.toLocaleString()} ${who} games this season` : `${cal.n} ${who} games on this page`;
      bd += `<div class="bd-top"><b>${pl.raw > cal.q[200] ? `Best ${who} game of the season` : `Better than ${ord(pl.pct)}% of ${who} games`}</b><button type="button" class="link-btn" data-player="${pl.id}">View profile →</button></div>
        <div class="pbar" aria-hidden="true"><i style="width:${(pl.pct*100).toFixed(1)}%;background:var(--r-${band(pl.rating)})"></i><span class="tick" style="left:calc(50% - 1px)"></span></div>
        <div class="bd-note">Compared with ${pool}</div>`;
    } else bd += `<div class="bd-top"><span class="bd-note">${esc(pl.note || "")}</span><button type="button" class="link-btn" data-player="${pl.id}">View profile →</button></div>`;
    if(!pl.dnp){
      bd += advGrid(pl) + `<div class="bd">`;
      let grp = "";
      pl.rows.forEach(([gname, l, v]) => {
        if(gname !== grp){ grp = gname; bd += `<div class="bd-group">${gname}</div>`; }
        const cls = Math.abs(v) < .005 ? "zero" : v > 0 ? "pos" : "neg";
        bd += `<div class="bd-row"><span>${esc(l)}</span><span class="v ${cls}">${Math.abs(v) < .005 ? "0.00" : sign(v)}</span></div>`;
      });
      bd += `<div class="bd-row total"><span>Game score</span><span class="v">${sign(pl.raw)}</span></div>`;
      if(pl.rating != null) bd += `<div class="bd-row"><span>Rating (${SCALE.center.toFixed(1)} + ${SCALE.spread.toFixed(2)} × ${pl.z.toFixed(2)})</span><span class="v">${pl.rating.toFixed(2)}</span></div>`;
      bd += `</div>`;
    }
    bd += `</div>`;
  }
  return `<div class="player" data-row="${pl.id}"><button type="button" data-id="${pl.id}" aria-expanded="${isOpen}" ${isOpen ? `aria-controls="bd-${pl.id}"` : ""}>
    ${avatar(pl, "", pl.id === bestId)}
    <span class="pinfo"><span class="pname">${esc(pl.name)}<span class="pos">${pl.pos}</span></span><span class="pline">${esc(pl.line || "")}</span></span>
    <span class="num-r">#${pl.num}</span>
  </button>${bd}</div>`;
}

// ---------- Shot map ----------
function drawMap(){
  const g = GAMES.get(current), wrap = $("map-wrap"); if(!g || !wrap) return;
  const names = g.p.map(r => r[3]);
  const keep = s => s[2] !== "B" && (mapFilter === "all" || (mapFilter === "ev" ? !/[pse]/.test(s[9]) : s[9].includes("p")));
  const list = g.s.map((s,i) => [s,i]).filter(([s]) => keep(s));
  let svg = `<svg viewBox="-102 -45 204 98" role="img" aria-label="Shot map. ${esc(g.t[0].ab)} shots on the right half, ${esc(g.t[1].ab)} shots on the left half.">
    <rect class="rink-ice" x="-100" y="-42.5" width="200" height="85" rx="28"/>
    <line class="rk-red" x1="0" y1="-42.5" x2="0" y2="42.5"/>
    <line class="rk-blue" x1="-25" y1="-42.5" x2="-25" y2="42.5"/><line class="rk-blue" x1="25" y1="-42.5" x2="25" y2="42.5"/>
    <line class="rk-red" x1="-89" y1="-36" x2="-89" y2="36"/><line class="rk-red" x1="89" y1="-36" x2="89" y2="36"/>
    <circle class="rk-circle" cx="0" cy="0" r="15"/>
    <circle class="rk-circle" cx="69" cy="22" r="15"/><circle class="rk-circle" cx="69" cy="-22" r="15"/>
    <circle class="rk-circle" cx="-69" cy="22" r="15"/><circle class="rk-circle" cx="-69" cy="-22" r="15"/>
    <path class="rk-crease" d="M89 -4 L83 -4 A4 4 0 0 0 83 4 L89 4 Z"/><path class="rk-crease" d="M-89 -4 L-83 -4 A4 4 0 0 1 -83 4 L-89 4 Z"/>
    <text class="rk-text" x="50" y="50" text-anchor="middle">${esc(g.t[0].ab)} SHOOTING →</text>
    <text class="rk-text" x="-50" y="50" text-anchor="middle">← ${esc(g.t[1].ab)} SHOOTING</text>`;
  list.sort((a,b) => a[0][6] - b[0][6]).forEach(([s,i]) => {
    const away = s[1] === 0, xgv = s[6] / 1000;
    const x = Math.max(-99, Math.min(99, away ? s[3] : -s[3])), y = Math.max(-41, Math.min(41, away ? s[4] : -s[4]));
    const r = 1.3 + 4.2*Math.sqrt(xgv);
    svg += `<g class="shot ${away ? "a" : "h"} ${s[2]}" tabindex="0" data-i="${i}" aria-label="${esc(names[s[7]] || "Unknown")}, ${s[2] === "G" ? "goal" : s[2] === "S" ? "shot on goal" : "missed"}, ${xgv.toFixed(2)} expected goals">
      <circle class="hit" cx="${x}" cy="${y}" r="${Math.max(r,3.2).toFixed(2)}"/><circle class="m" cx="${x}" cy="${y}" r="${r.toFixed(2)}"/>${s[2] === "G" ? `<circle class="ring" cx="${x}" cy="${y}" r="${(r+.25).toFixed(2)}"/>` : ""}</g>`;
  });
  svg += `</svg><div class="tip" id="tip" hidden></div>`;
  wrap.innerHTML = svg;
  const n = side => list.filter(([s]) => s[1] === side).length, x = side => list.filter(([s]) => s[1] === side).reduce((a,[s]) => a + s[6], 0) / 1000;
  $("map-summary").textContent = `${n(0)} ${g.t[0].ab} and ${n(1)} ${g.t[1].ab} unblocked shots · xG ${x(0).toFixed(2)} – ${x(1).toFixed(2)}`;
}
function showTip(el){
  const tip = $("tip"); if(!tip) return;
  const g = GAMES.get(current), s = g.s[+el.dataset.i];
  const res = { G:"Goal", S:"Saved", M:"Missed net" }[s[2]];
  const fl = s[9], ctx = [fl.includes("p") && "power play", fl.includes("s") && "shorthanded", fl.includes("e") && "empty net", fl.includes("r") && "rebound", fl.includes("u") && "off the rush"].filter(Boolean).join(", ");
  tip.innerHTML = `<b>${esc(g.p[s[7]]?.[3] || "Unknown")} · ${res}</b><span class="mono">${clock(s[0])} · ${E.SHOT_TYPES[s[5]] || "shot"}${ctx ? ` · ${ctx}` : ""}</span><br><span class="mono">${(s[6]/1000).toFixed(2)} xG</span>`;
  tip.hidden = false;
  const w = $("map-wrap").getBoundingClientRect(), b = el.getBoundingClientRect();
  let left = b.left - w.left + b.width/2 + 10, top = b.top - w.top - 8;
  if(left + 190 > w.width) left = b.left - w.left - 190;
  tip.style.left = Math.max(0, left) + "px"; tip.style.top = Math.max(0, top) + "px";
}

// ---------- About ----------
function renderAbout(){
  const c = SCALE.center, s = SCALE.spread;
  $("scale-formula").textContent = `${c.toFixed(1)} + ${s.toFixed(2)} × z`;
  const pct = v => v >= 99.95 ? "99.9" : v >= 99 ? v.toFixed(1) : String(Math.round(v));
  const rows = [`<tr><td class="mono">${c.toFixed(1)}</td><td>Half of all games at his position</td><td>The typical game</td></tr>`];
  [7,8,9,10].forEach(r => { if(r <= c + 0.05) return; const z = (r - c)/s, share = 1 - E.normCdf(z);
    rows.push(`<tr><td class="mono">${r === 10 ? "10.0" : r.toFixed(1) + "+"}</td><td>${pct(E.normCdf(z)*100)}%</td><td>About 1 in ${Math.max(2, Math.round(1/share)).toLocaleString()} games</td></tr>`); });
  $("scale-body").innerHTML = rows.join("");
  if(BASE){ const b = BASE.cal; $("pool-counts").textContent = `: ${b.F.n.toLocaleString()} forward games, ${b.D.n.toLocaleString()} defenseman games, and ${b.G.n.toLocaleString()} goalie games from ${BASE.games.toLocaleString()} games so far`; }
}

// ---------- Player pages ----------
const ftIn = inches => inches ? `${Math.floor(inches/12)}′${inches%12}″` : "–";
function ageOn(birth){ const b = new Date(birth + "T12:00:00Z"), n = new Date(); let a = n.getUTCFullYear() - b.getUTCFullYear(); if(n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())) a--; return a; }
const seasonLabel = s => `${String(s).slice(0,4)}–${String(s).slice(6)}`;
const money = v => v >= 1e6 ? `$${(v/1e6).toFixed(3).replace(/\.?0+$/,"")}M` : `$${Math.round(v/1000)}K`;
const ordinal = n => { const s = ["th","st","nd","rd"], v = n % 100; return n + (s[(v-20)%10] || s[v] || s[0]); };

async function openPlayer(id, { push = true } = {}){
  closeSearch();
  setView("player", { push, id });
  const host = $("view-player");
  if(PLAYER?.id !== id){ PLAYER = null; playerTab = "profile";
    host.innerHTML = `<button type="button" class="back" data-back>← Back</button><div class="card loading">Loading player…</div>`; }
  window.scrollTo(0, 0);
  try {
    const [p] = await Promise.all([ api(`/api/player?id=${id}`), CONTRACTS ? null : fetch("./contracts.json").then(r => r.ok ? r.json() : {}).then(j => { CONTRACTS = j; }).catch(() => { CONTRACTS = {}; }) ]);
    if(view !== "player") return;
    PLAYER = p; renderPlayer();
  } catch(e){ host.innerHTML = `<button type="button" class="back" data-back>← Back</button><div class="card loading">${esc(e.message)}</div>`; }
}
function renderPlayer(){
  const p = PLAYER, host = $("view-player");
  const name = `${p.first} ${p.last}`;
  const rated = p.games.filter(g => g.rating != null);
  const avg = rated.length ? rated.reduce((a,g) => a + g.rating, 0) / rated.length : null;
  const cur = p.seasons.filter(s => s.season === p.season);
  const curTot = cur.reduce((a,s) => ({ gp:a.gp+s.gp, g:a.g+s.g, a:a.a+s.a, p:a.p+s.p, w:a.w+(s.w||0) }), { gp:0, g:0, a:0, p:0, w:0 });
  const quick = p.goalie
    ? [[curTot.gp, "Games"], [curTot.w, "Wins"], [avg == null ? "–" : avg.toFixed(2), "Avg rating"]]
    : [[curTot.gp, "Games"], [curTot.g, "Goals"], [curTot.a, "Assists"], [curTot.p, "Points"], [avg == null ? "–" : avg.toFixed(2), "Avg rating"]];
  const sub = [p.num != null ? `#${p.num}` : "", POS_NAME[p.pos] || p.pos, p.active ? p.teamName : "Retired"].filter(Boolean).join(" · ");
  const tabs = [["profile","Profile"],["games",`Games${p.games.length ? ` (${p.games.length})` : ""}`],["career","Career"]];
  host.innerHTML = `<button type="button" class="back" data-back>← Back</button>
  <article class="card">
    <div class="p-hero">
      <div class="p-head">
        <span class="av xl" style="--team:var(--accent)"><span class="face" aria-hidden="true">${initials(name)}</span>${avg != null ? chip(avg) : ""}</span>
        <div><h1>${esc(name)}</h1><div class="sub">${p.active ? logo(p.team) : ""}${esc(sub)}</div></div>
      </div>
      ${p.active || curTot.gp ? `<div class="p-quick" aria-label="${seasonLabel(p.season)} season">${quick.map(([v,l]) => `<div><b>${v}</b><span>${l}</span></div>`).join("")}<div><b style="font-size:14px;font-family:var(--f-body);color:var(--muted)">${seasonLabel(p.season)}</b><span>Season</span></div></div>` : ""}
      <div class="tabs" role="tablist">${tabs.map(([k,l]) => `<button type="button" role="tab" data-ptab="${k}" aria-selected="${playerTab === k}">${l}</button>`).join("")}</div>
    </div>
    <div class="panel" role="tabpanel">${playerTab === "profile" ? profilePanel(p) : playerTab === "games" ? gamesPanel(p, avg) : careerPanel(p)}</div>
  </article>`;
}
function profilePanel(p){
  const place = [p.birthCity, p.birthState, COUNTRIES[p.birthCountry] || p.birthCountry].filter(Boolean).join(", ");
  const facts = [
    ["Height", p.heightIn ? `${ftIn(p.heightIn)} (${p.heightCm} cm)` : "–"],
    ["Weight", p.weightLb ? `${p.weightLb} lb (${p.weightKg} kg)` : "–"],
    ["Born", p.birthDate ? `${shortDay(p.birthDate)} · age ${ageOn(p.birthDate)}` : "–"],
    ["Birthplace", place || "–"],
    ["Country", COUNTRIES[p.birthCountry] || p.birthCountry || "–"],
    ["Number", p.num != null ? `#${p.num}` : "–"],
    ["Position", POS_NAME[p.pos] || p.pos || "–"],
    [p.goalie ? "Catches" : "Shoots", p.shoots === "L" ? "Left" : p.shoots === "R" ? "Right" : "–"],
    ["Team", p.active ? (p.teamName || "–") : "Retired"],
    ["Draft", p.draft ? `${p.draft.year} · Round ${p.draft.round}, pick ${p.draft.pick} (${ordinal(p.draft.overall)} overall) · ${p.draft.team}` : "Undrafted"]
  ];
  const c = CONTRACTS?.[p.id];
  const contract = c ? `<div class="contract"><h3>Contract</h3><div class="terms">
      <div><b>${c.years} yr${c.years === 1 ? "" : "s"}</b><span>Length</span></div>
      <div><b>${money(c.aav)}</b><span>Average annual value</span></div>
      ${c.total ? `<div><b>${money(c.total)}</b><span>Total value</span></div>` : ""}
      ${c.through ? `<div><b>${esc(c.through)}</b><span>Runs through</span></div>` : ""}</div></div>`
    : `<div class="contract"><h3>Contract</h3><p>Contract details aren't available yet. The NHL's public data doesn't include contracts, so this will fill in once a licensed contract data source is connected.</p></div>`;
  return `<dl class="facts">${facts.map(([k,v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>${contract}`;
}
function gamesPanel(p, avg){
  if(!p.games.length) return `<div class="muted">No NHL games for ${esc(p.first)} ${esc(p.last)} yet this season.</div>`;
  const best = p.games.filter(g => g.rating != null).sort((a,b) => b.rating - a.rating)[0];
  const sum = `<div class="season-sum"><span>Average rating <b class="mono">${avg == null ? "–" : avg.toFixed(2)}</b></span>${best ? `<span>Best <b class="mono">${best.rating.toFixed(1)}</b> ${best.home ? "vs" : "at"} ${esc(best.opp)}, ${tinyDay(best.date)}</span>` : ""}<span>Tap a game to open it</span></div>`;
  const head = p.goalie ? `<th class="l">Date</th><th class="l">Opp</th><th class="l">Result</th><th>Saves</th><th class="hide-sm">SV%</th><th class="hide-sm">TOI</th><th>Rating</th>`
    : `<th class="l">Date</th><th class="l">Opp</th><th class="l">Result</th><th>G</th><th>A</th><th class="hide-sm">P</th><th class="hide-sm">TOI</th><th>Rating</th>`;
  const rows = p.games.map(g => {
    const res = g.result ? `<span class="res-${g.result}">${g.result}</span> ${esc(g.score || "")}` : "";
    const cells = p.goalie
      ? `<td class="mono">${g.sa != null ? `${g.sa - (g.ga||0)}/${g.sa}` : "–"}</td><td class="mono hide-sm">${g.sa ? ((g.sa - g.ga)/g.sa).toFixed(3).replace(/^0/,"") : "–"}</td>`
      : `<td class="mono">${g.g}</td><td class="mono">${g.a}</td><td class="mono hide-sm">${g.g + g.a}</td>`;
    return `<tr class="click" data-gamelink="${g.id}" data-date="${g.date}" tabindex="0"><td class="l">${tinyDay(g.date)}</td><td class="l"><span class="opp">${g.home ? "vs" : "at"} ${logo(g.opp)}${esc(g.opp)}</span></td><td class="l">${res}</td>${cells}<td class="mono hide-sm">${esc(g.toi)}</td><td>${chip(g.rating)}</td></tr>`;
  }).join("");
  return sum + `<div class="tbl-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function careerPanel(p){
  if(!p.seasons.length) return `<div class="muted">No NHL regular-season games yet.</div>`;
  const svp = v => v == null ? "–" : v.toFixed(3).replace(/^0/,""), gaa = v => v == null ? "–" : v.toFixed(2);
  const head = p.goalie ? `<th class="l">Season</th><th class="l">Team</th><th>GP</th><th>W</th><th>L</th><th>OTL</th><th>SV%</th><th>GAA</th><th>SO</th>`
    : `<th class="l">Season</th><th class="l">Team</th><th>GP</th><th>G</th><th>A</th><th>P</th><th class="hide-sm">+/−</th>`;
  const line = s => p.goalie
    ? `<td class="mono">${s.gp}</td><td class="mono">${s.w ?? "–"}</td><td class="mono">${s.l ?? "–"}</td><td class="mono">${s.otl ?? "–"}</td><td class="mono">${svp(s.svp)}</td><td class="mono">${gaa(s.gaa)}</td><td class="mono">${s.so ?? "–"}</td>`
    : `<td class="mono">${s.gp}</td><td class="mono">${s.g}</td><td class="mono">${s.a}</td><td class="mono">${s.p}</td><td class="mono hide-sm">${s.pm == null ? "–" : (s.pm > 0 ? "+" : "") + s.pm}</td>`;
  const rows = [...p.seasons].reverse().map(s => `<tr><td class="l">${seasonLabel(s.season)}</td><td class="l">${esc(s.team)}</td>${line(s)}</tr>`).join("");
  const nSeasons = new Set(p.seasons.map(s => s.season)).size;
  const foot = p.career ? `<tfoot><tr><td class="l">Career</td><td class="l">${nSeasons} season${nSeasons === 1 ? "" : "s"}</td>${line(p.career)}</tr></tfoot>` : "";
  return `<div class="tbl-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody>${foot}</table></div>`;
}

// ---------- Search ----------
let searchTimer = 0, searchSeq = 0, hl = -1;
const input = $("search"), results = $("results");
function closeSearch(){ results.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); hl = -1; }
function renderResults(list, q){
  hl = -1;
  results.innerHTML = list.length ? list.map((p,i) => `<li><button type="button" role="option" data-player="${p.id}" id="opt-${i}"><span>${esc(p.name)}</span><span class="meta">${p.team ? logo(p.team) : ""}${esc([p.pos, p.team].filter(Boolean).join(" · "))}${p.active ? "" : " · Retired"}</span></button></li>`).join("")
    : `<li class="empty">No players match “${esc(q)}”.</li>`;
  results.hidden = false; input.setAttribute("aria-expanded", "true");
}
input.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = input.value.trim();
  if(q.length < 2){ closeSearch(); return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try { const r = await api(`/api/search?q=${encodeURIComponent(q)}`); if(seq === searchSeq) renderResults(r.players, q); }
    catch(e){ if(seq === searchSeq){ results.innerHTML = `<li class="empty">${esc(e.message)}</li>`; results.hidden = false; } }
  }, 220);
});
input.addEventListener("keydown", e => {
  const opts = [...results.querySelectorAll("button[data-player]")];
  if(e.key === "ArrowDown" || e.key === "ArrowUp"){
    if(!opts.length) return; e.preventDefault();
    hl = (hl + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
    opts.forEach((o,i) => o.classList.toggle("hl", i === hl)); input.setAttribute("aria-activedescendant", opts[hl].id);
  } else if(e.key === "Enter"){ const o = opts[hl >= 0 ? hl : 0]; if(o){ e.preventDefault(); input.value = ""; openPlayer(+o.dataset.player); } }
  else if(e.key === "Escape") closeSearch();
});
document.addEventListener("click", e => { if(!e.target.closest(".search")) closeSearch(); });

// ---------- Views ----------
function setView(v, { push = true, id = null } = {}){
  view = v;
  ["scores","player","about"].forEach(k => $("view-" + k).hidden = k !== v);
  document.querySelectorAll(".nav button").forEach(b => b.setAttribute("aria-current", b.dataset.view === v ? "page" : "false"));
  if(push) try { history.pushState({ view: v, id }, ""); } catch(e){}
  if(v === "about") renderAbout();
}
window.addEventListener("popstate", e => {
  const s = e.state || { view: "scores" };
  if(s.view === "player" && s.id) openPlayer(s.id, { push:false });
  else { setView(s.view || "scores", { push:false }); if(SCHED && (s.view || "scores") === "scores") renderScores(); }
});

// ---------- Loading ----------
async function loadGames(ids){
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, async () => {
    while(k < ids.length){ const id = ids[k++];
      try { GAMES.set(id, await api(`/api/game?id=${id}`)); } catch(e){ console.warn(e); } }
  }));
}
function pickTopGame(){
  rateAll(); let best = null;
  dayGames().forEach(g => (RATED[g.id] || []).forEach(p => { if(p.rating != null && (!best || p.rating > best.r)) best = { r:p.rating, g:g.id }; }));
  if(best) return best.g;
  if(dayGames()[0]) return dayGames()[0].id;
  // Nothing has started: open the preview of the next game
  const up = (SCHED?.games || []).filter(s => !started(s.st) && s.st !== "PPD").sort((a,b) => (a.start || "").localeCompare(b.start || ""));
  return up[0]?.id ?? null;
}
function renderScores(){ rateAll(); renderStrip(); renderBest(); renderGame(); }
async function loadDay(date, { select = null } = {}){
  viewDate = date;
  SCHED = await api(`/api/schedule?date=${date}`);
  open.clear(); current = select; bestAll = false; PREVIEWS.clear();
  lastUpdated = new Date();
  renderScores();
  const need = SCHED.games.filter(g => started(g.st) && (!GAMES.has(g.id) || !done(GAMES.get(g.id).st))).map(g => g.id);
  await loadGames(need);
  if(!current) current = pickTopGame();
  renderScores();
  schedulePoll();
}
async function refresh(){
  try {
    const wasToday = viewDate === SCHED.today;
    const s = await api(`/api/schedule?date=${viewDate}`);
    if(wasToday && s.today !== viewDate){ goDay(s.today); return; }   // the day rolled over while the page was open
    SCHED = s;
    const need = s.games.filter(g => started(g.st) && (!GAMES.has(g.id) || !done(GAMES.get(g.id).st))).map(g => g.id);
    await loadGames(need);
    lastUpdated = new Date();
    if(!current) current = pickTopGame();
    if(view === "scores"){ const y = window.scrollY; renderScores(); window.scrollTo(0, y); }
  } catch(e){ $("updated").textContent = `Couldn't refresh: ${e.message}`; }
  schedulePoll();
}
function schedulePoll(){
  clearTimeout(pollTimer);
  if(!SCHED) return;
  const anyLive = SCHED.games.some(g => live(g.st));
  const soon = SCHED.games.some(g => !started(g.st) && g.start && new Date(g.start) - Date.now() < 30*60*1000 && g.st !== "PPD");
  if(anyLive || soon) pollTimer = setTimeout(refresh, 60*1000);
  else if(viewDate >= SCHED.today) pollTimer = setTimeout(refresh, 5*60*1000);
  else pollTimer = setTimeout(refresh, 15*60*1000);
}
const goDay = (d, opts) => { if(view !== "scores") setView("scores"); current = null; $("strip").innerHTML = ""; $("game").innerHTML = `<div class="card loading">Loading games…</div>`; return loadDay(d, opts).catch(showError); };
function showError(e){ $("game").innerHTML = `<div class="card empty-card">${esc(e.message || String(e))}</div>`; }

// ---------- Events ----------
document.addEventListener("click", e => {
  const t = e.target;
  const pl = t.closest("[data-player]"); if(pl){ input.value = ""; openPlayer(+pl.dataset.player); return; }
  if(t.closest("[data-back]")){ if(history.state && history.state.view !== "scores" && history.length > 1) history.back(); else { setView("scores"); renderScores(); } return; }
  const nv = t.closest(".nav button"); if(nv){ setView(nv.dataset.view); if(nv.dataset.view === "scores" && SCHED) renderScores(); return; }
  if(t.closest("#home-btn")){ if(SCHED && viewDate === SCHED.today){ setView("scores"); renderScores(); } else if(SCHED) goDay(SCHED.today); return; }
  const gc = t.closest(".gchip"); if(gc){ current = +gc.dataset.g; open.clear(); renderStrip(); renderGame(); return; }
  const bp = t.closest("#best-list button"); if(bp){ current = +bp.dataset.g; open.clear(); open.add(+bp.dataset.p); gameTab = "ratings"; renderStrip(); renderGame(); scrollToRow(+bp.dataset.p); return; }
  if(t.closest("#best-more")){ bestAll = !bestAll; renderBest(); return; }
  const gt = t.closest("[data-gtab]"); if(gt){ gameTab = gt.dataset.gtab; renderGame(); return; }
  const st = t.closest(".star[data-open]"); if(st){ const id = +st.dataset.open; open.add(id); renderGame(); scrollToRow(id); return; }
  const pb = t.closest(".player > button[data-id]"); if(pb){ const id = +pb.dataset.id; open.has(id) ? open.delete(id) : open.add(id); renderGame(); document.querySelector(`.player > button[data-id="${id}"]`)?.focus(); return; }
  const mf = t.closest(".seg button[data-f]"); if(mf){ mapFilter = mf.dataset.f; renderGame(); return; }
  const ptab = t.closest("[data-ptab]"); if(ptab){ playerTab = ptab.dataset.ptab; renderPlayer(); return; }
  const gl = t.closest("[data-gamelink]"); if(gl){ openGameFromPlayer(+gl.dataset.gamelink, gl.dataset.date); return; }
  if(t.id === "see-prev"){ goDay(shiftDate(viewDate, -1)); return; }
  const sh = t.closest(".shot"); if(sh) showTip(sh);
});
document.addEventListener("keydown", e => { if(e.key === "Enter"){ const gl = e.target.closest?.("[data-gamelink]"); if(gl) openGameFromPlayer(+gl.dataset.gamelink, gl.dataset.date); } });
function openGameFromPlayer(gameId, date){
  const pid = PLAYER?.id;
  gameTab = "ratings";
  goDay(date, { select: gameId }).then(() => { if(pid){ open.add(pid); renderGame(); scrollToRow(pid); } });
}
function scrollToRow(id){
  const row = document.querySelector(`.player[data-row="${id}"]`);
  if(row){ row.scrollIntoView({ block:"center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); row.querySelector("button")?.focus({ preventScroll:true }); }
}
document.addEventListener("mouseover", e => { const el = e.target.closest(".shot"); if(el) showTip(el); });
document.addEventListener("mouseout", e => { if(e.target.closest(".shot")){ const t = $("tip"); if(t) t.hidden = true; } });
document.addEventListener("focusin", e => { const el = e.target.closest(".shot"); if(el) showTip(el); });
document.addEventListener("focusout", e => { if(e.target.closest(".shot")){ const t = $("tip"); if(t) t.hidden = true; } });
$("prev-day").addEventListener("click", () => goDay(shiftDate(viewDate, -1)));
$("next-day").addEventListener("click", () => goDay(shiftDate(viewDate, 1)));
$("today-btn").addEventListener("click", () => goDay(SCHED.today));
document.addEventListener("visibilitychange", () => { if(!document.hidden && SCHED && (viewDate === SCHED.today || SCHED.games.some(g => live(g.st)))) refresh(); });

// ---------- Boot ----------
(async function boot(){
  try { history.replaceState({ view:"scores" }, "", location.pathname); } catch(e){}   // every visit starts fresh on today's games
  renderAbout();
  api("/api/baseline").then(b => { BASE = b; renderAbout(); if(SCHED && view === "scores") renderScores(); })
    .catch(() => { $("pool-counts").textContent = " (the season comparison couldn't load, so ratings are graded against the games on screen)"; });
  try {
    const t = await api(`/api/schedule`);
    await loadDay(t.date);
  } catch(e){ showError(e); }
})();
