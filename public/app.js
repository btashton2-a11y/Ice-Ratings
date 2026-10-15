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

// Player headshots: the NHL keeps each player's most recent photo at /latest/<id>.png (initials show until it loads, or if it fails)
const mug = (id, cls = "") => id ? `<img class="mug${cls ? " " + cls : ""}" src="https://assets.nhle.com/mugs/nhl/latest/${+id}.png" alt="" loading="lazy" onerror="this.remove()">` : "";

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
    const isLive = !done(g.st), f = gameFrac(g);
    RATED[g.id] = scored[g.id].map(p => {
      if(p.raw == null) return { ...p, rating:null, note:"Did not play." };
      if(!isLive && !p.goalie && p.toi < E.MIN_TOI_SK) return { ...p, rating:null, note:`Only ${E.fmtToi(p.toi)} of ice time, so no rating is given.` };
      if(!CALS) return { ...p, rating:null, note:"Ratings appear once the season comparison loads." };
      const grp = E.grpOf(p.pos), cal = CALS[grp];
      const raw = isLive ? liveRaw(p, cal, f) : p.raw;
      const c = E.calibrate(raw, cal, SCALE);
      return { ...p, grp, rating:c.rating, pct:c.pct, z:c.z, live:isLive };
    });
  });
}
// How far through regulation a game is (0 at puck drop, 1 at the end of the 3rd)
function gameFrac(g){
  if(done(g.st)) return 1;
  const prd = g.prd || 1;
  if(prd > 3) return 1;
  const [m, sec] = String(g.clk || "20:00").split(":").map(Number), left = (m || 0) * 60 + (sec || 0);
  const elapsed = (prd - 1) * 1200 + (g.inter ? 1200 : Math.max(0, 1200 - left));
  return Math.max(0, Math.min(1, elapsed / 3600));
}
// Live games: every dressed player starts at a typical game (6.6) and moves with what he does. What he has done so far
// counts in full; the part of the game still to be played is filled in as an average night. Ice time is judged on his pace.
// At the final horn this is exactly his post-game rating.
function liveRaw(p, cal, f){
  const typical = cal.q[100];
  if(p.goalie) return p.raw + (1 - f) * typical;
  const toiRow = p.rows.find(r => r[1].startsWith("Ice time")), toiNow = toiRow ? toiRow[2] : 0;
  const Wp = p.pos === "D" ? { ...W, ...E.DEFENSE_WEIGHTS } : W;
  const paceMin = f > 0.02 ? (p.toi / 60) / f : (Wp.toiBase ?? 15);
  const toiPace = Math.max(-.15, Math.min(.3, (paceMin - (Wp.toiBase ?? 15)) * Wp.toi));
  return (p.raw - toiNow) + f * toiPace + (1 - f) * typical;
}

// ---------- Shared bits ----------
function chip(r, isStar){ return `<span class="chip ${band(r)}" aria-label="Rating ${fmt(r)}">${fmt(r)}${isStar ? '<span class="star-mark" aria-hidden="true">★</span>' : ""}</span>`; }
function avatar(pl, size, isStar){ return `<span class="av${size ? " " + size : ""} side${pl.side}"><span class="face" aria-hidden="true">${initials(pl.name)}${mug(pl.id)}</span>${chip(pl.rating, isStar)}</span>`; }

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
  const fv = favGame(s);
  return `<button type="button" class="gchip${has ? "" : " future"}${fv ? " favg" : ""}" data-g="${s.id}" aria-current="${s.id === current}">${fv ? `<span class="fav-mark" title="Your team" aria-label="Your team">★</span>` : ""}
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
  strip.innerHTML = n ? favOrder(SCHED.games).map(gameChip).join("") : `<div class="muted" style="padding:8px 2px">No NHL games on this date.</div>`;
  $("next-day").disabled = viewDate >= shiftDate(SCHED.today, 1);
  $("today-btn").hidden = viewDate === SCHED.today;
  const anyLive = SCHED.games.some(g => live(g.st));
  $("updated").innerHTML = lastUpdated ? `${anyLive ? '<span class="live-tag"><i aria-hidden="true"></i>Live</span> · ' : ""}Updated ${lastUpdated.toLocaleTimeString([], { hour:"numeric", minute:"2-digit" })}` : "";
}
function renderBest(){
  const all = [];
  dayGames().forEach(g => (RATED[g.id] || []).forEach(p => { if(p.rating != null) all.push({ ...p, g }); }));
  $("best").hidden = !all.length;
  sideVisibility();
  if(!all.length) return;
  all.sort((a,b) => b.rating - a.rating || b.raw - a.raw);
  const nLive = dayGames().filter(g => live(g.st)).length;
  $("best-h").textContent = nLive ? "Best performances so far" : "Best performances";
  $("best-sub").textContent = `${tinyDay(viewDate)} · ${dayGames().length} game${dayGames().length === 1 ? "" : "s"}${nLive ? ` · ${nLive} live` : ""}`;
  $("best-list").innerHTML = all.slice(0, BEST_N).map((p,i) => {
    const opp = p.g.t[1-p.side].ab;
    return `<li><button type="button" data-g="${p.g.id}" data-p="${p.id}">
      <span class="rk">${i+1}</span><span class="av sm side${p.side}"><span class="face" aria-hidden="true">${initials(p.name)}${mug(p.id)}</span></span>
      <span class="who"><b>${esc(p.name)}</b><span>${logo(p.g.t[p.side].ab)}${esc(p.g.t[p.side].ab)} ${p.side === 0 ? "at" : "vs"} ${esc(opp)} · ${esc(p.line)}</span></span>
      ${chip(p.rating)}</button></li>`;
  }).join("");
  fadeEnd($("best-list"));
}

// ---------- Best of the week (Monday to Sunday) and of the month, for the date being viewed ----------
const mondayOf = d => { const x = new Date(d + "T12:00:00Z"), dow = (x.getUTCDay() + 6) % 7; return shiftDate(d, -dow); };
const monthEnd = d => { const [y, m] = d.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const PERIODS = {
  week:  { box: "wbest", range: d => { const a = mondayOf(d); return [a, shiftDate(a, 6)]; } },
  month: { box: "mbest", range: d => [d.slice(0, 8) + "01", monthEnd(d)] }
};
const PER = { week: { key: null, rows: null, games: 0 }, month: { key: null, rows: null, games: 0 } };
const BEST_N = 25;
// Each day's stats are fetched once and shared by the week and month cards; recent days are refetched every 10 minutes
const DAYS = new Map();
function dayStats(d){
  const c = DAYS.get(d), recent = d >= shiftDate(SCHED.today, -1);
  if(c && (!recent || Date.now() - c.at < 10 * 60 * 1000)) return c.p;
  const p = api(`/api/day-stats?date=${d}`).catch(() => { DAYS.delete(d); return null; });
  DAYS.set(d, { at: Date.now(), p });
  return p;
}
async function pooled(items, n, fn){
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while(i < items.length){ const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
function sideVisibility(){
  const show = ["myteams", "following", "best", "wbest", "totw", "mbest"].some(id => !$(id).hidden);
  document.querySelector(".scores-grid").classList.toggle("solo", !show);
}
function loadWeek(){ loadPeriod("week"); loadPeriod("month"); }
async function loadPeriod(k){
  if(!viewDate || !SCHED) return;
  const [a, b] = PERIODS[k].range(viewDate), today = SCHED.today;
  const days = []; for(let d = a; d <= b && d <= today; d = shiftDate(d, 1)) days.push(d);
  if(PER[k].key !== a) PER[k] = { key: a, rows: null, games: 0 };
  const res = await pooled(days, 6, d => dayStats(d).then(j => j && { d, j }));
  if(PER[k].key !== a) return;   // the user moved to another week or month meanwhile
  const rows = []; let games = 0;
  res.forEach(r => { if(!r) return; games += r.j.games || 0;
    (r.j.sk || []).forEach(x => { if(x[4] != null) rows.push({ id:x[0], name:x[1], team:x[2], pos:x[3], raw:x[4], grp: E.grpOf(x[3]), d:r.d, gid:x[17], opp:x[18], line:`${x[6]}G ${x[7]}A · ${E.fmtToi(x[5])}` }); });
    (r.j.go || []).forEach(x => { if(x[4] != null) rows.push({ id:x[0], name:x[1], team:x[2], pos:"G", raw:x[4], grp:"G", d:r.d, gid:x[13], opp:x[14], line:`${x[11]}/${x[10]} saves${x[12] === "W" ? " · W" : ""}` }); });
  });
  PER[k] = { key: a, rows, games };
  renderPeriod(k);
}
// Scrolling lists fade at the bottom until you reach the end
const fadeEnd = el => el && el.classList.toggle("end", el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
document.addEventListener("scroll", e => { if(e.target.matches && e.target.matches(".best ol")) fadeEnd(e.target); }, true);
function renderWeekBest(){ renderPeriod("week"); renderPeriod("month"); }
function renderPeriod(k){
  if(k === "week") queueMicrotask(renderTotw);
  const id = PERIODS[k].box, box = $(id), P = PER[k];
  if(!P.rows || !CALS || view !== "scores"){ box.hidden = true; sideVisibility(); return; }
  const all = P.rows.map(r => ({ ...r, rating: E.calibrate(r.raw, CALS[r.grp], SCALE).rating })).sort((a,b) => b.rating - a.rating || b.raw - a.raw);
  box.hidden = !all.length; sideVisibility();
  if(!all.length) return;
  const [a, b] = PERIODS[k].range(P.key), soFar = b >= SCHED.today ? " so far" : "", n = `${P.games} game${P.games === 1 ? "" : "s"}${soFar}`;
  const wd = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", k === "week" ? { weekday:"short", timeZone:"UTC" } : { month:"short", day:"numeric", timeZone:"UTC" });
  $(id + "-sub").textContent = k === "week" ? `${tinyDay(a)} – ${tinyDay(b)} · ${n}`
    : `${new Date(a + "T12:00:00Z").toLocaleDateString("en-US", { month:"long", year:"numeric", timeZone:"UTC" })} · ${n}`;
  const list = $(id + "-list"); list.scrollTop = 0;
  list.innerHTML = all.slice(0, BEST_N).map((p,i) => `<li><button type="button" data-g="${p.gid}" data-p="${p.id}" data-date="${p.d}">
      <span class="rk">${i+1}</span><span class="av sm"><span class="face" aria-hidden="true">${initials(p.name)}${mug(p.id)}</span></span>
      <span class="who"><b>${esc(p.name)}</b><span>${logo(p.team)}${esc(p.team)} vs ${esc(p.opp)} · ${wd(p.d)} · ${esc(p.line)}</span></span>
      ${chip(p.rating)}</button></li>`).join("");
  fadeEnd(list);
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
  const tabs = [["ratings","Player ratings"],["stats","Team stats"],["lines","Lines"],["map","Shot map"],["goals",`Goals (${g.gl.length})`]];
  host.innerHTML = `<article class="card game">
    <div class="board">
      <div class="meta"><span>${esc(shortDay(g.d))}</span><span>${esc(g.v)}</span></div>
      <div class="score">
        <div class="team away">${logo(A.ab, "big")}<span class="abbr">${esc(A.ab)}</span><span class="nm">${esc(A.nm)}</span></div>
        <div><div class="final"><span class="${win === 1 ? "lose" : ""}">${A.sc}</span><span class="dash">–</span><span class="${win === 0 ? "lose" : ""}">${H.sc}</span></div><div class="status">${status}</div></div>
        <div class="team home">${logo(H.ab, "big")}<span class="abbr">${esc(H.ab)}</span><span class="nm">${esc(H.nm)}</span></div>
      </div>
      <div class="xg-line">Expected goals <b class="mono">${xg(0).toFixed(2)}</b> – <b class="mono">${xg(1).toFixed(2)}</b>
        <span class="xg-src">${g.xs === "moneypuck" ? `xG from <a href="https://moneypuck.com" target="_blank" rel="noopener">MoneyPuck.com</a>` : fin ? "Live-model xG · MoneyPuck's numbers arrive overnight" : "Live-model xG"}</span></div>
      ${fin ? "" : wpLine(g)}
      <div class="periods"><table aria-label="Goals by period">
        <thead><tr><th></th>${perHead.map(h => `<th>${h}</th>`).join("")}${so ? "<th>SO</th>" : ""}<th>T</th><th>SOG</th></tr></thead>
        <tbody>${[0,1].map(s => `<tr><td>${esc(g.t[s].ab)}</td>${per[s].map(v => `<td>${v}</td>`).join("")}${so ? `<td>${s === win ? 1 : 0}</td>` : ""}<td class="tot">${g.t[s].sc}</td><td class="tot">${g.t[s].sog}</td></tr>`).join("")}</tbody>
      </table></div>
    </div>
    <div class="tabs" role="tablist">${tabs.map(([k,l]) => `<button type="button" role="tab" data-gtab="${k}" aria-selected="${gameTab === k}">${l}</button>`).join("")}</div>
    <div class="panel" role="tabpanel">${gameTab === "ratings" ? ratingsPanel(g, R, fin) : gameTab === "stats" ? statsPanel(g) : gameTab === "lines" ? linesPanel(g) : gameTab === "map" ? mapPanel() : goalsPanel(g)}</div>
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
let advForPreview = false;
function previewCard(s){
  const P = PREVIEWS.get(s.id);
  if(!ADV && !advForPreview){ advForPreview = true; loadADV().then(() => { if(view === "scores") renderGame(); }); }
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
    ${formSec(T)}${goalieSec(T)}${teamStatsSec(T)}${hotSec(d)}${h2hSec(s.t[0].ab, s.t[1].ab, s.id, () => { if(view === "scores" && current === s.id) renderGame(); })}
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
      <div class="top-line"><button type="button" class="gname" data-player="${g.id}"><span class="av md"><span class="face" aria-hidden="true">${initials(g.name)}${mug(g.id)}</span></span>${esc(g.name)}${g.num != null ? ` <span class="muted">#${g.num}</span>` : ""}</button><span class="gtm">${logo(t.ab)}${esc(t.ab)}</span></div>
      <div class="nums"><div><b>${esc(g.rec || "–")}</b><span>Record</span></div><div><b>${svp(g.svp)}</b><span>Save %</span></div><div><b>${g.gaa == null ? "–" : g.gaa.toFixed(2)}</b><span>GAA</span></div><div><b>${g.gp}</b><span>Games</span></div></div>
      ${goalieForm(g)}
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
  const pl = (x, cls) => x ? `<button type="button" class="pl ${cls}" data-player="${x.id}">${cls === "h" ? `<span class="n">${esc(x.name)}</span><span class="av sm"><span class="face" aria-hidden="true">${initials(x.name)}${mug(x.id)}</span></span><span class="val">${x.val}</span>` : `<span class="val">${x.val}</span><span class="av sm"><span class="face" aria-hidden="true">${initials(x.name)}${mug(x.id)}</span></span><span class="n">${esc(x.name)}</span>`}</button>` : "<span></span>";
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
  return stars + fanVoteSec(g, R) + `<div class="lineups">${[0,1].map(side => {
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
  const again = () => { if(view === "scores" && current === g.id && gameTab === "stats") renderGame(); };
  return wpChart(g) + `<div class="tstats"><div class="ts-key"><span><i style="background:var(--away)"></i>${esc(g.t[0].ab)}</span><span>${esc(g.t[1].ab)}<i style="background:var(--home)"></i></span></div>` +
    rows.map(([n,a,b,d]) => { const tot = a + b || 1;
      return `<div class="ts-row"><span class="v${a > b ? " lead" : ""}">${a.toFixed(d)}</span><span class="nm">${n}</span><span class="v r${b > a ? " lead" : ""}">${b.toFixed(d)}</span>
        <span class="bar" aria-hidden="true"><i class="a" style="width:${(a/tot*100).toFixed(1)}%"></i><i class="h" style="width:${(b/tot*100).toFixed(1)}%"></i></span></div>`; }).join("") + `</div>` + h2hSec(g.t[0].ab, g.t[1].ab, g.id, again);
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
      bd += `<div class="bd-top"><b>${pl.raw > cal.q[200] ? `Best ${who} game of the season` : `Better than ${ord(pl.pct)}% of ${who} games`}</b><span class="bd-acts"><button type="button" class="link-btn" data-share="${pl.id}">Share ↗</button><button type="button" class="link-btn" data-player="${pl.id}">View profile →</button></span></div>
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
  $("scale-formula").textContent = `${c.toFixed(1)} + ${s.toFixed(2)} × z up to z = ${SCALE.knee}, then ${SCALE.top} per step of z after that`;
  const pct = v => v >= 99.95 ? "99.9" : v >= 99 ? v.toFixed(1) : String(Math.round(v));
  const rows = [`<tr><td class="mono">${c.toFixed(1)}</td><td>Half of all games at his position</td><td>The typical game</td></tr>`];
  [7,8,9,9.5,10].forEach(r => { if(r <= c + 0.05) return; const z = E.zForRating(r, SCALE), share = 1 - E.normCdf(z);
    const often = r === 10 ? "Only a handful of games a season" : r === 9.5 ? "About 1 in 2,000 games" : `About 1 in ${Math.max(2, Math.round(1/share)).toLocaleString()} games`;
    rows.push(`<tr><td class="mono">${r === 10 ? "10.0" : r.toFixed(1) + "+"}</td><td>${r === 10 ? "99.99" : pct(E.normCdf(z)*100)}%</td><td>${often}</td></tr>`); });
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
  const tabs = [["profile","Profile"],["stats","Stats"],["games",`Games${p.games.length ? ` (${p.games.length})` : ""}`],["career","Career"]];
  if(playerTab === "stats" && (!LS || !ADV)) Promise.all([loadLS(), loadADV()]).then(() => { if(view === "player" && playerTab === "stats" && PLAYER === p) renderPlayer(); });
  host.innerHTML = `<button type="button" class="back" data-back>← Back</button>
  <article class="card">
    <div class="p-hero">
      <div class="p-head">
        <span class="av xl" style="--team:var(--accent)"><span class="face" aria-hidden="true">${initials(name)}${mug(p.id)}</span>${avg != null ? chip(avg) : ""}</span>
        <div><h1>${esc(name)}</h1><div class="sub">${p.active ? logo(p.team) : ""}${esc(sub)}</div></div>
        <span class="p-acts"><button type="button" class="pill-btn follow-btn${isFollowing(p.id) ? " on" : ""}" data-follow aria-pressed="${isFollowing(p.id)}">${isFollowing(p.id) ? "★ Following" : "☆ Follow"}</button><button type="button" class="pill-btn cmp-btn" data-compare="${p.id}">Compare</button></span>
      </div>
      ${p.active || curTot.gp ? `<div class="p-quick" aria-label="${seasonLabel(p.season)} season">${quick.map(([v,l]) => `<div><b>${v}</b><span>${l}</span></div>`).join("")}<div><b style="font-size:14px;font-family:var(--f-body);color:var(--muted)">${seasonLabel(p.season)}</b><span>Season</span></div></div>` : ""}
      <div class="tabs" role="tablist">${tabs.map(([k,l]) => `<button type="button" role="tab" data-ptab="${k}" aria-selected="${playerTab === k}">${l}</button>`).join("")}</div>
    </div>
    <div class="panel" role="tabpanel">${playerTab === "profile" ? profilePanel(p) : playerTab === "stats" ? playerStatsPanel(p) : playerTab === "games" ? gamesPanel(p, avg) : careerPanel(p)}</div>
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
  return `${ratingTrend(p)}<dl class="facts">${facts.map(([k,v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>${contract}`;
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
  return sum + ratingTrend(p) + `<div class="tbl-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
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
  results.innerHTML = list.length ? list.map((p,i) => `<li><button type="button" role="option" data-player="${p.id}" id="opt-${i}"><span class="rname"><span class="av sm"><span class="face" aria-hidden="true">${initials(p.name)}${mug(p.id)}</span></span>${esc(p.name)}</span><span class="meta">${p.team ? logo(p.team) : ""}${esc([p.pos, p.team].filter(Boolean).join(" · "))}${p.active ? "" : " · Retired"}</span></button></li>`).join("")
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
  ["scores","player","about","standings","stats","teams","account"].forEach(k => $("view-" + k).hidden = k !== v);
  document.querySelectorAll(".nav button").forEach(b => b.setAttribute("aria-current", b.dataset.view === v ? "page" : "false"));
  if(push) try { history.pushState({ view: v, id }, ""); } catch(e){}
  if(v === "about") renderAbout();
  if(v === "standings") loadStandings();
  if(v === "stats") loadStats();
  if(v === "teams") loadTeams();
  if(v === "account") renderAccount();
}
window.addEventListener("popstate", e => {
  const s = e.state || { view: "scores" };
  if(s.view === "player" && s.id) openPlayer(s.id, { push:false });
  else { if(s.view === "teams") teamDetail = s.team || null; setView(s.view || "scores", { push:false }); if(SCHED && (s.view || "scores") === "scores") renderScores(); }
});

// ---------- Standings ----------
let STAND = null, standTab = "division", standSort = null, standAt = 0;
const STAND_COLS = [
  ["gp","GP",-1], ["w","W",-1], ["l","L",1], ["otl","OTL",1], ["pts","PTS",-1], ["pct","P%",-1],
  ["rw","RW",-1,"hide-sm"], ["gf","GF",-1,"hide-sm"], ["ga","GA",1,"hide-sm"], ["diff","DIFF",-1,"hide-sm"], ["l10","L10",0,"hide-md"], ["strk","STRK",0,"hide-md"]
];
const CLINCH = { x:"Clinched playoff spot", y:"Clinched division", z:"Clinched conference", p:"Won Presidents' Trophy", e:"Eliminated" };
async function loadStandings(){
  const host = $("view-standings");
  if(STAND && Date.now() - standAt < 5*60*1000){ renderStandings(); return; }
  if(!STAND) host.innerHTML = `<div class="card loading">Loading standings…</div>`;
  try { STAND = await api("/api/league?view=standings"); standAt = Date.now(); renderStandings(); }
  catch(e){ if(!STAND) host.innerHTML = `<div class="card empty-card">${esc(e.message)}</div>`; }
}
function standTable(rows, { title = "", seqKey = "leagueSeq", cut = 0, startRank = 1, sortable = true } = {}){
  let list = [...rows].sort((a,b) => a[seqKey] - b[seqKey]);
  if(sortable && standSort){ const c = STAND_COLS.find(c => c[0] === standSort.k); if(c && c[2]) list.sort((a,b) => (b[standSort.k] - a[standSort.k]) * (standSort.d) || a[seqKey] - b[seqKey]); }
  const head = `<tr><th class="l rk">#</th><th class="l">${esc(title || "Team")}</th>${STAND_COLS.map(([k,l,dir,cls]) => `<th class="${cls || ""}">${dir && sortable ? `<button type="button" class="sort" data-ssort="${k}" aria-pressed="${standSort?.k === k}">${l}${standSort?.k === k ? (standSort.d > 0 ? " ↓" : " ↑") : ""}</button>` : l}</th>`).join("")}</tr>`;
  const body = list.map((t,i) => `<tr class="${cut && i === cut - 1 ? "cut" : ""}"><td class="l rk">${startRank + i}</td>
    <td class="l"><span class="tcell tlink" data-team="${esc(t.ab)}">${logo(t.ab)}<span class="tname"><span class="full">${esc(t.name)}</span><span class="abv">${esc(t.ab)}</span></span>${t.clinch ? `<span class="clinch" title="${esc(CLINCH[t.clinch] || "")}">${esc(t.clinch)}</span>` : ""}</span></td>
    ${STAND_COLS.map(([k,,,cls]) => `<td class="${cls || ""}${k === "pts" ? " pts" : ""}">${k === "pct" ? t.pct.toFixed(3).replace(/^0/, "") : k === "diff" ? (t.diff > 0 ? "+" : "") + t.diff : esc(t[k])}</td>`).join("")}</tr>`).join("");
  return `<div class="tbl-wrap"><table class="data stand"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}
function bracketSide(conf){
  const T = STAND.teams.filter(t => t.conf === conf);
  const divs = [...new Set(T.map(t => t.div))];
  const top = d => T.filter(t => t.div === d).sort((a,b) => a.divSeq - b.divSeq);
  const wc = T.filter(t => t.wcSeq > 0).sort((a,b) => a.wcSeq - b.wcSeq);
  const [A, B] = divs.map(top);
  if(!A || !B || A.length < 3 || B.length < 3 || wc.length < 2) return "";
  const aBetter = A[0].confSeq < B[0].confSeq;
  const side = (D, wcTeam, wcLbl, dn) => [[D[0], `${dn} 1`, wcTeam, wcLbl], [D[1], `${dn} 2`, D[2], `${dn} 3`]];
  const ups = [...side(A, aBetter ? wc[1] : wc[0], aBetter ? "WC 2" : "WC 1", A[0].div), ...side(B, aBetter ? wc[0] : wc[1], aBetter ? "WC 1" : "WC 2", B[0].div)];
  const line = (t, s) => `<div class="mu-team">${logo(t.ab)}<span class="seed">${esc(s)}</span><span class="nm">${esc(t.short || t.ab)}</span><b>${t.pts}</b></div>`;
  return `<section class="bracket-conf"><h3>${esc(conf)} Conference</h3><div class="mu-grid">${ups.map(([a, sa, b, sb]) => `<div class="mu">${line(a, sa)}${line(b, sb)}</div>`).join("")}</div></section>`;
}
function renderStandings(){
  const host = $("view-standings"), T = STAND.teams;
  const tabs = [["division","Division"],["conference","Conference"],["league","League"],["playoffs","Playoffs"]];
  const confs = [...new Set(T.map(t => t.conf))].sort();
  let body = "";
  if(standTab === "division"){
    body = confs.map(c => [...new Set(T.filter(t => t.conf === c).map(t => t.div))].sort().map(d =>
      `<section class="card stand-card"><h2>${esc(d)} <span class="muted">· ${esc(c)}</span></h2>${standTable(T.filter(t => t.div === d), { title: d, seqKey: "divSeq", cut: 3 })}</section>`).join("")).join("");
    body = `<div class="stand-grid">${body}</div>`;
  } else if(standTab === "conference"){
    body = `<div class="stand-grid">${confs.map(c => `<section class="card stand-card"><h2>${esc(c)} Conference</h2>${standTable(T.filter(t => t.conf === c), { title: c, seqKey: "confSeq" })}</section>`).join("")}</div>`;
  } else if(standTab === "league"){
    body = `<section class="card stand-card"><h2>NHL</h2>${standTable(T, { seqKey: "leagueSeq" })}</section>`;
  } else {
    body = `<section class="card stand-card"><h2>If the playoffs started today</h2><p class="muted small">The top three in each division make it, plus two wild cards per conference. The better division winner plays the second wild card.</p><div class="bracket">${confs.map(bracketSide).join("")}</div></section>` +
      `<div class="stand-grid">${confs.map(c => { const C = T.filter(t => t.conf === c), divs = [...new Set(C.map(t => t.div))].sort();
        return `<section class="card stand-card"><h2>${esc(c)} wild card</h2>${divs.map(d => standTable(C.filter(t => t.div === d && t.wcSeq === 0), { title: d, seqKey: "divSeq", sortable: false })).join("")}${standTable(C.filter(t => t.wcSeq > 0), { title: "Wild card", seqKey: "wcSeq", cut: 2, sortable: false })}</section>`; }).join("")}</div>`;
  }
  const legend = T.some(t => t.clinch) ? `<p class="muted small legend">${Object.entries(CLINCH).filter(([k]) => T.some(t => t.clinch === k)).map(([k,v]) => `<b>${k}</b> ${v}`).join(" · ")}</p>` : "";
  host.innerHTML = `<div class="page-head"><h1>Standings</h1><div class="seg" role="tablist">${tabs.map(([k,l]) => `<button type="button" role="tab" data-stab="${k}" aria-selected="${standTab === k}">${l}</button>`).join("")}</div></div>
    ${body}${legend}<p class="muted small">P% is points percentage. RW is regulation wins, the first tiebreaker. Tap a column to sort. ${standTab === "division" ? "The line marks the top three, who qualify for the playoffs." : ""}</p>`;
}

// ---------- League stats ----------
let LEAD = null, ADV = null, LS = null, statsTab = "ratings", advPos = "all", statsAt = 0;
let statsDetail = null, detailPos = "all", detailN = 50;
const fmtToiPG = v => `${Math.floor(v/60)}:${String(Math.round(v%60)).padStart(2,"0")}`;
const f3 = v => v.toFixed(3).replace(/^0/, ""), fPct = v => (v*100).toFixed(1) + "%", fSgn = v => (v > 0 ? "+" : "") + v.toFixed(2), f2 = v => v.toFixed(2), fPm = v => (v > 0 ? "+" : "") + v;
const SK_F = ["id","name","team","pos","gp","g","a","p","pm","pim","ppg","ppp","shg","shp","gwg","sog","shPct","toi","fo","fot","hits","blk","tk","gv"];
const GO_F = ["id","name","team","gp","gs","w","l","otl","sa","sv","ga","svp","gaa","so","toi"];
const toObj = (F, r) => Object.fromEntries(F.map((k,i) => [k, r[i]]));
let LS_P = null, ADV_P = null;
function loadLS(){ return LS_P ||= api("/api/league?view=stats").then(j => { LS = { sk: j.skaters.map(r => toObj(SK_F, r)), go: j.goalies.map(r => toObj(GO_F, r)) }; return LS; }).catch(e => { LS = { error: e.message }; LS_P = null; return LS; }); }
function loadADV(){ return ADV_P ||= api("/api/season-stats").then(j => (ADV = j)).catch(e => { ADV = { error: e.message }; ADV_P = null; return ADV; }); }
async function loadStats(){
  const host = $("view-stats");
  if(!LEAD) host.innerHTML = `<div class="card loading">Loading league stats…</div>`;
  if(LEAD && Date.now() - statsAt < 10*60*1000){ renderStats(); }
  else {
    try { LEAD = await api("/api/league?view=leaders"); statsAt = Date.now(); renderStats(); }
    catch(e){ if(!LEAD){ host.innerHTML = `<div class="card empty-card">${esc(e.message)}</div>`; return; } }
  }
  loadLS().then(() => { if(view === "stats") renderStats(); });
  loadADV().then(() => { if(view === "stats") renderStats(); });
}
// Qualifiers for rate stats, scaled to how far into the season we are
const qualSk = arr => Math.max(1, Math.ceil(Math.max(1, ...arr.map(p => p.gp)) * 0.4));
const qualGo = arr => Math.max(1, Math.ceil(Math.max(1, ...arr.map(p => p.gp)) * 0.3));
const rankList = (arr, key, { min = () => true, asc = false, sub } = {}) =>
  arr.filter(p => p[key] != null && !Number.isNaN(p[key]) && min(p)).sort((a,b) => asc ? a[key] - b[key] : b[key] - a[key]).map(p => ({ ...p, v: p[key], sub: sub ? sub(p) : "" }));
// Every category: title, formatter, note, official top-10 key (if any), and a full ranked list
function statCats(tab){
  if(tab === "ratings"){
    if(!ADV || ADV.error) return [];
    const S = ADV.skaters, G = ADV.goalies.map(g => ({ ...g, pos:"G" })), q = qualSk(S), gq = qualGo(ADV.goalies);
    const both = [...S, ...G], hq = Math.max(6, q);
    const topSub = p => p.top ? `${p.top[3] ? `vs ${p.top[3]} · ` : ""}${tinyDay(p.top[1])}` : "";
    return [
      { key:"rF", title:"Forwards", chip:true, nopos:true, note:`Average Puck Rating this season. Minimum ${q} game${q === 1 ? "" : "s"}.`, list: () => rankList(S.filter(p => p.pos !== "D"), "rating", { min: p => p.rated >= q, sub: p => `${p.rated} GP` }) },
      { key:"rD", title:"Defensemen", chip:true, nopos:true, note:`Average Puck Rating this season. Minimum ${q} game${q === 1 ? "" : "s"}.`, list: () => rankList(S.filter(p => p.pos === "D"), "rating", { min: p => p.rated >= q, sub: p => `${p.rated} GP` }) },
      { key:"rG", title:"Goalies", chip:true, nopos:true, note:`Average Puck Rating this season. Minimum ${gq} game${gq === 1 ? "" : "s"}.`, list: () => rankList(G, "rating", { min: p => p.rated >= gq, sub: p => `${p.rated} GP` }) },
      { key:"rTop", title:"Best single game", chip:true, nopos:true, note:"Each player's highest game rating this season.", list: () => rankList(both.map(p => ({ ...p, topR: p.top ? p.top[0] : null })), "topR", { sub: topSub }) },
      { key:"rHot", title:"Heating up", fmt:fSgn, nopos:true, note:`Average of the last 5 games compared with the season average. Minimum ${hq} rated games.`, list: () => rankList(both.filter(p => p.l5 != null && p.rating != null && p.rated >= hq).map(p => ({ ...p, hot: Math.round((p.l5 - p.rating) * 100) / 100 })), "hot", { min: p => p.hot > 0, sub: p => `Last 5 ${p.l5.toFixed(2)} · season ${p.rating.toFixed(2)}` }) },
      { key:"rCold", title:"Cooling off", fmt:fSgn, nopos:true, note:`Average of the last 5 games compared with the season average. Minimum ${hq} rated games.`, list: () => rankList(both.filter(p => p.l5 != null && p.rating != null && p.rated >= hq).map(p => ({ ...p, hot: Math.round((p.l5 - p.rating) * 100) / 100 })), "hot", { asc: true, min: p => p.hot < 0, sub: p => `Last 5 ${p.l5.toFixed(2)} · season ${p.rating.toFixed(2)}` }) },
      { key:"rHi", title:"Most 8+ games", nopos:true, note:"Games rated 8.0 or better this season.", list: () => rankList(both, "hi", { min: p => p.hi > 0, sub: p => `${p.rated} GP` }) }
    ];
  }
  if(tab === "advanced"){
    if(!ADV || ADV.error) return [];
    const S = ADV.skaters, G = ADV.goalies, q = qualSk(S), gq = qualGo(G), qual = `Minimum ${q} game${q === 1 ? "" : "s"}.`;
    return [
      { key:"rating", title:"Average Puck Rating", fmt:f2, pos:true, note:`This site's 0–10 game rating, averaged. ${qual}`, list: () => rankList(S, "rating", { min: p => p.rated >= q, sub: p => `${p.rated} GP` }) },
      { key:"ixg", title:"Expected goals", fmt:f2, pos:true, note:"Goals an average shooter would score from his shots (MoneyPuck.com's model for finished games).", list: () => rankList(S, "ixg", { sub: p => `${p.g} G` }) },
      { key:"gax", title:"Goals above expected", fmt:fSgn, pos:true, note:"Goals minus expected goals (empty-net goals left out). Finishing talent, or a hot streak.", list: () => rankList(S, "gax", { sub: p => `${p.g} G on ${p.ixg.toFixed(1)} xG` }) },
      { key:"xgPct", title:"5-on-5 expected goal share", fmt:fPct, pos:true, note:`Of the expected goals at 5-on-5 while he's on the ice, the share his team creates. 50% is even. ${qual}`, list: () => rankList(S, "xgPct", { min: p => p.gp >= q && p.xgf5 + p.xga5 >= 1 }) },
      { key:"cfPct", title:"5-on-5 shot attempt share", fmt:fPct, pos:true, note:`Corsi: share of all shot attempts at 5-on-5 while he's on the ice. ${qual}`, list: () => rankList(S, "cfPct", { min: p => p.gp >= q }) },
      { key:"hd", title:"High-danger chances", fmt:null, pos:true, note:"Unblocked shots from the slot and crease, where most goals come from.", list: () => rankList(S, "hd") },
      { key:"p60", title:"Points per 60 minutes", fmt:f2, pos:true, note:`Scoring rate by ice time, all situations. ${qual}, 10+ minutes a game.`, list: () => rankList(S, "p60", { min: p => p.gp >= q && p.toi >= p.gp * 600, sub: p => `${p.p} P` }) },
      { key:"icf", title:"Shot attempts", fmt:null, pos:true, note:"Every shot he tried: on goal, missed or blocked.", list: () => rankList(S, "icf") },
      { key:"gsax", title:"Goals saved above expected", fmt:fSgn, goalie:true, note:"Expected goals against minus goals allowed. The best single measure of a goalie's work.", list: () => rankList(G, "gsax", { sub: p => `${p.gp} GP` }) },
      { key:"hdsv", title:"High-danger save %", fmt:f3, goalie:true, note:`Save % on chances from the slot and crease. Minimum ${gq} games.`, list: () => rankList(G, "hdsv", { min: p => p.gp >= gq, sub: p => `${p.hdf} faced` }) },
      { key:"grating", title:"Average Puck Rating (goalies)", fmt:f2, goalie:true, note:`This site's game rating for goalies, averaged. Minimum ${gq} games.`, list: () => rankList(G, "rating", { min: p => p.rated >= gq, sub: p => `${p.rated} GP` }) }
    ];
  }
  const S = LS && !LS.error ? LS.sk : null, G = LS && !LS.error ? LS.go : null;
  if(tab === "skaters"){
    const q = S ? qualSk(S) : 1, foMin = S ? Math.max(20, 6 * q) : 20;
    const L = (key, opts) => () => S ? rankList(S, key, opts) : null;
    return [
      { key:"points", title:"Points", lead:"points", pos:true, list: L("p") },
      { key:"goals", title:"Goals", lead:"goals", pos:true, list: L("g") },
      { key:"assists", title:"Assists", lead:"assists", pos:true, list: L("a") },
      { key:"plusMinus", title:"Plus/minus", lead:"plusMinus", fmt:fPm, pos:true, list: L("pm") },
      { key:"goalsPp", title:"Power-play goals", lead:"goalsPp", pos:true, list: L("ppg") },
      { key:"ppp", title:"Power-play points", pos:true, list: L("ppp") },
      { key:"goalsSh", title:"Shorthanded goals", lead:"goalsSh", pos:true, list: L("shg") },
      { key:"sog", title:"Shots on goal", pos:true, list: L("sog") },
      { key:"shPct", title:"Shooting %", fmt:fPct, pos:true, note:`Minimum ${Math.max(10, 3*q)} shots.`, list: L("shPct", { min: p => p.sog >= Math.max(10, 3*q) }) },
      { key:"toi", title:"Ice time per game", lead:"toi", fmt:fmtToiPG, pos:true, note:`Minimum ${q} games.`, list: L("toi", { min: p => p.gp >= q }) },
      { key:"faceoffLeaders", title:"Faceoff win %", lead:"faceoffLeaders", fmt:fPct, pos:true, note:`Minimum ${foMin} faceoffs.`, list: L("fo", { min: p => (p.fot ?? 0) >= foMin, sub: p => `${p.fot} taken` }) },
      { key:"hits", title:"Hits", pos:true, list: L("hits") },
      { key:"blk", title:"Blocked shots", pos:true, list: L("blk") },
      { key:"tk", title:"Takeaways", pos:true, list: L("tk") },
      { key:"penaltyMins", title:"Penalty minutes", lead:"penaltyMins", pos:true, list: L("pim") }
    ];
  }
  const gq = G ? qualGo(G) : 1;
  const L = (key, opts) => () => G ? rankList(G, key, opts) : null;
  return [
    { key:"wins", title:"Wins", lead:"wins", list: L("w") },
    { key:"savePctg", title:"Save %", lead:"savePctg", fmt:f3, note:`Minimum ${gq} games.`, list: L("svp", { min: p => p.gp >= gq }) },
    { key:"goalsAgainstAverage", title:"Goals-against average", lead:"goalsAgainstAverage", fmt:f2, note:`Lower is better. Minimum ${gq} games.`, list: L("gaa", { min: p => p.gp >= gq, asc: true }) },
    { key:"shutouts", title:"Shutouts", lead:"shutouts", list: L("so") },
    { key:"saves", title:"Saves", list: L("sv") },
    { key:"gp", title:"Games played", list: L("gp") }
  ];
}
function leaderCard(c, rows){
  if(!rows || !rows.length) return "";
  const canAll = !!c.list && !!c.list();
  return `<section class="card lcard"><h3>${esc(c.title)}</h3>${c.note ? `<p class="lnote">${c.note}</p>` : ""}<ol>${rows.slice(0, 10).map((p,i) => `<li class="${i ? "" : "first"}"><button type="button" data-player="${p.id}">
    <span class="rk">${i+1}</span><span class="av ${i ? "sm" : "md"}"><span class="face" aria-hidden="true">${initials(p.name)}${mug(p.id)}</span></span>
    <span class="who"><b>${esc(p.name)}</b><span>${logo(p.team)}${esc(p.team)}${p.pos ? ` · ${esc(p.pos)}` : ""}${p.sub ? ` · ${esc(p.sub)}` : ""}</span></span>
    <span class="val">${c.chip ? chip(p.v) : c.fmt ? c.fmt(p.v) : esc(p.v)}</span></button></li>`).join("")}</ol>
    ${canAll ? `<button type="button" class="more-btn see-all" data-seeall="${c.key}">See all</button>` : ""}</section>`;
}
function catTop(c){
  if(c.lead && LEAD?.[statsTab]?.[c.lead]?.length) return LEAD[statsTab][c.lead];
  const all = c.list(); if(!all) return null;
  return all.filter(p => c.goalie || advPos === "all" || statsTab !== "advanced" || (advPos === "D" ? p.pos === "D" : p.pos !== "D"));
}
function renderStats(){
  const host = $("view-stats");
  if(statsDetail){ renderStatsDetail(); return; }
  const tabs = [["ratings","Puck Ratings"],["skaters","Skaters"],["goalies","Goalies"],["advanced","Advanced"],["compare","Compare"]];
  let body = "";
  if(statsTab === "compare") body = renderCompare();
  else if(statsTab === "ratings"){
    if(!ADV) body = `<div class="card loading">Crunching every game this season…</div>`;
    else if(ADV.error) body = `<div class="card empty-card">${esc(ADV.error)}</div>`;
    else body = `<div class="lgrid">${statCats("ratings").map(c => leaderCard(c, catTop(c))).join("")}</div>
      <p class="muted small">Every player's game ratings this season, from ${ADV.games} games. Each game is rated 0–10 against every other game at his position this season (6.6 is a typical game). Tap "See all" for the full list.</p>`;
  }
  else if(statsTab === "advanced"){
    if(!ADV) body = `<div class="card loading">Crunching every game this season…</div>`;
    else if(ADV.error) body = `<div class="card empty-card">${esc(ADV.error)}</div>`;
    else { const C = statCats("advanced");
      body = `<div class="seg small-seg" role="group" aria-label="Position">${[["all","All skaters"],["F","Forwards"],["D","Defense"]].map(([k,l]) => `<button type="button" data-advpos="${k}" aria-pressed="${advPos === k}">${l}</button>`).join("")}</div>
        <div class="lgrid">${C.filter(c => !c.goalie).map(c => leaderCard(c, catTop(c))).join("")}</div>
        <h2 class="sec-h">Goalies</h2><div class="lgrid">${C.filter(c => c.goalie).map(c => leaderCard(c, catTop(c))).join("")}</div>
        <p class="muted small">Built from every shot and shift in ${ADV.games} games this season. Expected goals come from <a href="https://moneypuck.com" target="_blank" rel="noopener">MoneyPuck.com</a>, except for tonight's games until MoneyPuck posts them overnight. Ratings, on-ice shares and per-60 rates are this site's own.</p>`; }
  } else if(LEAD){
    body = `<div class="lgrid">${statCats(statsTab).map(c => leaderCard(c, catTop(c))).join("")}</div><p class="muted small">Top 10s for the main categories are the NHL's official leaders. Tap "See all" for the full list.</p>`;
  }
  host.innerHTML = `<div class="page-head"><h1>League stats</h1><div class="seg" role="tablist">${tabs.map(([k,l]) => `<button type="button" role="tab" data-sttab="${k}" aria-selected="${statsTab === k}">${l}</button>`).join("")}</div></div>${body}`;
}
function renderStatsDetail(){
  const host = $("view-stats"), c = statCats(statsDetail.tab).find(x => x.key === statsDetail.key);
  if(!c){ statsDetail = null; renderStats(); return; }
  let all = c.list() || [];
  const hasPos = !c.goalie && !c.nopos && statsDetail.tab !== "goalies";
  if(hasPos && detailPos !== "all") all = all.filter(p => detailPos === "D" ? p.pos === "D" : p.pos !== "D");
  // tied values share a rank
  let prev = null, rank = 0;
  const ranked = all.map((p, i) => { if(p.v !== prev){ rank = i + 1; prev = p.v; } return { ...p, rank }; });
  const shown = ranked.slice(0, detailN);
  const tabName = { ratings:"Puck Ratings", skaters:"Skaters", goalies:"Goalies", advanced:"Advanced" }[statsDetail.tab];
  host.innerHTML = `<button type="button" class="back" data-statsback>← ${tabName}</button>
  <section class="card stand-card detail">
    <div class="detail-head"><div><h2>${esc(c.title)}</h2>${c.note ? `<p class="lnote">${c.note}</p>` : ""}</div>
      ${hasPos ? `<div class="seg" role="group" aria-label="Position">${[["all","All"],["F","Forwards"],["D","Defense"]].map(([k,l]) => `<button type="button" data-detpos="${k}" aria-pressed="${detailPos === k}">${l}</button>`).join("")}</div>` : ""}</div>
    ${shown.length ? `<div class="tbl-wrap"><table class="data lead-table"><thead><tr><th class="l rk">#</th><th class="l">Player</th><th>GP</th><th>${esc(c.title)}</th></tr></thead><tbody>
      ${shown.map(p => `<tr class="click" data-player="${p.id}" tabindex="0"><td class="l rk">${p.rank}</td>
        <td class="l"><span class="pcell"><span class="av sm"><span class="face" aria-hidden="true">${initials(p.name)}${mug(p.id)}</span></span><span class="who"><b>${esc(p.name)}</b><span>${logo(p.team)}${esc(p.team)}${p.pos ? ` · ${esc(p.pos)}` : ""}${p.sub ? ` · ${esc(p.sub)}` : ""}</span></span></span></td>
        <td>${p.gp ?? "–"}</td><td class="val">${c.chip ? chip(p.v) : c.fmt ? c.fmt(p.v) : esc(p.v)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No qualified players yet.</p>`}
    ${ranked.length > detailN ? `<button type="button" class="more-btn" data-detmore>Show more (${ranked.length - detailN} left)</button>` : `<p class="muted small">${ranked.length} player${ranked.length === 1 ? "" : "s"}</p>`}
  </section>`;
}

// ---------- Player stats tab ----------
function rankOf(arr, id, key, { min = () => true, asc = false, neg = false } = {}){
  const list = arr.filter(p => p[key] != null && !Number.isNaN(p[key]) && min(p));
  const me = list.find(p => p.id === id); if(!me || (!asc && !neg && me[key] <= 0)) return null;   // no rank for zero (or less) of a counting stat
  const better = list.filter(p => asc ? p[key] < me[key] : p[key] > me[key]).length;
  const tied = list.filter(p => p[key] === me[key]).length > 1;
  return { rank: better + 1, of: list.length, tied };
}
function statTile(label, value, r, grpLbl){
  const top = r && r.rank <= Math.max(3, Math.round(r.of * 0.05));
  return `<div class="pstat${top ? " lead" : ""}"><b>${value}</b><span>${esc(label)}</span>${r ? `<small>${r.tied ? "T-" : ""}${nth(r.rank)} of ${r.of} ${grpLbl}</small>` : `<small>&nbsp;</small>`}</div>`;
}
function playerStatsPanel(p){
  if(!LS) return `<div class="muted">Loading season stats…</div>`;
  if(LS.error) return `<div class="muted">${esc(LS.error)}</div>`;
  const season = `${String(p.season).slice(0,4)}–${String(p.season).slice(6)}`;
  const advNote = `<p class="muted small">Ranks compare him with every ${p.goalie ? "goalie" : p.pos === "D" ? "defenseman" : "forward"} this season. Rate stats only rank players who meet the minimum games. Expected goals from <a href="https://moneypuck.com" target="_blank" rel="noopener">MoneyPuck.com</a>.</p>`;
  if(p.goalie){
    const G = LS.go, me = G.find(g => g.id === p.id);
    if(!me) return `<div class="muted">No NHL games this ${season} season yet.</div>`;
    const gq = qualGo(G), lbl = "goalies";
    const std = [
      ["Games", me.gp, rankOf(G, p.id, "gp")], ["Wins", me.w, rankOf(G, p.id, "w")], ["Record", `${me.w}-${me.l}-${me.otl}`, null],
      ["Save %", me.svp != null ? f3(me.svp) : "–", rankOf(G, p.id, "svp", { min: x => x.gp >= gq })], ["Goals-against avg", me.gaa != null ? f2(me.gaa) : "–", rankOf(G, p.id, "gaa", { min: x => x.gp >= gq, asc: true })],
      ["Shutouts", me.so, rankOf(G, p.id, "so")], ["Saves", me.sv, rankOf(G, p.id, "sv")], ["Shots against", me.sa, null]
    ];
    let adv = "";
    if(ADV && !ADV.error){ const A = ADV.goalies, a = A.find(g => g.id === p.id), aq = qualGo(A);
      if(a) adv = `<h3 class="pstat-h">Advanced</h3><div class="pstat-grid">${[
        ["Goals saved above expected", fSgn(a.gsax), rankOf(A, p.id, "gsax")], ["Expected goals against", f2(a.xga), null],
        ["High-danger save %", a.hdsv != null ? f3(a.hdsv) : "–", rankOf(A, p.id, "hdsv", { min: x => x.gp >= aq })],
        ["Average Puck Rating", a.rating != null ? f2(a.rating) : "–", rankOf(A, p.id, "rating", { min: x => x.rated >= aq })]
      ].map(([l, v, r]) => statTile(l, v, r, lbl)).join("")}</div>`; }
    else if(!ADV) adv = `<p class="muted small">Loading advanced stats…</p>`;
    return `<h3 class="pstat-h">${season} season</h3><div class="pstat-grid">${std.map(([l, v, r]) => statTile(l, v, r, lbl)).join("")}</div>${adv}${advNote}`;
  }
  const isD = p.pos === "D", grp = LS.sk.filter(x => (x.pos === "D") === isD), me = grp.find(x => x.id === p.id), lbl = isD ? "defensemen" : "forwards";
  if(!me) return `<div class="muted">No NHL games this ${season} season yet.</div>`;
  const q = qualSk(LS.sk);
  const std = [
    ["Games", me.gp, null], ["Goals", me.g, rankOf(grp, p.id, "g")], ["Assists", me.a, rankOf(grp, p.id, "a")], ["Points", me.p, rankOf(grp, p.id, "p")],
    ["Plus/minus", fPm(me.pm), rankOf(grp, p.id, "pm")], ["Power-play points", me.ppp, rankOf(grp, p.id, "ppp")], ["Shorthanded points", me.shp, rankOf(grp, p.id, "shp")],
    ["Game-winning goals", me.gwg, rankOf(grp, p.id, "gwg")], ["Shots", me.sog, rankOf(grp, p.id, "sog")],
    ["Shooting %", me.shPct != null && me.sog ? fPct(me.shPct) : "–", me.sog >= Math.max(10, 3*q) ? rankOf(grp, p.id, "shPct", { min: x => x.sog >= Math.max(10, 3*q) }) : null],
    ["Ice time per game", fmtToiPG(me.toi), rankOf(grp, p.id, "toi", { min: x => x.gp >= q })],
    ...(me.fot ? [["Faceoff win %", me.fo != null ? fPct(me.fo) : "–", null]] : []),
    ["Hits", me.hits ?? "–", rankOf(grp, p.id, "hits")], ["Blocked shots", me.blk ?? "–", rankOf(grp, p.id, "blk")],
    ["Takeaways", me.tk ?? "–", rankOf(grp, p.id, "tk")], ["Giveaways", me.gv ?? "–", null], ["Penalty minutes", me.pim, null]
  ];
  let adv = "";
  if(ADV && !ADV.error){ const A = ADV.skaters.filter(x => (x.pos === "D") === isD), a = A.find(x => x.id === p.id), aq = qualSk(ADV.skaters);
    if(a) adv = `<h3 class="pstat-h">Advanced</h3><div class="pstat-grid">${[
      ["Average Puck Rating", a.rating != null ? f2(a.rating) : "–", rankOf(A, p.id, "rating", { min: x => x.rated >= aq })],
      ["Expected goals", f2(a.ixg), rankOf(A, p.id, "ixg")], ["Goals above expected", fSgn(a.gax), rankOf(A, p.id, "gax")],
      ["5-on-5 xG share", a.xgPct != null ? fPct(a.xgPct) : "–", rankOf(A, p.id, "xgPct", { min: x => x.gp >= aq && x.xgf5 + x.xga5 >= 1 })],
      ["5-on-5 shot attempt share", a.cfPct != null ? fPct(a.cfPct) : "–", rankOf(A, p.id, "cfPct", { min: x => x.gp >= aq })],
      ["High-danger chances", a.hd, rankOf(A, p.id, "hd")], ["Shot attempts", a.icf, rankOf(A, p.id, "icf")],
      ["Points per 60", a.p60 != null ? f2(a.p60) : "–", rankOf(A, p.id, "p60", { min: x => x.gp >= aq && x.toi >= x.gp * 600 })]
    ].map(([l, v, r]) => statTile(l, v, r, lbl)).join("")}</div>`; }
  else if(!ADV) adv = `<p class="muted small">Loading advanced stats…</p>`;
  return `<h3 class="pstat-h">${season} season</h3><div class="pstat-grid">${std.map(([l, v, r]) => statTile(l, v, r, lbl)).join("")}</div>${adv}${advNote}`;
}

// ---------- Teams ----------
let TEAMS = null, teamsAt = 0, teamSort = { k: "pts", d: 1 }, teamDetail = null;
const TEAM_SCHED = new Map();
const TEAM_COLS = [
  ["gp","GP",-1,"hide-sm"], ["rec","Record",0], ["pts","PTS",-1], ["pct","P%",-1,"hide-sm"], ["gfpg","GF/G",-1], ["gapg","GA/G",1],
  ["ppPct","PP%",-1,"hide-sm"], ["pkPct","PK%",-1,"hide-sm"], ["sfpg","SF/G",-1,"hide-md"], ["sapg","SA/G",1,"hide-md"],
  ["satPct","Shot att %",-1,"hide-md"], ["xgPct","xG%",-1,"hide-sm"], ["foPct","FO%",-1,"hide-md"]
];
const fmtTeam = (k, v) => v == null ? "–" : ["ppPct","pkPct","satPct","xgPct","foPct"].includes(k) ? (v*100).toFixed(1) + "%" : k === "pct" ? v.toFixed(3).replace(/^0/, "") : ["gfpg","gapg","sfpg","sapg"].includes(k) ? v.toFixed(2) : v;
function teamsWithAdv(){
  const adv = ADV && !ADV.error && ADV.teams ? new Map(ADV.teams.map(t => [t.ab, t])) : new Map();
  return TEAMS.teams.map(t => { const a = adv.get(t.ab) || {}; return { ...t, rec: `${t.w}-${t.l}-${t.otl}`, xgPct: a.xgPct ?? null, xgf: a.xgf ?? null, xga: a.xga ?? null, gax: a.gax ?? null, gsax: a.gsax ?? null, hd: a.hd ?? null, hdsv: a.hdsv ?? null }; });
}
async function loadTeams(){
  const host = $("view-teams");
  if(!TEAMS) host.innerHTML = `<div class="card loading">Loading teams…</div>`;
  if(!TEAMS || Date.now() - teamsAt > 10*60*1000){
    try { TEAMS = await api("/api/league?view=teams"); teamsAt = Date.now(); }
    catch(e){ if(!TEAMS){ host.innerHTML = `<div class="card empty-card">${esc(e.message)}</div>`; return; } }
  }
  renderTeams();
  Promise.all([loadADV(), loadLS()]).then(() => { if(view === "teams") renderTeams(); });
  if(teamDetail) loadTeamSched(teamDetail);
}
function openTeam(ab){
  teamDetail = ab;
  if(view !== "teams") setView("teams", { push:false });
  try { history.pushState({ view:"teams", team: ab }, ""); } catch(e){}
  window.scrollTo(0, 0);
  if(TEAMS) renderTeams(); else loadTeams();
  loadTeamSched(ab);
}
async function loadTeamSched(ab){
  if(TEAM_SCHED.has(ab) && Date.now() - TEAM_SCHED.get(ab).at < 5*60*1000) return;
  try { const j = await api(`/api/league?view=team&ab=${ab}`); TEAM_SCHED.set(ab, { at: Date.now(), games: j.games }); }
  catch(e){ TEAM_SCHED.set(ab, { at: Date.now(), error: e.message }); }
  if(view === "teams" && teamDetail === ab) renderTeams();
}
// Favorite teams, saved in this browser only
const FAV_KEY = "puck-fav-teams";
let FAVS = (() => { try { const a = JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); return Array.isArray(a) ? a.filter(x => typeof x === "string") : []; } catch(e){ return []; } })();
const isFav = ab => FAVS.includes(ab);
function toggleFav(ab){
  FAVS = isFav(ab) ? FAVS.filter(x => x !== ab) : [...FAVS, ab];
  try { localStorage.setItem(FAV_KEY, JSON.stringify(FAVS)); } catch(e){}
  favRemote(ab, isFav(ab));
}
const STAR = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6-4.5-4.2 6.1-.8z"/></svg>`;
const favBtn = (t, cls = "") => `<button type="button" class="fav${isFav(t.ab) ? " on" : ""}${cls}" data-fav="${esc(t.ab)}" aria-pressed="${isFav(t.ab)}" aria-label="${isFav(t.ab) ? "Remove" : "Add"} ${esc(t.name)} ${isFav(t.ab) ? "from" : "to"} favorites" title="${isFav(t.ab) ? "Remove from favorites" : "Add to favorites"}">${STAR}</button>`;
function renderTeams(){
  const host = $("view-teams");
  if(!TEAMS) return;
  if(teamDetail){ renderTeam(teamDetail); return; }
  const T = teamsWithAdv().sort((a,b) => a.name.localeCompare(b.name));
  const KEYS = [["gfpg","Goals/gm"],["gapg","Allowed/gm",true],["ppPct","Power play"],["pkPct","Penalty kill"],["sfpg","Shots/gm"],["sapg","Shots vs/gm",true],["xgPct","xG share"],["foPct","Faceoff %"]];
  // a value in the league's top 5 is marked green, bottom 5 red
  const tier = (t, key, asc) => { const r = rankOf(T, t.ab, key, { asc, neg: true }); return r == null ? "" : r.rank <= 5 ? " hi" : r.rank > r.of - 5 ? " lo" : ""; };
  const block = t => `<div class="tblock-wrap"><button type="button" class="card tblock" data-team="${esc(t.ab)}">
      <span class="tb-head">${logo(t.ab, "big")}<span class="tb-name"><b>${esc(t.name)}</b><span>${esc(t.w)}-${esc(t.l)}-${esc(t.otl)} · ${t.pts} pts${t.strk ? ` · ${esc(t.strk)}` : ""}</span></span></span>
      <span class="tb-stats">${KEYS.map(([key, l, asc]) => `<span class="tb-s${tier(t, key, asc)}"><b>${esc(fmtTeam(key, t[key]))}</b><small>${l}</small></span>`).join("")}</span>
    </button>${favBtn(t)}</div>`;
  const favs = FAVS.map(ab => T.find(t => t.ab === ab)).filter(Boolean);
  host.innerHTML = `<div class="page-head"><h1>Teams</h1></div>
    ${favs.length ? `<h2 class="tsec-h">Favorites</h2><div class="tblocks">${favs.map(block).join("")}</div><h2 class="tsec-h">All teams</h2>` : ""}
    <div class="tblocks">${T.filter(t => !isFav(t.ab)).map(block).join("")}</div>
    <p class="muted small">Tap the star on a team to add it to your favorites, which stay at the top (saved on this device). Tap a team for its full stats. Green marks a top-5 number in the NHL, red a bottom-5 one. "/gm" means per game. xG share is the team's share of expected goals (from <a href="https://moneypuck.com" target="_blank" rel="noopener">MoneyPuck.com</a>).</p>`;
}
function renderTeam(ab){
  const host = $("view-teams"), T = teamsWithAdv(), t = T.find(x => x.ab === ab);
  if(!t){ host.innerHTML = `<button type="button" class="back" data-teamsback>← All teams</button><div class="card empty-card">Team not found.</div>`; return; }
  const R = (key, asc) => rankOf(T, ab, key, { asc, neg: ["diff","gax","gsax"].includes(key) });
  const tile = (label, v, r) => statTile(label, v, r, "teams");
  const std = [
    ["Points", t.pts, R("pts")], ["Record", `${t.w}-${t.l}-${t.otl}`, null], ["Points %", fmtTeam("pct", t.pct), R("pct")],
    ["Goals for", t.gf, R("gf")], ["Goals against", t.ga, R("ga", true)], ["Goal differential", (t.diff > 0 ? "+" : "") + t.diff, R("diff")],
    ["Goals per game", fmtTeam("gfpg", t.gfpg), R("gfpg")], ["Goals against per game", fmtTeam("gapg", t.gapg), R("gapg", true)],
    ["Power play", fmtTeam("ppPct", t.ppPct), R("ppPct")], ["Power-play goals", t.ppg ?? "–", R("ppg")], ["Penalty kill", fmtTeam("pkPct", t.pkPct), R("pkPct")],
    ["Shots per game", fmtTeam("sfpg", t.sfpg), R("sfpg")], ["Shots against per game", fmtTeam("sapg", t.sapg), R("sapg", true)],
    ["Faceoff win %", fmtTeam("foPct", t.foPct), R("foPct")], ["Hits", t.hits ?? "–", R("hits")], ["Blocked shots", t.blk ?? "–", R("blk")],
    ["Takeaways", t.tk ?? "–", R("tk")], ["Giveaways", t.gv ?? "–", R("gv", true)], ["Shutouts", t.so ?? "–", R("so")],
    ["Home", t.home, null], ["Road", t.road, null], ["Last 10", t.l10, null], ["Streak", t.strk || "–", null]
  ];
  const adv = t.xgf != null ? [
    ["Expected goals for", f2(t.xgf), R("xgf")], ["Expected goals against", f2(t.xga), R("xga", true)], ["Expected goal share", fmtTeam("xgPct", t.xgPct), R("xgPct")],
    ["5-on-5 shot attempt share", fmtTeam("satPct", t.satPct), R("satPct")], ["Goals above expected (shooting)", fSgn(t.gax), R("gax")],
    ["Goals saved above expected (goalies)", fSgn(t.gsax), R("gsax")], ["High-danger chances", t.hd, R("hd")], ["High-danger save %", t.hdsv != null ? f3(t.hdsv) : "–", R("hdsv")]
  ] : null;
  // schedule
  const S = TEAM_SCHED.get(ab);
  let sched = `<p class="muted small">Loading schedule…</p>`;
  if(S?.error) sched = `<p class="muted small">${esc(S.error)}</p>`;
  else if(S?.games){
    const past = S.games.filter(g => g.st === "OFF" || g.st === "FINAL").slice(-5).reverse();
    const next = S.games.filter(g => !(g.st === "OFF" || g.st === "FINAL")).slice(0, 5);
    const row = g => { const fin = g.st === "OFF" || g.st === "FINAL", w = fin && g.us > g.them, res = !fin ? (live(g.st) ? `<span class="live-tag"><i aria-hidden="true"></i>Live</span>` : esc(g.start ? new Date(g.start).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" }) : "")) : `<b class="${w ? "win" : "loss"}">${w ? "W" : g.end && g.end !== "REG" ? "OTL" : "L"}</b> ${g.us}–${g.them}${g.end && g.end !== "REG" ? ` (${esc(g.end)})` : ""}`;
      return `<li><button type="button" data-gamelink="${g.id}" data-date="${g.d}"><span class="sd">${esc(tinyDay(g.d))}</span><span class="so">${g.home ? "vs" : "at"} ${logo(g.opp)}${esc(g.opp)}</span><span class="sr">${res}</span></button></li>`; };
    sched = `<div class="pv-two"><div><h3 class="pstat-h">Last 5</h3><ul class="tsched">${past.map(row).join("") || `<li class="muted">No games yet.</li>`}</ul></div><div><h3 class="pstat-h">Next 5</h3><ul class="tsched">${next.map(row).join("") || `<li class="muted">No games left.</li>`}</ul></div></div>`;
  }
  // players
  let players = "";
  if(LS && !LS.error){
    const sk = LS.sk.filter(p => p.team === ab), go = LS.go.filter(p => p.team === ab);
    const prow = (p, val, sub) => `<li><button type="button" data-player="${p.id}"><span class="av sm"><span class="face" aria-hidden="true">${initials(p.name)}${mug(p.id)}</span></span><span class="who"><b>${esc(p.name)}</b><span>${esc(sub)}</span></span><span class="val">${val}</span></button></li>`;
    const pts = [...sk].sort((a,b) => b.p - a.p || b.g - a.g).slice(0, 8);
    const gs = [...go].sort((a,b) => b.gp - a.gp);
    let best = "";
    if(ADV && !ADV.error){ const A = ADV.skaters.filter(p => p.team === ab && p.rating != null), q = Math.max(1, Math.ceil(t.gp * 0.4)); const top = A.filter(p => p.rated >= q).sort((a,b) => b.rating - a.rating).slice(0, 5);
      if(top.length) best = `<div><h3 class="pstat-h">Best average Puck Rating</h3><ol class="tplayers">${top.map(p => prow(p, chip(p.rating), `${p.pos} · ${p.rated} GP`)).join("")}</ol></div>`; }
    players = `<section class="pv-sec"><div class="tplay-grid">
      <div><h3 class="pstat-h">Points leaders</h3><ol class="tplayers">${pts.map(p => prow(p, `${p.p} P`, `${p.pos} · ${p.g} G, ${p.a} A · ${p.gp} GP`)).join("")}</ol></div>
      <div><h3 class="pstat-h">Goalies</h3><ol class="tplayers">${gs.map(p => prow(p, p.svp != null ? f3(p.svp) : "–", `${p.w}-${p.l}-${p.otl} · ${p.gaa != null ? f2(p.gaa) : "–"} GAA · ${p.gp} GP`)).join("")}</ol></div>
      ${best}</div></section>`;
  }
  host.innerHTML = `<button type="button" class="back" data-teamsback>← All teams</button>
  <article class="card">
    <div class="team-hero">${logo(t.ab, "big")}<div class="th-main"><h1>${esc(t.name)}${favBtn(t, " inline")}</h1>
      <div class="sub">${esc(t.w)}-${esc(t.l)}-${esc(t.otl)} · ${t.pts} points · ${nth(t.divSeq)} in the ${esc(t.div)} · ${nth(t.leagueSeq)} in the NHL${t.strk ? ` · ${esc(streakTxt(t.strk))}` : ""}</div></div></div>
    <section class="pv-sec"><h3 class="pstat-h">Team stats</h3><div class="pstat-grid">${std.map(([l,v,r]) => tile(l, v, r)).join("")}</div></section>
    ${adv ? `<section class="pv-sec"><h3 class="pstat-h">Advanced</h3><div class="pstat-grid">${adv.map(([l,v,r]) => tile(l, v, r)).join("")}</div><p class="muted small">All situations, empty-net goals left out. Expected goals from <a href="https://moneypuck.com" target="_blank" rel="noopener">MoneyPuck.com</a>; shot attempt share is at 5-on-5.</p></section>` : (!ADV ? `<section class="pv-sec"><p class="muted small">Loading advanced stats…</p></section>` : "")}
    ${shotMapSec(t.ab)}
    <section class="pv-sec"><h3 class="pstat-h">Schedule</h3>${sched}</section>
    ${players}
  </article>`;
}

// ---------- Loading ----------
// ---------- Your teams (favorites on the Scores page) ----------
let TEAMS_P = null;
function getTeams(){ return TEAMS ? Promise.resolve(TEAMS) : (TEAMS_P ||= api("/api/league?view=teams").then(j => { TEAMS = j; teamsAt = Date.now(); return j; }).catch(() => { TEAMS_P = null; return null; })); }
const favGame = s => s.t.some(t => isFav(t.ab));
// Favorite teams' games first, otherwise the NHL's order
const favOrder = games => FAVS.length ? [...games.filter(favGame), ...games.filter(s => !favGame(s))] : games;
function renderMyTeams(){
  const box = $("myteams");
  if(!FAVS.length || view !== "scores" || !SCHED){ box.hidden = true; sideVisibility(); return; }
  box.hidden = false; sideVisibility();
  const rows = FAVS.map(ab => {
    const t = TEAMS?.teams?.find(x => x.ab === ab);
    const s = SCHED.games.find(x => x.t.some(y => y.ab === ab));
    let line = "", star = "", gid = null;
    if(s){
      gid = s.id;
      const side = s.t[0].ab === ab ? 0 : 1, opp = s.t[1 - side].ab, vs = side ? "vs" : "at";
      if(!started(s.st)) line = `${vs} ${logo(opp)}${esc(opp)} · ${s.st === "PPD" ? "Postponed" : s.start ? esc(localTime(s.start)) : "TBD"}`;
      else { const us = s.t[side].sc ?? 0, them = s.t[1 - side].sc ?? 0, fin = done(s.st);
        const res = fin ? `<b class="${us > them ? "win" : "loss"}">${us > them ? "W" : "L"}</b> ` : `<span class="live-tag"><i aria-hidden="true"></i>${esc(statusText(s))}</span> `;
        line = `${res}${us}–${them} ${vs} ${logo(opp)}${esc(opp)}`;
        const best = (RATED[s.id] || []).filter(p => p.side === side && p.rating != null).sort((a,b) => b.rating - a.rating)[0];
        if(best) star = `<span class="mt-star">${esc(best.name)} ${chip(best.rating)}</span>`; }
    } else {
      const S = TEAM_SCHED.get(ab);
      if(!S) ensureTeamSched(ab);
      const nx = S?.games?.find(g => g.d > viewDate && !done(g.st));
      line = nx ? `<span class="muted">No game ${viewDate === SCHED.today ? "today" : "this day"} · next ${esc(new Date(nx.d + "T12:00:00Z").toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric", timeZone:"UTC" }))} ${nx.home ? "vs" : "at"} ${esc(nx.opp)}</span>` : `<span class="muted">No game ${viewDate === SCHED.today ? "today" : "this day"}</span>`;
    }
    return `<li><button type="button" ${gid ? `data-mtg="${gid}"` : `data-team="${esc(ab)}"`}>
      ${logo(ab, "mt")}<span class="who"><b>${esc(t?.name || ab)}${t ? ` <span class="muted">${t.w}-${t.l}-${t.otl}</span>` : ""}</b><span>${line}</span>${star}</span></button></li>`;
  }).join("");
  $("myteams-list").innerHTML = rows;
  if(!TEAMS) getTeams().then(() => { if(view === "scores") renderMyTeams(); });
}
function ensureTeamSched(ab){
  if(TEAM_SCHED.has(ab) || ensureTeamSched.busy?.has(ab)) return;
  (ensureTeamSched.busy ||= new Set()).add(ab);
  api(`/api/league?view=team&ab=${ab}`).then(j => TEAM_SCHED.set(ab, { at: Date.now(), games: j.games })).catch(e => TEAM_SCHED.set(ab, { at: Date.now(), error: e.message }))
    .finally(() => { ensureTeamSched.busy.delete(ab); if(view === "scores") renderMyTeams(); });
}

// ---------- Team of the week (best single game of the week at each spot: 3 forwards, 2 defense, 1 goalie) ----------
function renderTotw(){
  const box = $("totw"), P = PER.week;
  if(!P.rows || !CALS || view !== "scores"){ box.hidden = true; sideVisibility(); return; }
  const best = new Map();
  P.rows.forEach(r => { const rating = E.calibrate(r.raw, CALS[r.grp], SCALE).rating; const o = best.get(r.id); if(!o || rating > o.rating) best.set(r.id, { ...r, rating }); });
  const all = [...best.values()].sort((a,b) => b.rating - a.rating);
  const F = all.filter(p => p.grp === "F").slice(0, 3), D = all.filter(p => p.grp === "D").slice(0, 2), G = all.filter(p => p.grp === "G").slice(0, 1);
  if(F.length < 3 || D.length < 2 || !G.length){ box.hidden = true; sideVisibility(); return; }
  box.hidden = false; sideVisibility();
  const [a, b] = PERIODS.week.range(P.key);
  $("totw-sub").textContent = `${tinyDay(a)} – ${tinyDay(b)}${b >= SCHED.today ? " so far" : ""} · each player's best game`;
  const wd = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday:"short", timeZone:"UTC" });
  const cell = (p, pos) => `<button type="button" class="tw-p" data-g="${p.gid}" data-p="${p.id}" data-date="${p.d}" title="${esc(p.name)} · ${esc(p.team)} vs ${esc(p.opp)}, ${wd(p.d)} · ${esc(p.line)}">
      <span class="av md"><span class="face" aria-hidden="true">${initials(p.name)}${mug(p.id)}</span>${chip(p.rating)}</span>
      <b>${esc(p.name.split(". ").pop())}</b><span>${logo(p.team)}${esc(p.team)} · ${pos}</span></button>`;
  $("totw-body").innerHTML = `<div class="tw-row">${F.map(p => cell(p, p.pos)).join("")}</div><div class="tw-row">${D.map(p => cell(p, "D")).join("")}</div><div class="tw-row">${cell(G[0], "G")}</div>`;
}

// ---------- Rating trend (player profile) ----------
function ratingTrend(p){
  const G = [...p.games].filter(g => g.rating != null).sort((a,b) => a.date.localeCompare(b.date));
  if(G.length < 2) return "";
  const W0 = 900, H0 = 230, L = 30, R = 12, T = 12, B = 28, lo = 2, hi = 10;
  const x = i => L + (G.length === 1 ? 0 : i * (W0 - L - R) / (G.length - 1));
  const y = v => T + (hi - Math.max(lo, Math.min(hi, v))) * (H0 - T - B) / (hi - lo);
  const roll = G.map((g, i) => { const s = G.slice(Math.max(0, i - 4), i + 1); return s.reduce((a, q) => a + q.rating, 0) / s.length; });
  const path = arr => arr.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const grid = [4, 6, 8, 10].map(v => `<line x1="${L}" x2="${W0 - R}" y1="${y(v)}" y2="${y(v)}" class="tr-grid"/><text x="${L - 6}" y="${y(v) + 4}" class="tr-ax" text-anchor="end">${v}</text>`).join("");
  const step = Math.max(1, Math.ceil(G.length / 6));
  const xl = G.map((g, i) => i % step === 0 || i === G.length - 1 ? `<text x="${x(i)}" y="${H0 - 8}" class="tr-ax" text-anchor="middle">${esc(tinyDay(g.date))}</text>` : "").join("");
  const dots = G.map((g, i) => `<g class="tr-pt" data-gamelink="${g.id}" data-date="${g.date}" tabindex="0" role="link" aria-label="${esc(tinyDay(g.date))} ${g.home ? "vs" : "at"} ${esc(g.opp)}: ${g.rating.toFixed(1)}"><title>${esc(tinyDay(g.date))} ${g.home ? "vs" : "at"} ${esc(g.opp)} · ${g.rating.toFixed(1)}${g.result ? ` · ${g.result} ${esc(g.score || "")}` : ""}</title><circle cx="${x(i).toFixed(1)}" cy="${y(g.rating).toFixed(1)}" r="${G.length > 40 ? 3.2 : 4.5}" class="b-${band(g.rating)}"/></g>`).join("");
  const last5 = G.slice(-5), l5 = last5.reduce((a, g) => a + g.rating, 0) / last5.length, all = G.reduce((a, g) => a + g.rating, 0) / G.length;
  const trend = l5 - all > 0.25 ? "trending up" : all - l5 > 0.25 ? "trending down" : "steady";
  return `<section class="trend"><div class="trend-head"><h3 class="pstat-h">Rating trend</h3><span class="muted small">Last 5 games <b class="mono">${l5.toFixed(2)}</b> · season <b class="mono">${all.toFixed(2)}</b> · ${trend}</span></div>
    <svg viewBox="0 0 ${W0} ${H0}" class="trend-svg" role="img" aria-label="Game-by-game Puck Ratings this season">
      ${grid}<line x1="${L}" x2="${W0 - R}" y1="${y(6.6)}" y2="${y(6.6)}" class="tr-typ"/>
      <path d="${path(G.map(g => g.rating))}" class="tr-line"/><path d="${path(roll)}" class="tr-roll"/>${dots}${xl}</svg>
    <div class="trend-key"><span><i class="k-line"></i>Each game</span><span><i class="k-roll"></i>5-game average</span><span><i class="k-typ"></i>Typical game (6.6)</span><span>Tap a dot to open the game</span></div></section>`;
}

// ---------- Share a performance (image card) ----------
const imgProxy = q => `/api/search?img=${encodeURIComponent(q)}`;
const loadImg = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
async function makeShareCard(g, pl){
  await document.fonts?.ready;
  const S = 1080, c = document.createElement("canvas"); c.width = S; c.height = S;
  const x = c.getContext("2d"), cs = getComputedStyle(document.documentElement);
  const BAND = { elite:"#1e9c7f", good:"#3aa862", mid:"#e0ab33", low:"#e0554c" }, bc = BAND[band(pl.rating)] || "#1e9c7f";
  const F = (w, px, mono) => `${w} ${px}px ${mono ? '"IBM Plex Mono", ui-monospace, monospace' : '"IBM Plex Sans", system-ui, sans-serif'}`;
  // background
  x.fillStyle = "#0c1116"; x.fillRect(0, 0, S, S);
  const gr = x.createRadialGradient(S / 2, 300, 40, S / 2, 300, 620); gr.addColorStop(0, bc + "55"); gr.addColorStop(1, "#0c111600");
  x.fillStyle = gr; x.fillRect(0, 0, S, S);
  // wordmark and date
  x.fillStyle = "#e7edf3"; x.font = F(700, 34); x.textBaseline = "alphabetic"; x.textAlign = "left"; x.fillText("Puck Ratings", 64, 92);
  x.fillStyle = "#94a2b0"; x.font = F(500, 28); x.textAlign = "right"; x.fillText(shortDay(g.d), S - 64, 92);
  // headshot
  const [face, tl, ol] = await Promise.all([loadImg(imgProxy(`mug:${pl.id}`)), loadImg(imgProxy(`logo:${g.t[pl.side].ab}_dark`)), loadImg(imgProxy(`logo:${g.t[1 - pl.side].ab}_dark`))]);
  const cx = S / 2, cy = 340, r = 190;
  x.save(); x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fillStyle = "#1a232c"; x.fill(); x.clip();
  if(face){ const sc = (r * 2) / Math.min(face.width, face.height) * 1.02; x.drawImage(face, cx - face.width * sc / 2, cy - r - 4, face.width * sc, face.height * sc); }
  else { x.fillStyle = "#94a2b0"; x.font = F(700, 120); x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(pl.name.replace(/\./g, " ").trim().split(/\s+/).map(s => s[0]).join("").slice(0, 2).toUpperCase(), cx, cy); }
  x.restore();
  x.lineWidth = 8; x.strokeStyle = bc; x.beginPath(); x.arc(cx, cy, r + 4, 0, Math.PI * 2); x.stroke();
  // rating badge
  const bw = 230, bh = 118, bx = cx + 92, by = cy + 98;
  x.fillStyle = bc; x.beginPath(); x.roundRect ? x.roundRect(bx, by, bw, bh, 26) : x.rect(bx, by, bw, bh); x.fill();
  x.fillStyle = band(pl.rating) === "mid" ? "#2a1d00" : "#ffffff"; x.font = F(700, 88); x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(pl.rating.toFixed(1), bx + bw / 2, by + bh / 2 + 4);
  // name, game, line
  x.textBaseline = "alphabetic"; x.fillStyle = "#e7edf3"; x.font = F(700, 68); x.fillText(pl.name, cx, 660);
  const A = g.t[0], H = g.t[1], fin = done(g.st);
  const score = `${A.ab} ${A.sc} – ${H.sc} ${H.ab}`, status = fin ? (g.end === "REG" ? "Final" : g.end === "OT" ? "Final · OT" : "Final · SO") : "Live";
  x.font = F(600, 38); const sw = x.measureText(score).width, lg = 52, gap = 16, total = lg + gap + sw + gap + lg;
  let lx = cx - total / 2;
  const logoAt = (img, ab, px) => { if(img) x.drawImage(img, px, 705, lg, lg); else { x.font = F(600, 22); x.fillStyle = "#94a2b0"; x.textAlign = "center"; x.fillText(ab, px + lg / 2, 740); x.font = F(600, 38); } };
  logoAt(A === g.t[pl.side] ? tl : ol, A.ab, lx); x.fillStyle = "#e7edf3"; x.textAlign = "left"; x.font = F(600, 38); x.fillText(score, lx + lg + gap, 745); logoAt(H === g.t[pl.side] ? tl : ol, H.ab, lx + lg + gap + sw + gap);
  x.textAlign = "center"; x.fillStyle = "#94a2b0"; x.font = F(500, 28); x.fillText(status, cx, 795);
  x.fillStyle = "#cfd9e2"; x.font = F(500, 36); x.fillText(pl.line || "", cx, 865);
  if(pl.pct != null){ x.fillStyle = bc; x.font = F(600, 34); x.fillText(pl.pct >= .5 ? `Top ${topPct(pl.pct)} of ${GRP_NAME[pl.grp]} games this season` : `${GRP_NAME[pl.grp][0].toUpperCase() + GRP_NAME[pl.grp].slice(1)} game rating`, cx, 925); }
  // footer
  x.fillStyle = "#2c3b4b"; x.fillRect(64, 975, S - 128, 2);
  x.fillStyle = "#94a2b0"; x.font = F(500, 26); x.textAlign = "left"; x.fillText("Game rating 0–10", 64, 1025);
  x.textAlign = "right"; x.fillStyle = "#e7edf3"; x.font = F(600, 26); x.fillText(location.host, S - 64, 1025);
  return new Promise(res => c.toBlob(b => res(b), "image/png"));
}
async function openShare(gid, pid){
  const g = GAMES.get(gid), pl = (RATED[gid] || []).find(p => p.id === pid);
  if(!g || !pl || pl.rating == null) return;
  const m = $("share-modal"), box = $("share-body");
  m.hidden = false; box.innerHTML = `<div class="muted" style="padding:40px 0;text-align:center">Making the image…</div>`;
  const blob = await makeShareCard(g, pl);
  if(m.hidden) return;
  const fname = `${pl.name.replace(/[^A-Za-z]+/g, "-")}-${g.d}-puck-rating.png`.replace(/^-/, "");
  const file = new File([blob], fname, { type: "image/png" }), url = URL.createObjectURL(blob);
  const text = `${pl.name}: ${pl.rating.toFixed(1)} Puck Rating, ${g.t[0].ab} ${g.t[0].sc}–${g.t[1].sc} ${g.t[1].ab}`;
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  box.innerHTML = `<img src="${url}" alt="Share image: ${esc(text)}" class="share-img">
    <div class="share-actions">${canShare ? `<button type="button" class="pill-btn primary" id="share-go">Share</button>` : ""}<a class="pill-btn${canShare ? "" : " primary"}" href="${url}" download="${esc(fname)}">Download image</a><button type="button" class="pill-btn" id="share-copy">Copy text</button></div>`;
  $("share-copy").onclick = () => { navigator.clipboard?.writeText(`${text} ${location.origin}`).then(() => { $("share-copy").textContent = "Copied"; }).catch(() => {}); };
  if(canShare) $("share-go").onclick = () => navigator.share({ files: [file], text: `${text} ${location.origin}` }).catch(() => {});
}
function closeShare(){ $("share-modal").hidden = true; $("share-body").innerHTML = ""; }

// ---------- Recent form for one player (last games' Puck Ratings), shared by Compare and goalie previews ----------
const FORM = new Map();
function getForm(id){
  if(!FORM.has(id)) FORM.set(id, api(`/api/player?id=${id}`).then(p => p.games.filter(g => g.rating != null).sort((a,b) => b.date.localeCompare(a.date))).catch(() => { FORM.delete(id); return null; }));
  return FORM.get(id);
}
const FORM_DONE = new Map();
function formNow(id, after){ if(FORM_DONE.has(id)) return FORM_DONE.get(id); getForm(id).then(f => { if(f){ FORM_DONE.set(id, f); after && after(); } }); return undefined; }
const formChips = f => f.slice(0, 5).reverse().map(g => `<span title="${esc(tinyDay(g.date))} ${g.home ? "vs" : "at"} ${esc(g.opp)}">${chip(g.rating)}</span>`).join("");

// ---------- Goalie matchup: recent ratings on the preview ----------
function goalieForm(g){
  const f = formNow(g.id, () => { if(view === "scores") renderGame(); });
  const A = ADV && !ADV.error ? ADV.goalies : null, a = A?.find(x => x.id === g.id), aq = A ? qualGo(A) : 1;
  const r = a && a.rating != null ? rankOf(A, g.id, "rating", { min: x => x.rated >= aq }) : null;
  const avg = a?.rating != null ? `<span>Season average <b class="mono">${a.rating.toFixed(2)}</b>${r ? ` · ${r.tied ? "T-" : ""}${nth(r.rank)} of ${r.of}` : ""}</span>` : "";
  if(f === undefined) return `<div class="gform"><span class="muted">Loading recent ratings…</span></div>`;
  if(!f.length) return `<div class="gform"><span class="muted">No rated games yet this season.</span>${avg}</div>`;
  return `<div class="gform"><div class="gf-top"><span class="lbl">Last ${Math.min(5, f.length)} Puck Ratings</span><span class="gf-chips">${formChips(f)}</span></div>${avg}</div>`;
}

// ---------- Compare two players (Stats tab) ----------
let CMP = [null, null], cmpQ = ["", ""];
function cmpPool(){ if(!LS || LS.error) return []; return [...LS.sk.map(p => ({ ...p, goalie:false })), ...LS.go.map(p => ({ ...p, pos:"G", goalie:true }))]; }
function cmpFind(id){ return cmpPool().find(p => p.id === id) || null; }
// Only players at the same position can be compared: forwards with forwards, defensemen with defensemen, goalies with goalies
const cmpGrp = p => p.goalie ? "G" : p.pos === "D" ? "D" : "F";
const CMP_GRP_NAME = { F:"forward", D:"defenseman", G:"goalie" }, CMP_GRP_PL = { F:"forwards", D:"defensemen", G:"goalies" };
function cmpPicker(i){
  const p = CMP[i] ? cmpFind(CMP[i]) : null;
  if(p) return `<div class="cmp-pick chosen"><span class="av md"><span class="face" aria-hidden="true">${initials(p.name)}${mug(p.id)}</span></span>
    <span class="who"><b>${esc(p.name)}</b><span>${logo(p.team)}${esc(p.team)} · ${esc(p.pos)}</span></span><button type="button" class="link-btn" data-cmpclear="${i}">Change</button></div>`;
  const q = cmpQ[i].trim().toLowerCase(), other = CMP[1 - i] ? cmpFind(CMP[1 - i]) : null, grp = other ? cmpGrp(other) : null;
  const hits = q.length >= 2 ? cmpPool().filter(x => x.name.toLowerCase().includes(q) && (!grp || cmpGrp(x) === grp) && x.id !== other?.id).sort((a,b) => b.gp - a.gp).slice(0, 8) : [];
  const what = grp ? CMP_GRP_NAME[grp] : "player";
  return `<div class="cmp-pick"><input type="search" class="cmp-in" data-cmpin="${i}" placeholder="${grp ? `Pick a ${what} to compare` : `${i ? "Second" : "First"} player`}" value="${esc(cmpQ[i])}" autocomplete="off" aria-label="${i ? "Second" : "First"} player">
    ${hits.length ? `<ul class="cmp-hits">${hits.map(x => `<li><button type="button" data-cmppick="${i}:${x.id}"><span class="av sm"><span class="face" aria-hidden="true">${initials(x.name)}${mug(x.id)}</span></span><span>${esc(x.name)}</span><span class="muted">${esc(x.team)} · ${esc(x.pos)}</span></button></li>`).join("")}</ul>` : q.length >= 2 ? `<div class="muted small cmp-none">No ${what} this season matches.</div>` : grp ? `<div class="muted small cmp-none">Only ${CMP_GRP_PL[grp]} can be compared with ${esc(other.name)}.</div>` : ""}</div>`;
}
function compareBody(){
  const pa = CMP[0] && cmpFind(CMP[0]), pb = CMP[1] && cmpFind(CMP[1]);
  if(!pa || !pb) return `<p class="muted">Pick two players to see them side by side: season stats, Puck Ratings and recent form.</p>`;
  if(cmpGrp(pa) !== cmpGrp(pb)) return `<p class="muted">Players can only be compared with others at the same position: forwards with forwards, defensemen with defensemen, goalies with goalies.</p>`;
  const advOf = id => ADV && !ADV.error ? (pa.goalie ? ADV.goalies : ADV.skaters).find(x => x.id === id) : null;
  const A = advOf(pa.id) || {}, B = advOf(pb.id) || {};
  const per = (v, gp) => gp ? v / gp : null;
  const rows = pa.goalie ? [
    ["Games", pa.gp, pb.gp, 0, 1], ["Wins", pa.w, pb.w, 0, 1], ["Save %", pa.svp, pb.svp, "svp", 1], ["Goals-against avg", pa.gaa, pb.gaa, 2, -1],
    ["Shutouts", pa.so, pb.so, 0, 1], ["Average Puck Rating", A.rating, B.rating, 2, 1], ["Goals saved above expected", A.gsax, B.gsax, "sgn", 1],
    ["High-danger save %", A.hdsv, B.hdsv, "svp", 1], ["8+ rated games", A.hi, B.hi, 0, 1]
  ] : [
    ["Games", pa.gp, pb.gp, 0, 1], ["Goals", pa.g, pb.g, 0, 1], ["Assists", pa.a, pb.a, 0, 1], ["Points", pa.p, pb.p, 0, 1],
    ["Points per game", per(pa.p, pa.gp), per(pb.p, pb.gp), 2, 1], ["Plus/minus", pa.pm, pb.pm, "pm", 1], ["Power-play points", pa.ppp, pb.ppp, 0, 1],
    ["Shots", pa.sog, pb.sog, 0, 1], ["Shooting %", pa.sog ? pa.shPct : null, pb.sog ? pb.shPct : null, "pct", 1], ["Ice time per game", pa.toi, pb.toi, "toi", 1],
    ["Hits", pa.hits, pb.hits, 0, 1], ["Blocked shots", pa.blk, pb.blk, 0, 1],
    ["Average Puck Rating", A.rating, B.rating, 2, 1], ["8+ rated games", A.hi, B.hi, 0, 1], ["Expected goals", A.ixg, B.ixg, 2, 1], ["Goals above expected", A.gax, B.gax, "sgn", 1],
    ["5-on-5 xG share", A.xgPct, B.xgPct, "pct", 1], ["5-on-5 shot attempt share", A.cfPct, B.cfPct, "pct", 1], ["Points per 60", A.p60, B.p60, 2, 1]
  ];
  const f = (v, k) => v == null || Number.isNaN(v) ? "–" : k === "svp" ? f3(v) : k === "pct" ? fPct(v) : k === "sgn" ? fSgn(v) : k === "pm" ? fPm(v) : k === "toi" ? fmtToiPG(v) : typeof k === "number" && k ? v.toFixed(k) : v;
  const body = rows.map(([n, x, y, k, dir]) => {
    const has = x != null && y != null && !Number.isNaN(x) && !Number.isNaN(y);
    const ax = has && (dir > 0 ? x > y : x < y), by = has && (dir > 0 ? y > x : y < x);
    const lo = Math.min(0, x ?? 0, y ?? 0), w = v => has ? Math.max(4, (v - lo) / ((Math.max(x, y) - lo) || 1) * 100) : 0;
    return `<div class="cmp-row"><span class="v${ax ? " lead" : ""}">${f(x, k)}</span><span class="nm">${n}</span><span class="v r${by ? " lead" : ""}">${f(y, k)}</span>
      <span class="cbar a"><i style="width:${w(x).toFixed(1)}%"></i></span><span class="cbar b"><i style="width:${w(y).toFixed(1)}%"></i></span></div>`; }).join("");
  const fa = formNow(pa.id, () => { if(view === "stats" && statsTab === "compare") renderStats(); }), fb = formNow(pb.id, () => { if(view === "stats" && statsTab === "compare") renderStats(); });
  const fl = fz => fz === undefined ? `<span class="muted small">Loading…</span>` : !fz.length ? `<span class="muted small">No rated games</span>` : `<span class="gf-chips">${formChips(fz)}</span>`;
  const head = p => `<button type="button" class="cmp-head" data-player="${p.id}"><span class="av lg"><span class="face" aria-hidden="true">${initials(p.name)}${mug(p.id)}</span></span><b>${esc(p.name)}</b><span>${logo(p.team)}${esc(p.team)} · ${esc(p.pos)}</span></button>`;
  return `<div class="cmp-top">${head(pa)}<span class="cmp-vs">vs</span>${head(pb)}</div>
    <div class="cmp-form"><div>${fl(fa)}</div><span class="nm">Last 5 Puck Ratings</span><div class="r">${fl(fb)}</div></div>
    <div class="cmp-rows">${body}</div>
    ${!ADV ? `<p class="muted small">Loading advanced stats…</p>` : ""}
    <p class="muted small">Better number in each row is in bold. Expected goals from <a href="https://moneypuck.com" target="_blank" rel="noopener">MoneyPuck.com</a>.</p>`;
}
function renderCompare(){
  if(!LS) return `<div class="card loading">Loading players…</div>`;
  if(LS.error) return `<div class="card empty-card">${esc(LS.error)}</div>`;
  return `<section class="card cmp"><div class="cmp-picks">${cmpPicker(0)}${cmpPicker(1)}</div>${compareBody()}</section>`;
}
function compareWith(id){ CMP = [id, null]; cmpQ = ["", ""]; statsTab = "compare"; statsDetail = null; setView("stats"); window.scrollTo(0, 0); setTimeout(() => document.querySelector('[data-cmpin="1"]')?.focus(), 50); }

// ---------- Team shot map ----------
const SHOTMAP = new Map(); let tmapSide = "f";
function loadShotMap(ab){
  if(SHOTMAP.has(ab)) return;
  SHOTMAP.set(ab, { loading: true });
  api(`/api/league?view=shotmap&ab=${ab}`).then(j => SHOTMAP.set(ab, j)).catch(e => SHOTMAP.set(ab, { error: e.message }))
    .finally(() => { if(view === "teams" && teamDetail === ab) renderTeams(); });
}
function shotMapSec(ab){
  const M = SHOTMAP.get(ab);
  if(!M) loadShotMap(ab);
  const head = `<div class="trend-head"><h3 class="pstat-h">Shot map</h3><div class="seg small-seg" role="group" aria-label="Shots">${[["f","Shots taken"],["a","Shots allowed"]].map(([k,l]) => `<button type="button" data-tmap="${k}" aria-pressed="${tmapSide === k}">${l}</button>`).join("")}</div></div>`;
  if(!M || M.loading) return `<section class="pv-sec">${head}<p class="muted small">Loading shot locations…</p></section>`;
  if(M.error || M.none || !M.gp) return `<section class="pv-sec">${head}<p class="muted small">${M.error ? esc(M.error) : "No shot data for this team yet. MoneyPuck.com posts each night's shots the next morning."}</p></section>`;
  const C = M.cols, Rr = M.rows, N = C * Rr, cnt = M[tmapSide], xg = M[tmapSide + "x"];
  // per game, smoothed over neighboring cells, then compared with the league average
  const blur = arr => { const out = new Array(N).fill(0);
    for(let r = 0; r < Rr; r++) for(let c = 0; c < C; c++){ let s = 0, w = 0;
      for(let dr = -1; dr <= 1; dr++) for(let dc = -1; dc <= 1; dc++){ const rr = r + dr, cc = c + dc; if(rr < 0 || rr >= Rr || cc < 0 || cc >= C) continue; const k = (dr ? 1 : 2) * (dc ? 1 : 2); s += arr[rr * C + cc] * k; w += k; }
      out[r * C + c] = s / w; }
    return out; };
  const me = blur(xg.map(v => v / 1000 / M.gp)), lg = blur(M.lg.fx.map(v => v / 1000));
  const diff = me.map((v, i) => v - lg[i]);
  const sorted = diff.map(Math.abs).sort((a,b) => a - b), cap = sorted[Math.floor(sorted.length * .95)] || 1e-6;
  const cells = diff.map((d, i) => { const r = Math.floor(i / C), c = i % C; const op = Math.min(1, Math.abs(d) / cap) * .85; if(op < .04) return "";
    return `<rect x="${r * 5}" y="${70 - c * 5}" width="5" height="5" fill="${d > 0 ? "var(--hm-more)" : "var(--hm-less)"}" fill-opacity="${op.toFixed(3)}"/>`; }).join("");
  const tot = a => a.reduce((s, v) => s + v, 0);
  const xgpg = tot(xg) / 1000 / M.gp, lgx = tot(M.lg.fx) / 1000, spg = tot(cnt) / M.gp, lgs = tot(M.lg.f);
  // slot: the home-plate area in front of the net (x 69-89 ft, |y| < 10 ft roughly)
  const slot = (arr, scale) => { let s = 0; for(let r = 6; r <= 10; r++) for(let c = 9; c <= 12; c++) s += arr[r * C + c]; return s * scale; };
  const sl = slot(xg, 1 / 1000 / M.gp), lsl = slot(M.lg.fx, 1 / 1000);
  const rink = `<clipPath id="rk"><path d="M0,75 L0,28 A28,28 0 0 1 28,0 L57,0 A28,28 0 0 1 85,28 L85,75 Z"/></clipPath>
    <path d="M0,75 L0,28 A28,28 0 0 1 28,0 L57,0 A28,28 0 0 1 85,28 L85,75 Z" class="rk-ice"/>
    <g clip-path="url(#rk)">${cells}<line x1="0" x2="85" y1="11" y2="11" class="rk-goal"/>
      <path d="M36.5,11 A6,6 0 0 0 48.5,11 Z" class="rk-crease"/>
      <circle cx="20.5" cy="31" r="15" class="rk-line"/><circle cx="64.5" cy="31" r="15" class="rk-line"/>
      <circle cx="20.5" cy="31" r=".9" class="rk-dot"/><circle cx="64.5" cy="31" r=".9" class="rk-dot"/>
      <line x1="0" x2="85" y1="74.4" y2="74.4" class="rk-blue"/></g>
    <rect x="39.5" y="7.6" width="6" height="3.4" rx=".8" class="rk-net"/>
    <path d="M0,75 L0,28 A28,28 0 0 1 28,0 L57,0 A28,28 0 0 1 85,28 L85,75 Z" class="rk-board"/>`;
  const vs = (a, b, low) => { const d = a - b, good = low ? d < 0 : d > 0; return `<small class="${Math.abs(d) / (b || 1) < .03 ? "" : good ? "good" : "bad"}">${d >= 0 ? "+" : "−"}${Math.abs(d / (b || 1) * 100).toFixed(0)}% vs league</small>`; };
  const lowGood = tmapSide === "a";
  return `<section class="pv-sec">${head}
    <div class="smap"><svg viewBox="-1 -1 87 77" class="smap-svg" role="img" aria-label="${tmapSide === "f" ? "Where this team shoots from" : "Where opponents shoot from against this team"}, compared with the league average">${rink}</svg>
      <div class="smap-side">
        <div class="pstat"><b>${xgpg.toFixed(2)}</b><span>Expected goals per game</span>${vs(xgpg, lgx, lowGood)}</div>
        <div class="pstat"><b>${sl.toFixed(2)}</b><span>Slot expected goals per game</span>${vs(sl, lsl, lowGood)}</div>
        <div class="pstat"><b>${spg.toFixed(1)}</b><span>Unblocked shots per game</span>${vs(spg, lgs, lowGood)}</div>
        <div class="smap-key"><span><i style="background:var(--hm-more)"></i>More than league average</span><span><i style="background:var(--hm-less)"></i>Less than league average</span></div>
      </div></div>
    <p class="muted small">${tmapSide === "f" ? "Where the team's shots come from" : "Where opponents' shots come from"}, weighted by expected goals, per game, compared with the league average. The net is at the top. ${M.gp} games of shot data from <a href="https://moneypuck.com" target="_blank" rel="noopener">MoneyPuck.com</a>, updated each morning.</p></section>`;
}

// ---------- Win probability ----------
// A simple model: goals in the time left follow a Poisson process at the league rate (about 3 per team per game),
// split by each team's share of expected goals so far (pulled toward 50/50 early on), with a small home-ice edge.
// Ties go to overtime (3-on-3, sudden death) and then a coin-flip shootout.
const WP_RATE = 3.05 / 3600, WP_PRIOR = 1.2;
const pois = (l, k) => { let p = Math.exp(-l); for(let i = 1; i <= k; i++) p *= l / i; return p; };
function wpModel(dA, xgA, xgH, t, maxT){
  const sA = (xgA + WP_PRIOR) / (xgA + xgH + 2 * WP_PRIOR), sH = 1 - sA;
  if(t < 3600){
    const rem = 3600 - t, lA = 2 * WP_RATE * sA * rem * .97, lH = 2 * WP_RATE * sH * rem * 1.03;
    const pa = Array.from({ length: 13 }, (_, k) => pois(lA, k)), ph = Array.from({ length: 13 }, (_, k) => pois(lH, k));
    let win = 0, tie = 0;
    for(let i = 0; i < 13; i++) for(let j = 0; j < 13; j++){ const d = dA + i - j, p = pa[i] * ph[j]; if(d > 0) win += p; else if(d === 0) tie += p; }
    return win + tie * (0.5 + (sA - 0.5) * 0.6);
  }
  if(dA) return dA > 0 ? 1 : 0;
  if(maxT != null && t >= maxT) return 0.5;                // shootout
  const rem = Math.max(0, 3900 - t) / 60, la = 0.2 * sA, lh = 0.2 * sH, pg = 1 - Math.exp(-(la + lh) * rem);
  return pg * la / (la + lh) + (1 - pg) * 0.5;
}
const gsecOf = gl => (gl[0] - 1) * 1200 + (([m, s]) => m * 60 + s)(String(gl[1]).split(":").map(Number));
function gameElapsed(g){
  if(done(g.st)) return Math.max(3600, ...g.s.map(s => s[0]), ...g.gl.map(gsecOf));
  const prd = g.prd || 1, [m, sec] = String(g.clk || "20:00").split(":").map(Number), left = (m || 0) * 60 + (sec || 0);
  return Math.min(prd > 4 ? 3900 : prd * 1200, (prd - 1) * 1200 + (g.inter ? 1200 : Math.max(0, 1200 - left)));
}
// Away team's win chance at second t
function wpAt(g, t){
  const sc = [0, 0]; g.gl.forEach(x => { if(gsecOf(x) <= t) sc[x[2]]++; });
  const xg = [0, 0]; g.s.forEach(s => { if(s[0] <= t && s[2] !== "B" && !/e/.test(s[9])) xg[s[1]] += s[6] / 1000; });
  return wpModel(sc[0] - sc[1], xg[0], xg[1], t, g.prd === 5 && !done(g.st) ? t : null);
}
function wpNow(g){
  if(done(g.st)){ const w = g.t[0].sc > g.t[1].sc ? 1 : 0; return w; }
  return wpAt(g, gameElapsed(g));
}
function wpLine(g){
  if(!started(g.st)) return "";
  const a = wpNow(g), pa = Math.round(a * 100);
  return `<div class="wp-line"><span class="wp-ab" style="color:var(--away)">${esc(g.t[0].ab)} <b class="mono">${pa}%</b></span>
    <span class="wp-bar" aria-hidden="true"><i class="a" style="width:${pa}%"></i><i class="h" style="width:${100 - pa}%"></i></span>
    <span class="wp-ab" style="color:var(--home)"><b class="mono">${100 - pa}%</b> ${esc(g.t[1].ab)}</span>
    <span class="wp-lbl">${done(g.st) ? "Final" : "Win probability"}</span></div>`;
}
function wpChart(g){
  const end = gameElapsed(g), maxT = Math.max(3600, end > 3600 ? 3900 : 3600);
  const W0 = 900, H0 = 210, L = 44, R = 14, T = 12, B = 26;
  const x = t => L + t / maxT * (W0 - L - R), y = p => T + p * (H0 - T - B);   // p = away chance: 100% at the bottom? no: away on top
  const pts = []; for(let t = 0; t <= end; t += 20) pts.push([t, wpAt(g, t)]);
  g.gl.forEach(gl => { const t = gsecOf(gl); pts.push([t - .1, wpAt(g, t - 1)], [t, wpAt(g, t)]); });
  if(done(g.st)) pts.push([end, wpNow(g)]); else pts.push([end, wpAt(g, end)]);
  pts.sort((a, b) => a[0] - b[0]);
  // the line shows the home team's chance: up is home, down is away
  const Y = p => y(p);  // p is away chance: 0 at top (home certain), 1 at bottom (away certain)
  const path = pts.map(([t, p], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${Y(p).toFixed(1)}`).join("");
  const mid = Y(.5), area = `${path}L${x(pts[pts.length - 1][0]).toFixed(1)},${mid}L${x(0)},${mid}Z`;
  const per = [1200, 2400, 3600].filter(t => t < maxT).map(t => `<line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H0 - B}" class="wp-per"/>`).join("");
  const plbl = [["1st", 600], ["2nd", 1800], ["3rd", 3000], ...(maxT > 3600 ? [["OT", 3750]] : [])].map(([l, t]) => `<text x="${x(t)}" y="${H0 - 8}" class="tr-ax" text-anchor="middle">${l}</text>`).join("");
  const goals = g.gl.map(gl => { const t = gsecOf(gl); return `<circle cx="${x(t).toFixed(1)}" cy="${Y(wpAt(g, t)).toFixed(1)}" r="5" class="wp-goal" style="fill:var(--${gl[2] ? "home" : "away"})"><title>${esc(g.t[gl[2]].ab)} goal · ${gl[0] > 3 ? "OT" : "P" + gl[0]} ${gl[1]}</title></circle>`; }).join("");
  return `<section class="wp-sec"><div class="trend-head"><h3 class="pstat-h">Win probability</h3>${wpLine(g)}</div>
    <svg viewBox="0 0 ${W0} ${H0}" class="trend-svg" role="img" aria-label="Win probability through the game">
      <clipPath id="wpTop"><rect x="0" y="0" width="${W0}" height="${mid}"/></clipPath><clipPath id="wpBot"><rect x="0" y="${mid}" width="${W0}" height="${H0}"/></clipPath>
      <path d="${area}" clip-path="url(#wpTop)" style="fill:var(--home);opacity:.16"/><path d="${area}" clip-path="url(#wpBot)" style="fill:var(--away);opacity:.16"/>
      ${per}<line x1="${L}" x2="${W0 - R}" y1="${mid}" y2="${mid}" class="tr-typ"/>
      <text x="${L - 8}" y="${T + 10}" class="tr-ax" text-anchor="end">${esc(g.t[1].ab)}</text><text x="${L - 8}" y="${mid + 4}" class="tr-ax" text-anchor="end">50%</text><text x="${L - 8}" y="${H0 - B}" class="tr-ax" text-anchor="end">${esc(g.t[0].ab)}</text>
      <path d="${path}" class="wp-path"/>${goals}${plbl}</svg>
    <p class="muted small">How likely each team was to win at every point of the game, from the score, the time left and each team's share of expected goals so far. Dots are goals.</p></section>`;
}

// ---------- Lines (linemates) ----------
const openLines = new Set();
const lineKey = l => `${l[0]}-${l[1]}-${l[2].join(".")}`;
function lineRink(shots, mine, g, side){
  const pts = shots.filter(s => s[0] === mine && s[2] >= 25).map(s => { const [, res, x, y, xg] = s, r = 1 + Math.sqrt(xg / 1000) * 4.5;
    const col = `var(--${(mine ? side : 1 - side) ? "home" : "away"})`;
    return `<circle cx="${(y + 42.5).toFixed(1)}" cy="${(100 - x).toFixed(1)}" r="${r.toFixed(2)}" fill="${res === "G" ? col : res === "S" ? col : "none"}" fill-opacity="${res === "G" ? 1 : res === "S" ? .35 : 0}" stroke="${res === "G" ? "var(--surface)" : col}" stroke-width="${res === "G" ? .6 : .5}"${res === "M" ? ' stroke-dasharray="1.2 .8"' : ""}><title>${res === "G" ? "Goal" : res === "S" ? "Shot on goal" : "Missed"} · ${(xg / 1000).toFixed(2)} xG</title></circle>`; }).join("");
  return `<svg viewBox="-1 -1 87 77" class="ln-rink" role="img" aria-label="${mine ? "Shots taken" : "Shots allowed"} with this unit on the ice">
    <path d="M0,75 L0,28 A28,28 0 0 1 28,0 L57,0 A28,28 0 0 1 85,28 L85,75 Z" class="rk-ice"/>
    <line x1="0" x2="85" y1="11" y2="11" class="rk-goal"/><path d="M36.5,11 A6,6 0 0 0 48.5,11 Z" class="rk-crease"/>
    <circle cx="20.5" cy="31" r="15" class="rk-line"/><circle cx="64.5" cy="31" r="15" class="rk-line"/>
    <line x1="0" x2="85" y1="74.4" y2="74.4" class="rk-blue"/><rect x="39.5" y="7.6" width="6" height="3.4" rx=".8" class="rk-net"/>
    ${pts}<path d="M0,75 L0,28 A28,28 0 0 1 28,0 L57,0 A28,28 0 0 1 85,28 L85,75 Z" class="rk-board"/></svg>`;
}
function lineDetail(g, l){
  const [side, kind, ids, sec, cf, ca, xf, xa, gf, ga, D] = l;
  if(!D) return `<div class="ln-more muted small">More detail appears once this game's data refreshes.</div>`;
  const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, pct = (a, b) => a + b ? Math.round(a / (a + b) * 100) + "%" : "–";
  const R = RATED[g.id] || [];
  const players = ids.map(i => { const r = g.p[i], p = R.find(x => x.id === r[1]);
    return `<button type="button" class="ln-pl" data-player="${r[1]}"><span class="av sm"><span class="face" aria-hidden="true">${initials(r[3])}${mug(r[1])}</span></span>
      <span class="who"><b>${esc(r[3])}</b><span>${esc(r[4])} · ${r[5]} G, ${r[6]} A · ${E.fmtToi(r[12])} total</span></span>${p?.rating != null ? chip(p.rating) : ""}</button>`; }).join("");
  const offPct = D.off[2] + D.off[3] ? D.off[2] / (D.off[2] + D.off[3]) : null, onPct = xf + xa ? xf / (xf + xa) : null;
  const rel = onPct != null && offPct != null ? Math.round((onPct - offPct) * 100) : null;
  const cells = [
    [`${D.sf}–${D.sa}`, "Shots on goal", pct(D.sf, D.sa)], [`${D.hf}–${D.ha}`, "High-danger chances", pct(D.hf, D.ha)],
    [`${cf}–${ca}`, "Shot attempts", pct(cf, ca)], [`${(xf / 1000).toFixed(2)}–${(xa / 1000).toFixed(2)}`, "Expected goals", pct(xf, xa)],
    [`${gf}–${ga}`, "Goals", ""], [`${D.n}`, "Times on together", D.n ? `${Math.round(sec / D.n)} sec average` : ""],
    [rel == null ? "–" : `${rel > 0 ? "+" : ""}${rel} pts`, "xG share vs team without them", offPct != null ? `Team ${Math.round(offPct * 100)}% with them off` : ""]
  ];
  const perLbl = ["1st", "2nd", "3rd", "OT"], per = D.per.map((v, i) => v ? `<span><b class="mono">${mmss(v)}</b><small>${perLbl[i]}</small></span>` : "").join("");
  const goals = D.gl.length ? `<ul class="ln-goals">${D.gl.map(([t, mine, si]) => `<li><span class="mono muted">${t > 3600 ? "OT" : "P" + (Math.floor((t - 1) / 1200) + 1)} ${mmss(((t - 1) % 1200) + 1)}</span><b class="${mine ? "win" : "loss"}">${mine ? "For" : "Against"}</b> ${esc(g.p[si]?.[3] || "")}${mine ? "" : ` (${esc(g.t[1 - side].ab)})`}</li>`).join("")}</ul>` : "";
  return `<div class="ln-more">
    <div class="ln-pls">${players}</div>
    <div class="ln-grid">${cells.map(([v, k, sub]) => `<div class="pstat"><b>${v}</b><span>${k}</span><small>${sub || "&nbsp;"}</small></div>`).join("")}</div>
    <div class="ln-sub"><h4>Time together by period</h4><div class="ln-per">${per}</div></div>
    ${goals ? `<div class="ln-sub"><h4>Goals with them on</h4>${goals}</div>` : ""}
    <div class="ln-sub"><h4>Shots with them on the ice</h4><div class="ln-maps"><figure>${lineRink(D.sh, 1, g, side)}<figcaption>Taken by ${esc(g.t[side].ab)}</figcaption></figure><figure>${lineRink(D.sh, 0, g, side)}<figcaption>Allowed to ${esc(g.t[1 - side].ab)}</figcaption></figure></div>
      <p class="muted small">Filled dots are shots on goal, solid dots are goals, dashed rings missed the net. Bigger means a more dangerous chance.</p></div>
  </div>`;
}
function linesPanel(g){
  const ln = g.ln;
  if(!ln) return `<div class="muted">Line data isn't in this game's file yet. It appears once the game is reloaded.</div>`;
  if(!ln.length) return `<div class="muted">No line data yet. The NHL posts shift charts during and after the game.</div>`;
  const names = g.p;
  const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const unit = (l, n) => { const [, kind, ids, sec, cf, ca, xf, xa, gf, ga] = l, xs = xf + xa ? xf / (xf + xa) : null, cs = cf + ca ? cf / (cf + ca) : null;
    const tone = xs == null ? "" : xs >= .55 ? " good" : xs <= .45 ? " bad" : "", k = lineKey(l), isOpen = openLines.has(k);
    return `<div class="ln-unit${isOpen ? " open" : ""}"><button type="button" class="ln-head" data-line="${esc(k)}" aria-expanded="${isOpen}">
      <span class="ln-rank">${nth(n + 1)} ${kind === "F" ? "line" : "pair"}</span>
      <span class="ln-who">${ids.map(i => { const r = names[i]; return `<span class="ln-p"><span class="av sm"><span class="face" aria-hidden="true">${initials(r[3])}${mug(r[1])}</span></span><span>${esc(r[3])}</span></span>`; }).join("")}<span class="ln-chev" aria-hidden="true">${isOpen ? "▴" : "▾"}</span></span>
      <span class="ln-nums"><span><b class="mono">${mmss(sec)}</b><small>Together</small></span><span><b class="mono">${gf}–${ga}</b><small>Goals</small></span><span><b class="mono">${cs == null ? "–" : Math.round(cs * 100) + "%"}</b><small>Shot att. ${cf}–${ca}</small></span><span class="${tone}"><b class="mono">${xs == null ? "–" : Math.round(xs * 100) + "%"}</b><small>xG ${(xf / 1000).toFixed(2)}–${(xa / 1000).toFixed(2)}</small></span></span></button>
      ${isOpen ? lineDetail(g, l) : ""}</div>`; };
  return `<div class="lineups">${[0, 1].map(side => `<section class="side${side}"><div class="lineup-head"><h3>${logo(g.t[side].ab)}${esc(g.t[side].nm)}</h3></div>
      <div class="group-label label">Forward lines</div>${ln.filter(l => l[0] === side && l[1] === "F").map((l, n) => unit(l, n)).join("") || `<div class="muted small">Not enough 5-on-5 time yet.</div>`}
      <div class="group-label label">Defense pairs</div>${ln.filter(l => l[0] === side && l[1] === "D").map((l, n) => unit(l, n)).join("") || `<div class="muted small">Not enough 5-on-5 time yet.</div>`}
    </section>`).join("")}</div>
    <p class="muted small">Lines are built from the NHL's shift charts: the trios and pairs that actually played together at 5-on-5, numbered 1st to 4th by how much ice time the coach gave them. Stats are for when all of them were on the ice together. Tap a line for more. Green xG share means the unit controlled the chances; red means it was outplayed.</p>`;
}

// ---------- Head-to-head (season series) with each meeting's top-rated players ----------
const H2H = new Map(), H2H_TOP = new Map();
function h2hKey(a, b){ return [a, b].sort().join("-"); }
function loadH2H(a, b, after){
  const k = h2hKey(a, b);
  if(H2H.has(k)) return;
  H2H.set(k, { loading: true });
  api(`/api/league?view=h2h&ab=${a}&opp=${b}`).then(j => H2H.set(k, j)).catch(e => H2H.set(k, { error: e.message })).finally(after);
}
// Best-rated player on each side of a finished game (rated against the season's games, as everywhere else)
function topOf(g){
  if(!BASE?.cal) return null;
  const sc = E.scoreGame(g, W), best = [null, null];
  sc.forEach(p => { if(p.raw == null || (!p.goalie && p.toi < E.MIN_TOI_SK)) return; const r = E.calibrate(p.raw, BASE.cal[E.grpOf(p.pos)], SCALE).rating; if(!best[p.side] || r > best[p.side].rating) best[p.side] = { id: p.id, name: p.name, rating: r }; });
  return best;
}
function loadTop(id, after){
  if(H2H_TOP.has(id)) return;
  H2H_TOP.set(id, null);
  (GAMES.has(id) ? Promise.resolve(GAMES.get(id)) : api(`/api/game?id=${id}`)).then(g => H2H_TOP.set(id, { g, top: topOf(g) })).catch(() => H2H_TOP.set(id, { error: true })).finally(after);
}
function h2hSec(a, h, curId, after){
  const k = h2hKey(a, h), S = H2H.get(k);
  if(!S) loadH2H(a, h, after);
  const head = `<h3>Season series</h3>`;
  if(!S || S.loading) return `<section class="pv-sec">${head}<p class="muted small">Loading…</p></section>`;
  if(S.error) return `<section class="pv-sec">${head}<p class="muted small">${esc(S.error)}</p></section>`;
  const fin = S.games.filter(x => done(x.st) && x.id !== curId), up = S.games.filter(x => !started(x.st) && x.id !== curId);
  const wins = { [a]: 0, [h]: 0 };
  fin.forEach(x => { const w = x.as > x.hs ? x.a : x.h; wins[w] = (wins[w] || 0) + 1; });
  const sum = !fin.length ? "First meeting this season" : wins[a] === wins[h] ? `Series tied ${wins[a]}–${wins[h]}` : `${wins[a] > wins[h] ? a : h} lead ${Math.max(wins[a], wins[h])}–${Math.min(wins[a], wins[h])}`;
  const rows = fin.map(x => {
    const T = H2H_TOP.get(x.id); if(T === undefined) loadTop(x.id, after);
    const top = T?.top, wA = x.as > x.hs;
    const pl = (p, side) => p ? `<button type="button" class="h2h-p" data-player="${p.id}" title="Top-rated ${esc(side ? x.h : x.a)} player">${logo(side ? x.h : x.a)}<span>${esc(p.name)}</span>${chip(p.rating)}</button>` : "";
    return `<li><button type="button" class="h2h-game" data-gamelink="${x.id}" data-date="${x.d}"><span class="sd">${esc(tinyDay(x.d))}</span>
      <span class="sr"><span class="${wA ? "w" : ""}">${esc(x.a)} ${x.as}</span> – <span class="${wA ? "" : "w"}">${x.hs} ${esc(x.h)}</span>${x.end && x.end !== "REG" ? ` <small>(${esc(x.end)})</small>` : ""}</span></button>
      <div class="h2h-top">${T === undefined || T === null ? `<span class="muted small">Loading top players…</span>` : top ? `${pl(top[0], 0)}${pl(top[1], 1)}` : ""}</div></li>`; }).join("");
  const next = up.length ? `<p class="muted small">Still to play: ${up.map(x => `${esc(tinyDay(x.d))} ${x.a === a || x.a === h ? `${esc(x.a)} at ${esc(x.h)}` : ""}`).join(" · ")}</p>` : "";
  return `<section class="pv-sec">${head}<div class="h2h"><div class="h2h-sum"><b>${esc(sum)}</b></div>${fin.length ? `<ul class="h2h-list">${rows}</ul>` : ""}${next}</div></section>`;
}

// ---------- Accounts (Supabase: sign-in, synced favorites, followed players, fan votes) ----------
// The project URL and the public "anon" key are meant to be public; every table is locked down with row-level security.
const SUPA_URL = "https://fdowqdkjdafwdyutyrpj.supabase.co", SUPA_KEY = "sb_publishable_mCtB8znir-o338baT_MSRA_TAGISd4o";
let SB = null, USER = null, PROFILE = null, FOLLOWS = [], authMode = "signin", authMsg = "";
const VOTES = new Map();     // game id -> { tally: [[playerId, n]], mine, at, loading }
function sbInit(){
  const btn = $("acct-btn");
  if(!SUPA_URL || !SUPA_KEY || !window.supabase?.createClient){ btn.hidden = true; return; }
  try { SB = window.supabase.createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" } }); }
  catch(e){ btn.hidden = true; return; }
  btn.hidden = false; renderAcctBtn();
  SB.auth.onAuthStateChange((ev, session) => {
    if(ev === "PASSWORD_RECOVERY"){ openAuth("reset"); }
    const u = session?.user || null;
    if((u?.id || null) !== (USER?.id || null)){ USER = u; onUserChange(); }
    else USER = u;
    renderAcctBtn();
  });
}
const uname = () => PROFILE?.username || USER?.user_metadata?.username || (USER?.email || "").split("@")[0];
function renderAcctBtn(){
  const b = $("acct-btn"); if(!SB) return;
  b.innerHTML = USER ? `<span class="acct-av" aria-hidden="true">${esc((uname()[0] || "?").toUpperCase())}</span><span class="acct-nm">${esc(uname())}</span>` : "Sign in";
  b.classList.toggle("in", !!USER);
  b.setAttribute("aria-label", USER ? `Account: ${uname()}` : "Sign in");
}
function rerenderForUser(){
  if(view === "scores" && SCHED){ renderStrip(); renderGame(); renderMyTeams(); renderFollowing(); }
  else if(view === "teams") renderTeams();
  else if(view === "player" && PLAYER) renderPlayer();
  else if(view === "account") renderAccount();
}
async function onUserChange(){
  VOTES.forEach(v => { v.mine = undefined; });
  if(!USER){ PROFILE = null; FOLLOWS = []; rerenderForUser(); if(view === "account") setView("scores"); return; }
  const id = USER.id;
  const [p, f, fo] = await Promise.all([
    SB.from("profiles").select("username,fav_team,created_at").eq("id", id).maybeSingle(),
    SB.from("favorites").select("team,pos").order("pos"),
    SB.from("follows").select("player_id,name,team,created_at").order("created_at")
  ]);
  if(USER?.id !== id) return;
  PROFILE = p.data || null;
  FOLLOWS = fo.data || [];
  // favorites: keep anything starred on this device before signing in, then store the combined list on the account
  const remote = (f.data || []).map(r => r.team), merged = [...remote, ...FAVS.filter(x => !remote.includes(x))];
  if(merged.length > remote.length) await SB.from("favorites").upsert(merged.map((team, pos) => ({ user_id: id, team, pos })));
  FAVS = merged; try { localStorage.setItem(FAV_KEY, JSON.stringify(FAVS)); } catch(e){}
  renderAcctBtn(); rerenderForUser();
}
function favRemote(ab, on){
  if(!SB || !USER) return;
  (on ? SB.from("favorites").upsert({ user_id: USER.id, team: ab, pos: FAVS.indexOf(ab) }) : SB.from("favorites").delete().eq("user_id", USER.id).eq("team", ab)).then(() => {});
}
const isFollowing = id => FOLLOWS.some(f => f.player_id === id);
async function toggleFollow(p){
  if(!USER){ openAuth("signin", "Sign in to follow players. Their latest ratings show up on your Scores page."); return; }
  if(isFollowing(p.id)){ FOLLOWS = FOLLOWS.filter(f => f.player_id !== p.id); await SB.from("follows").delete().eq("user_id", USER.id).eq("player_id", p.id); }
  else { const row = { user_id: USER.id, player_id: p.id, name: p.name, team: p.team || "" }; FOLLOWS = [...FOLLOWS, row]; await SB.from("follows").upsert(row); }
  rerenderForUser();
}

// ---------- Sign-in window ----------
function openAuth(mode = "signin", msg = ""){ authMode = mode; authMsg = msg; $("auth-modal").hidden = false; renderAuth(); setTimeout(() => $("auth-modal").querySelector("input")?.focus(), 30); }
function closeAuth(){ $("auth-modal").hidden = true; }
function renderAuth(err = "", ok = ""){
  // keep what was typed when the form redraws (after an error, or switching between sign in and create account)
  const keep = {}; ["af-user", "af-email", "af-pass"].forEach(id => { const el = document.getElementById(id); if(el) keep[id] = el.value; });
  const m = authMode, T = { signin: "Sign in", signup: "Create an account", forgot: "Reset your password", reset: "Choose a new password" }[m];
  const field = (id, label, type, extra = "") => `<label class="af"><span>${label}</span><input id="${id}" type="${type}" ${extra} required></label>`;
  let body = "";
  if(m === "signin") body = field("af-email", "Email", "email", 'autocomplete="email"') + field("af-pass", "Password", "password", 'autocomplete="current-password" minlength="8"');
  if(m === "signup") body = field("af-user", "Username", "text", 'autocomplete="username" minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" title="3 to 20 letters, numbers or underscores"') + field("af-email", "Email", "email", 'autocomplete="email"') + field("af-pass", "Password", "password", 'autocomplete="new-password" minlength="8"') + `<p class="muted small">At least 8 characters. Your username is shown on your profile; your email stays private.</p>`;
  if(m === "forgot") body = field("af-email", "Email", "email", 'autocomplete="email"') + `<p class="muted small">We'll email you a link to set a new password.</p>`;
  if(m === "reset") body = field("af-pass", "New password", "password", 'autocomplete="new-password" minlength="8"');
  const foot = m === "signin" ? `<button type="button" class="link-btn" data-authmode="forgot">Forgot password?</button><span>New here? <button type="button" class="link-btn" data-authmode="signup">Create an account</button></span>`
    : m === "signup" ? `<span>Already have an account? <button type="button" class="link-btn" data-authmode="signin">Sign in</button></span>`
    : m === "forgot" ? `<button type="button" class="link-btn" data-authmode="signin">Back to sign in</button>` : "";
  $("auth-body").innerHTML = `<h2 id="auth-h">${T}</h2>${authMsg ? `<p class="auth-note">${esc(authMsg)}</p>` : ""}
    <form id="auth-form" novalidate>${body}${err ? `<p class="auth-err" role="alert">${esc(err)}</p>` : ""}${ok ? `<p class="auth-ok" role="status">${esc(ok)}</p>` : ""}
    <button type="submit" class="pill-btn primary auth-go">${{ signin: "Sign in", signup: "Create account", forgot: "Send reset link", reset: "Save password" }[m]}</button></form>
    <div class="auth-foot">${foot}</div>`;
  Object.entries(keep).forEach(([id, v]) => { const el = document.getElementById(id); if(el && v) el.value = v; });
}
const authErr = e => { const s = String(e?.message || e || ""); return /invalid login/i.test(s) ? "That email and password don't match an account." : /already registered|already been registered/i.test(s) ? "There's already an account with that email. Try signing in."
  : /database error saving new user|duplicate/i.test(s) ? "That username is taken. Try another." : /rate limit|too many/i.test(s) ? "Too many tries. Wait a few minutes and try again." : /email not confirmed/i.test(s) ? "Confirm your email first: check your inbox for the link." : s || "Something went wrong. Try again."; };
async function submitAuth(){
  const v = id => ($(id)?.value || "").trim(), go = $("auth-body").querySelector(".auth-go");
  const m = authMode; go.disabled = true;
  try {
    if(m === "signup"){
      const u = v("af-user"), e = v("af-email"), p = $("af-pass").value;
      if(!/^[A-Za-z0-9_]{3,20}$/.test(u)) throw "Usernames are 3 to 20 letters, numbers or underscores.";
      if(!/^\S+@\S+\.\S+$/.test(e)) throw "Enter a valid email address.";
      if(p.length < 8) throw "Use at least 8 characters for your password.";
      const taken = await SB.from("profiles").select("id").ilike("username", u.replace(/_/g, "\\_")).limit(1);
      if(taken.data?.length) throw "That username is taken. Try another.";
      const { data, error } = await SB.auth.signUp({ email: e, password: p, options: { data: { username: u }, emailRedirectTo: location.origin } });
      if(error) throw error;
      if(!data.session){ authMode = "signin"; renderAuth("", "Account created. Check your email for a link to confirm it, then sign in."); return; }
      closeAuth(); return;
    }
    if(m === "signin"){ const { error } = await SB.auth.signInWithPassword({ email: v("af-email"), password: $("af-pass").value }); if(error) throw error; closeAuth(); return; }
    if(m === "forgot"){ const { error } = await SB.auth.resetPasswordForEmail(v("af-email"), { redirectTo: location.origin }); if(error) throw error; renderAuth("", "If that email has an account, a reset link is on its way."); return; }
    if(m === "reset"){ const p = $("af-pass").value; if(p.length < 8) throw "Use at least 8 characters for your password."; const { error } = await SB.auth.updateUser({ password: p }); if(error) throw error; renderAuth("", "Password updated. You're signed in."); setTimeout(closeAuth, 1200); return; }
  } catch(e){ renderAuth(authErr(e)); }
  finally { const g = $("auth-body").querySelector(".auth-go"); if(g) g.disabled = false; }
}

// ---------- Following (Scores side column) ----------
function latestFor(id){
  for(const g of dayGames()){ const p = (RATED[g.id] || []).find(x => x.id === id); if(p && p.rating != null) return { live: !done(g.st), rating: p.rating, opp: g.t[1 - p.side].ab, home: p.side === 1, d: g.d, gid: g.id, line: p.line }; }
  const f = formNow(id, () => { if(view === "scores") renderFollowing(); else if(view === "account") renderAccount(); });
  if(f === undefined) return undefined;
  const g = f[0]; return g ? { rating: g.rating, opp: g.opp, home: g.home, d: g.date, gid: g.id } : null;
}
function followRow(f, big){
  const L = latestFor(f.player_id);
  const when = L ? `${L.live ? `<span class="live-tag"><i aria-hidden="true"></i>Live</span> ` : ""}${L.home ? "vs" : "at"} ${esc(L.opp)} · ${esc(tinyDay(L.d))}` : L === null ? "No rated games yet" : "Loading…";
  const a = ADV && !ADV.error ? ADV.skaters.find(x => x.id === f.player_id) || ADV.goalies.find(x => x.id === f.player_id) : null;
  return `<li><button type="button" data-player="${f.player_id}"><span class="av sm"><span class="face" aria-hidden="true">${initials(f.name)}${mug(f.player_id)}</span></span>
    <span class="who"><b>${esc(f.name)}</b><span>${f.team ? logo(f.team) + esc(f.team) + " · " : ""}${when}${big && a?.rating != null ? ` · season ${a.rating.toFixed(2)}` : ""}</span></span>${L ? chip(L.rating) : ""}</button></li>`;
}
function renderFollowing(){
  const box = $("following");
  if(!USER || !FOLLOWS.length || view !== "scores"){ box.hidden = true; sideVisibility(); return; }
  box.hidden = false; sideVisibility();
  $("following-list").innerHTML = FOLLOWS.map(f => followRow(f)).join("");
}

// ---------- Fan votes (finished games) ----------
async function loadVotes(gid, force){
  if(!SB) return;
  const V = VOTES.get(gid);
  if(V && (V.loading || (!force && Date.now() - V.at < 60000 && (V.mine !== undefined || !USER)))) return;
  VOTES.set(gid, { ...(V || {}), loading: true, at: Date.now() });
  const [t, m] = await Promise.all([SB.rpc("vote_tally", { gid }), USER ? SB.from("votes").select("player_id").eq("game_id", gid).eq("user_id", USER.id).maybeSingle() : Promise.resolve({ data: null })]);
  VOTES.set(gid, { tally: (t.data || []).map(r => [r.player_id, Number(r.votes)]), mine: m.data?.player_id ?? null, at: Date.now(), loading: false });
  if(view === "scores" && current === gid && gameTab === "ratings") renderGame();
}
async function castVote(gid, pid){
  if(!USER){ openAuth("signin", "Sign in to vote for player of the game."); return; }
  const g = GAMES.get(gid), p = (RATED[gid] || []).find(x => x.id === pid);
  if(!g || !p || !done(g.st)) return;
  const V = VOTES.get(gid) || { tally: [] };
  // update the count on screen right away, then save
  const tally = new Map(V.tally || []); if(V.mine != null) tally.set(V.mine, Math.max(0, (tally.get(V.mine) || 1) - 1)); tally.set(pid, (tally.get(pid) || 0) + 1);
  VOTES.set(gid, { tally: [...tally].filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]), mine: pid, at: Date.now() });
  renderGame();
  const { error } = await SB.from("votes").upsert({ game_id: gid, user_id: USER.id, player_id: pid, player_name: p.name, label: `${g.t[0].ab} ${g.t[0].sc}–${g.t[1].sc} ${g.t[1].ab}`, game_date: g.d }, { onConflict: "game_id,user_id" });
  loadVotes(gid, true);
  if(error) console.warn(error);
}
function fanVoteSec(g, R){
  if(!SB || !done(g.st)) return "";
  const V = VOTES.get(g.id); if(!V || (!V.loading && Date.now() - V.at > 60000)) loadVotes(g.id);
  const rated = R.filter(p => p.rating != null).sort((a, b) => b.rating - a.rating);
  if(!rated.length) return "";
  const tally = V?.tally || [], total = tally.reduce((a, x) => a + x[1], 0), mine = V?.mine ?? null;
  const byId = new Map(R.map(p => [p.id, p]));
  const pick = (p) => `<button type="button" class="fv-pick${mine === p.id ? " on" : ""}" data-vote="${p.id}" aria-pressed="${mine === p.id}"><span class="av sm side${p.side}"><span class="face" aria-hidden="true">${initials(p.name)}${mug(p.id)}</span></span><span>${esc(p.name)}</span><small>${esc(g.t[p.side].ab)}</small></button>`;
  const quick = rated.slice(0, 6), rest = rated.slice(6).sort((a, b) => a.name.localeCompare(b.name));
  const results = total ? `<div class="fv-res">${tally.slice(0, 5).map(([id, n]) => { const p = byId.get(id); if(!p) return ""; const pc = Math.round(n / total * 100);
      return `<div class="fv-row${mine === id ? " me" : ""}"><span class="fv-nm">${esc(p.name)} <small>${esc(g.t[p.side].ab)}</small></span><span class="fv-bar"><i style="width:${pc}%;background:var(--${p.side ? "home" : "away"})"></i></span><span class="fv-pc mono">${pc}%</span></div>`; }).join("")}
      <p class="muted small">${total} vote${total === 1 ? "" : "s"}${mine != null ? " · your pick is highlighted" : ""}. Our rating's player of the game: <b>${esc(rated[0].name)}</b>.</p></div>` : `<p class="muted small">No votes yet. Be the first.</p>`;
  return `<section class="fanvote"><div class="fv-head"><h3>Fans' player of the game</h3>${USER ? "" : `<button type="button" class="link-btn" data-authopen>Sign in to vote</button>`}</div>
    <div class="fv-picks">${quick.map(pick).join("")}${rest.length ? `<label class="fv-other"><span class="sr-only">Someone else</span><select data-voteother><option value="">Someone else…</option>${rest.map(p => `<option value="${p.id}"${mine === p.id ? " selected" : ""}>${esc(p.name)} (${esc(g.t[p.side].ab)})</option>`).join("")}</select></label>` : ""}</div>
    ${results}</section>`;
}

// ---------- Profile page ----------
const TEAM_NAMES = () => (TEAMS?.teams || []).map(t => [t.ab, t.name]).sort((a, b) => a[1].localeCompare(b[1]));
let MYVOTES = null;
async function loadMyVotes(){
  if(!USER) return;
  const { data } = await SB.from("votes").select("game_id,player_id,player_name,label,game_date,created_at").eq("user_id", USER.id).order("created_at", { ascending: false }).limit(25);
  MYVOTES = data || [];
  if(view === "account") renderAccount();
}
function openAccount(){ if(!USER){ openAuth(); return; } setView("account"); MYVOTES = null; loadMyVotes(); getTeams().then(() => { if(view === "account") renderAccount(); }); loadADV().then(() => { if(view === "account") renderAccount(); }); }
function renderAccount(){
  const host = $("view-account");
  if(!USER){ host.innerHTML = `<div class="card empty-card">Sign in to see your profile.</div>`; return; }
  const since = new Date(PROFILE?.created_at || USER.created_at).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const fav = PROFILE?.fav_team, favName = TEAMS?.teams?.find(t => t.ab === fav)?.name || fav;
  const teams = FAVS.map(ab => { const t = TEAMS?.teams?.find(x => x.ab === ab); return `<li><button type="button" data-team="${esc(ab)}">${logo(ab, "mt")}<span class="who"><b>${esc(t?.name || ab)}</b><span>${t ? `${t.w}-${t.l}-${t.otl} · ${t.pts} pts` : ""}</span></span></button><button type="button" class="fav on inline" data-fav="${esc(ab)}" aria-label="Remove ${esc(t?.name || ab)} from favorites">${STAR}</button></li>`; }).join("");
  const votes = MYVOTES == null ? `<p class="muted small">Loading…</p>` : !MYVOTES.length ? `<p class="muted small">No votes yet. Open a finished game and pick your player of the game.</p>`
    : `<ul class="acct-votes">${MYVOTES.map(v => `<li><button type="button" data-gamelink="${v.game_id}" data-date="${v.game_date || ""}"><span class="sd">${v.game_date ? esc(tinyDay(v.game_date)) : ""}</span><span class="lb">${esc(v.label)}</span><span class="pk">${esc(v.player_name)}</span></button></li>`).join("")}</ul>`;
  host.innerHTML = `<article class="card acct">
    <div class="acct-hero"><span class="acct-big" aria-hidden="true">${esc((uname()[0] || "?").toUpperCase())}</span>
      <div><h1>${esc(uname())}</h1><div class="sub">${fav ? `${logo(fav)}${esc(favName)} fan · ` : ""}Member since ${esc(since)}</div></div>
      <button type="button" class="pill-btn" data-signout>Sign out</button></div>
    <section class="pv-sec"><h3 class="pstat-h">Profile</h3>
      <form id="prof-form" class="prof-form">
        <label class="af"><span>Username</span><input id="pf-user" value="${esc(PROFILE?.username || "")}" minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" required></label>
        <label class="af"><span>Favorite team</span><select id="pf-team"><option value="">None</option>${TEAM_NAMES().map(([ab, nm]) => `<option value="${ab}"${ab === fav ? " selected" : ""}>${esc(nm)}</option>`).join("")}</select></label>
        <button type="submit" class="pill-btn primary">Save</button><span id="pf-msg" class="muted small" role="status"></span>
      </form>
      <p class="muted small">Signed in as ${esc(USER.email || "")}. <button type="button" class="link-btn" data-authmode-open="reset">Change password</button></p></section>
    <section class="pv-sec"><h3 class="pstat-h">Favorite teams</h3>${FAVS.length ? `<ul class="acct-list">${teams}</ul>` : `<p class="muted small">Star teams on the Teams tab and they'll show up here and first on your Scores page, on every device you sign in on.</p>`}</section>
    <section class="pv-sec"><h3 class="pstat-h">Following</h3>${FOLLOWS.length ? `<ul class="acct-list best-like">${FOLLOWS.map(f => followRow(f, true).replace("</button></li>", `</button><button type="button" class="link-btn unf" data-unfollow="${f.player_id}">Unfollow</button></li>`)).join("")}</ul>` : `<p class="muted small">Open any player and tap Follow to track his ratings here and on your Scores page.</p>`}</section>
    <section class="pv-sec"><h3 class="pstat-h">Your fan votes</h3>${votes}</section>
  </article>`;
}
async function saveProfile(){
  const u = $("pf-user").value.trim(), t = $("pf-team").value || null, msg = $("pf-msg");
  if(!/^[A-Za-z0-9_]{3,20}$/.test(u)){ msg.textContent = "Usernames are 3 to 20 letters, numbers or underscores."; return; }
  msg.textContent = "Saving…";
  const { error } = await SB.from("profiles").update({ username: u, fav_team: t }).eq("id", USER.id);
  if(error){ msg.textContent = /duplicate|unique/i.test(error.message) ? "That username is taken." : "Couldn't save. Try again."; return; }
  PROFILE = { ...(PROFILE || {}), username: u, fav_team: t }; renderAcctBtn(); renderAccount(); $("pf-msg").textContent = "Saved.";
}

async function loadGames(ids){
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, async () => {
    while(k < ids.length){ const id = ids[k++];
      try { GAMES.set(id, await api(`/api/game?id=${id}`)); } catch(e){ console.warn(e); } }
  }));
}
function pickTopGame(){
  rateAll(); let best = null;
  // a favorite team's game comes first: one that has started, otherwise its preview
  const fg = (SCHED?.games || []).filter(favGame);
  const fs = fg.find(s => started(s.st) && GAMES.has(s.id)) || fg.find(s => !started(s.st) && s.st !== "PPD");
  if(fs) return fs.id;
  dayGames().forEach(g => (RATED[g.id] || []).forEach(p => { if(p.rating != null && (!best || p.rating > best.r)) best = { r:p.rating, g:g.id }; }));
  if(best) return best.g;
  if(dayGames()[0]) return dayGames()[0].id;
  // Nothing has started: open the preview of the next game
  const up = (SCHED?.games || []).filter(s => !started(s.st) && s.st !== "PPD").sort((a,b) => (a.start || "").localeCompare(b.start || ""));
  return up[0]?.id ?? null;
}
function renderScores(){ rateAll(); renderStrip(); renderBest(); renderGame(); renderWeekBest(); renderMyTeams(); renderFollowing(); }
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
  loadWeek();
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
    if(view === "scores"){ const y = window.scrollY; renderScores(); window.scrollTo(0, y); loadWeek(); }
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
  if(t.closest("#acct-btn")){ USER ? openAccount() : openAuth(); return; }
  if(t.closest("[data-authclose]") || t.id === "auth-modal"){ closeAuth(); return; }
  const am = t.closest("[data-authmode]"); if(am){ authMode = am.dataset.authmode; authMsg = ""; renderAuth(); $("auth-modal").querySelector("input")?.focus(); return; }
  const amo = t.closest("[data-authmode-open]"); if(amo){ openAuth(amo.dataset.authmodeOpen); return; }
  if(t.closest("[data-authopen]")){ openAuth("signin", "Sign in to vote for player of the game."); return; }
  if(t.closest("[data-signout]")){ SB?.auth.signOut(); return; }
  if(t.closest("[data-follow]") && PLAYER){ toggleFollow({ id: PLAYER.id, name: `${PLAYER.first} ${PLAYER.last}`, team: PLAYER.team }); return; }
  const unf = t.closest("[data-unfollow]"); if(unf){ const f = FOLLOWS.find(x => x.player_id === +unf.dataset.unfollow); if(f) toggleFollow({ id: f.player_id, name: f.name, team: f.team }); return; }
  const vt = t.closest("[data-vote]"); if(vt){ castVote(current, +vt.dataset.vote); return; }
  if(t.closest("[data-shareclose]") || t.id === "share-modal"){ closeShare(); return; }
  const shb = t.closest("[data-share]"); if(shb){ openShare(current, +shb.dataset.share); return; }
  const cmpb = t.closest("[data-compare]"); if(cmpb){ compareWith(+cmpb.dataset.compare); return; }
  const cpk = t.closest("[data-cmppick]"); if(cpk){ const [i, id] = cpk.dataset.cmppick.split(":").map(Number); CMP[i] = id; cmpQ[i] = ""; { const o = CMP[1 - i] && cmpFind(CMP[1 - i]), me = cmpFind(id); if(o && me && cmpGrp(o) !== cmpGrp(me)) CMP[1 - i] = null; } renderStats(); if(!CMP[1 - i]) document.querySelector(`[data-cmpin="${1 - i}"]`)?.focus(); return; }
  const ccl = t.closest("[data-cmpclear]"); if(ccl){ const i = +ccl.dataset.cmpclear; CMP[i] = null; renderStats(); document.querySelector(`[data-cmpin="${i}"]`)?.focus(); return; }
  const mtg = t.closest("[data-mtg]"); if(mtg){ current = +mtg.dataset.mtg; open.clear(); gameTab = "ratings"; renderStrip(); renderGame(); $("game").scrollIntoView({ block: "start", behavior: "smooth" }); return; }
  const lnb = t.closest("[data-line]"); if(lnb){ const k = lnb.dataset.line; openLines.has(k) ? openLines.delete(k) : openLines.add(k); renderGame(); document.querySelector(`[data-line="${k}"]`)?.focus({ preventScroll: true }); return; }
  const tmp = t.closest("[data-tmap]"); if(tmp){ tmapSide = tmp.dataset.tmap; renderTeams(); return; }
  const pl = t.closest("[data-player]"); if(pl){ input.value = ""; openPlayer(+pl.dataset.player); return; }
  if(t.closest("[data-back]")){ if(history.state && history.state.view !== "scores" && history.length > 1) history.back(); else { setView("scores"); renderScores(); } return; }
  const nv = t.closest(".nav button"); if(nv){ if(nv.dataset.view === "teams") teamDetail = null; setView(nv.dataset.view); if(nv.dataset.view === "scores" && SCHED) renderScores(); return; }
  if(t.closest("#home-btn")){ if(SCHED && viewDate === SCHED.today){ setView("scores"); renderScores(); } else if(SCHED) goDay(SCHED.today); return; }
  const gc = t.closest(".gchip"); if(gc){ current = +gc.dataset.g; open.clear(); renderStrip(); renderGame(); return; }
  const wb = t.closest(".pbest-list button"); if(wb){ const gid = +wb.dataset.g, pid = +wb.dataset.p, d = wb.dataset.date; gameTab = "ratings";
    if(d === viewDate){ current = gid; open.clear(); open.add(pid); renderStrip(); renderGame(); scrollToRow(pid); }
    else goDay(d, { select: gid }).then(() => { open.add(pid); renderGame(); scrollToRow(pid); });
    return; }
  const bp = t.closest("#best-list button"); if(bp){ current = +bp.dataset.g; open.clear(); open.add(+bp.dataset.p); gameTab = "ratings"; renderStrip(); renderGame(); scrollToRow(+bp.dataset.p); return; }
  const gt = t.closest("[data-gtab]"); if(gt){ gameTab = gt.dataset.gtab; renderGame(); return; }
  const st = t.closest(".star[data-open]"); if(st){ const id = +st.dataset.open; open.add(id); renderGame(); scrollToRow(id); return; }
  const pb = t.closest(".player > button[data-id]"); if(pb){ const id = +pb.dataset.id; open.has(id) ? open.delete(id) : open.add(id); renderGame(); document.querySelector(`.player > button[data-id="${id}"]`)?.focus(); return; }
  const mf = t.closest(".seg button[data-f]"); if(mf){ mapFilter = mf.dataset.f; renderGame(); return; }
  const ptab = t.closest("[data-ptab]"); if(ptab){ playerTab = ptab.dataset.ptab; renderPlayer(); return; }
  const gl = t.closest("[data-gamelink]"); if(gl){ openGameFromPlayer(+gl.dataset.gamelink, gl.dataset.date); return; }
  if(t.id === "see-prev"){ goDay(shiftDate(viewDate, -1)); return; }
  const tsort = t.closest("[data-tsort]"); if(tsort){ const k = tsort.dataset.tsort, c = TEAM_COLS.find(x => x[0] === k), d0 = c[2] < 0 ? 1 : -1; teamSort = teamSort.k === k ? { k, d: -teamSort.d } : { k, d: d0 }; renderTeams(); return; }
  const fv = t.closest("[data-fav]"); if(fv){ toggleFav(fv.dataset.fav); view === "account" ? renderAccount() : renderTeams(); return; }
  const tl = t.closest("[data-team]"); if(tl){ openTeam(tl.dataset.team); return; }
  if(t.closest("[data-teamsback]")){ teamDetail = null; try { history.pushState({ view:"teams" }, ""); } catch(e){} renderTeams(); window.scrollTo(0, 0); return; }
  const stb = t.closest("[data-stab]"); if(stb){ standTab = stb.dataset.stab; standSort = null; renderStandings(); return; }
  const ss = t.closest("[data-ssort]"); if(ss){ const k = ss.dataset.ssort, c = STAND_COLS.find(c => c[0] === k); const d0 = c[2] < 0 ? 1 : -1; standSort = standSort?.k === k ? (standSort.d === d0 ? { k, d: -d0 } : null) : { k, d: d0 }; renderStandings(); return; }
  const stt = t.closest("[data-sttab]"); if(stt){ statsTab = stt.dataset.sttab; statsDetail = null; renderStats(); return; }
  const sa = t.closest("[data-seeall]"); if(sa){ statsDetail = { tab: statsTab, key: sa.dataset.seeall }; detailPos = statsTab === "advanced" ? advPos : "all"; detailN = 50; renderStats(); window.scrollTo(0, 0); return; }
  if(t.closest("[data-statsback]")){ statsDetail = null; renderStats(); return; }
  const dp = t.closest("[data-detpos]"); if(dp){ detailPos = dp.dataset.detpos; detailN = 50; renderStats(); return; }
  if(t.closest("[data-detmore]")){ detailN += 50; renderStats(); return; }
  const ap = t.closest("[data-advpos]"); if(ap){ advPos = ap.dataset.advpos; renderStats(); return; }
  const sh = t.closest(".shot"); if(sh) showTip(sh);
});
document.addEventListener("input", e => { const ci = e.target.closest?.("[data-cmpin]"); if(!ci) return; const i = +ci.dataset.cmpin; cmpQ[i] = ci.value; renderStats();
  const el = document.querySelector(`[data-cmpin="${i}"]`); if(el){ el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
document.addEventListener("keydown", e => { if(e.key === "Escape" && !$("share-modal").hidden) closeShare(); if(e.key === "Escape" && !$("auth-modal").hidden) closeAuth(); });
document.addEventListener("submit", e => { if(e.target.id === "auth-form"){ e.preventDefault(); submitAuth(); } else if(e.target.id === "prof-form"){ e.preventDefault(); saveProfile(); } });
document.addEventListener("change", e => { const s = e.target.closest?.("[data-voteother]"); if(s && s.value) castVote(current, +s.value); });
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
  // keep a sign-in or password-reset link's details in the address until the account library has read them
  try { history.replaceState({ view:"scores" }, "", location.pathname + (/access_token|error_description|type=recovery/.test(location.hash) ? location.hash : "")); } catch(e){}
  sbInit();   // every visit starts fresh on today's games
  renderAbout();
  api("/api/baseline").then(b => { BASE = b; renderAbout(); if(SCHED && view === "scores") renderScores(); })
    .catch(() => { $("pool-counts").textContent = " (the season comparison couldn't load, so ratings are graded against the games on screen)"; });
  try {
    const t = await api(`/api/schedule`);
    await loadDay(t.date);
  } catch(e){ showError(e); }
})();
