import * as E from "./engine.js";

// ---------- State ----------
const $ = id => document.getElementById(id);
const W = E.DEFAULTS, SCALE = E.SCALE_DEFAULT;   // fixed: everyone sees the same ratings
let BASE = null;            // season calibration from /api/baseline
let SCHED = null;           // { date, today, games } for the day being viewed
const GAMES = new Map();    // game id -> game data from /api/game
let RATED = {}, CALS = null, calSource = "season";
let viewDate = null, current = null, mapFilter = "all";
const open = new Set();
let lastUpdated = null, pollTimer = null;

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
const shortDay = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric", year:"numeric", timeZone:"UTC" });
const localTime = iso => new Date(iso).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" });
const prdName = p => p == null ? "" : p <= 3 ? ["1st","2nd","3rd"][p-1] : p === 4 ? "OT" : "SO";
const statusText = g => {
  if(live(g.st)) return g.inter ? `${prdName(g.prd)} intermission` : `${prdName(g.prd)} · ${g.clk || ""}`;
  if(done(g.st)) return g.end === "OT" ? "Final/OT" : g.end === "SO" ? "Final/SO" : "Final";
  if(g.st === "PRE") return "Pregame";
  if(g.st === "PPD") return "Postponed";
  return g.start ? localTime(g.start) : "Scheduled";
};

// ---------- Formatting helpers ----------
const sign = v => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2);
const band = r => r == null ? "na" : r >= 8 ? "elite" : r >= 7 ? "good" : r >= 6 ? "mid" : "low";
const fmt = r => r == null ? "–" : r.toFixed(1);
const pctTxt = v => v == null ? "–" : Math.round(v*100) + "%";
const ord = p => { const v = p*100; return v >= 99.95 ? "99.9" : v >= 99 ? v.toFixed(1) : String(Math.round(v)); };
const topPct = p => { const t = (1-p)*100; return t < 0.1 ? "0.1%" : t < 1 ? t.toFixed(1) + "%" : Math.round(t) + "%"; };
const GRP_NAME = { F:"forward", D:"defenseman", G:"goalie" };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
const initials = n => { const last = n.split(".").pop().trim(); return esc((n[0] + (last[0] || "")).toUpperCase()); };
const clock = s => { const p = Math.floor(s/1200) + 1, r = s % 1200; return `${p > 3 ? "OT" : "P" + p} ${String(Math.floor(r/60)).padStart(2,"0")}:${String(r%60).padStart(2,"0")}`; };

// ---------- Ratings ----------
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

// ---------- Slate ----------
function gameCard(s){
  const g = GAMES.get(s.id), R = RATED[s.id];
  const best = R ? R.filter(p => p.rating != null).sort((a,b) => b.rating - a.rating)[0] : null;
  const sc = [s.t[0].sc, s.t[1].sc], has = started(s.st);
  const win = has && done(s.st) ? (sc[0] > sc[1] ? 0 : 1) : -1;
  const status = live(s.st) ? `<span class="live-tag"><i aria-hidden="true"></i>${esc(statusText(s))}</span>` : `<span>${esc(statusText(s))}</span>`;
  return `<button type="button" class="gcard${has ? "" : " future"}" data-g="${s.id}" aria-current="${s.id === current}" ${has ? "" : "disabled"}>
    <span class="row${win === 1 ? " lost" : ""}"><span>${esc(s.t[0].ab)}</span><span class="sc">${has ? sc[0] ?? 0 : ""}</span></span>
    <span class="row${win === 0 ? " lost" : ""}"><span>${esc(s.t[1].ab)}</span><span class="sc">${has ? sc[1] ?? 0 : ""}</span></span>
    <span class="foot">${status}${best ? `<span title="Top rating">${esc(best.name.split(". ").pop())} <span class="chip ${band(best.rating)}">${fmt(best.rating)}</span></span>` : (has && !g ? `<span>Loading…</span>` : "")}</span>
  </button>`;
}
function renderSlate(){
  $("slate-h").textContent = `${dayName(viewDate)} · ${SCHED.games.length} game${SCHED.games.length === 1 ? "" : "s"}`;
  $("slate").innerHTML = SCHED.games.length ? SCHED.games.map(gameCard).join("") : `<div class="empty">No NHL games on this date.</div>`;
  $("next-day").disabled = viewDate >= shiftDate(SCHED.today, 1);
  $("today-btn").disabled = viewDate === SCHED.today;
  const anyLive = SCHED.games.some(g => live(g.st));
  $("updated").textContent = lastUpdated ? `${anyLive ? "Live · " : ""}Updated ${lastUpdated.toLocaleTimeString([], { hour:"numeric", minute:"2-digit" })}${anyLive ? " · refreshes every minute" : ""}` : "";
}
function renderLeaderboard(){
  const all = [];
  dayGames().forEach(g => (RATED[g.id] || []).forEach(p => { if(p.rating != null) all.push({ ...p, g }); }));
  $("lb-card").hidden = !all.length;
  if(!all.length) return;
  all.sort((a,b) => b.rating - a.rating || b.raw - a.raw);
  const nLive = dayGames().filter(g => live(g.st)).length;
  $("lb-sub").textContent = `${shortDay(viewDate).replace(/, \d{4}$/, "")} · ${dayGames().length} game${dayGames().length === 1 ? "" : "s"}${nLive ? ` · ${nLive} live` : ""}`;
  $("lb-h").textContent = viewDate === SCHED.today && nLive ? "Best performances so far" : "Best performances of the night";
  $("lb").innerHTML = all.slice(0,10).map((p,i) => {
    const opp = p.g.t[1-p.side].ab, line = `${esc(p.g.t[p.side].ab)} ${p.side === 0 ? "at" : "vs"} ${esc(opp)} · ${esc(p.line)}`;
    const pt = `Top ${topPct(p.pct)} of ${GRP_NAME[p.grp]} games`;
    return `<li><button type="button" data-g="${p.g.id}" data-p="${p.id}">
      <span class="lb-rank">${i+1}</span>
      <span class="av side${p.side}"><span class="face" aria-hidden="true">${initials(p.name)}</span>${chip(p.rating)}</span>
      <span class="lb-who"><b>${esc(p.name)}</b><span>${line}</span><span class="lb-pct2">${pt}</span></span>
      <span class="lb-pct">${pt}</span></button></li>`;
  }).join("");
}

// ---------- Game view ----------
function chip(r, isStar){ return `<span class="chip ${band(r)}" aria-label="Rating ${fmt(r)}">${fmt(r)}${isStar ? '<span class="star-mark" aria-hidden="true">★</span>' : ""}</span>`; }
function avatar(pl, large, isStar){ return `<span class="av${large ? " lg" : ""} side${pl.side}"><span class="face" aria-hidden="true">${initials(pl.name)}</span>${chip(pl.rating, isStar)}</span>`; }

function renderGame(){
  const host = $("game");
  const g = GAMES.get(current);
  if(!g || !RATED[g.id]){
    if(current){ host.innerHTML = `<div class="card empty">Loading game…</div>`; return; }
    const upcoming = (SCHED?.games || []).filter(s => !started(s.st) && s.st !== "PPD" && s.start).sort((a,b) => a.start.localeCompare(b.start));
    host.innerHTML = upcoming.length && !(SCHED.games || []).some(s => started(s.st))
      ? `<div class="card empty pre">No games have started yet. First puck drop is at <b>${localTime(upcoming[0].start)}</b>, and ratings appear as soon as it begins. <button type="button" class="btn sm" id="see-prev">See the previous night</button></div>` : "";
    return;
  }
  const R = RATED[g.id], names = g.p.map(r => r[3]);
  const [A, H] = g.t, fin = done(g.st), win = fin ? (A.sc > H.sc ? 0 : 1) : -1;
  const xg = side => g.s.filter(s => s[1] === side && s[2] !== "B").reduce((a,s) => a + s[6], 0) / 1000;
  const per = g.per.map(a => a.slice());
  if(fin && g.end !== "REG" && per[0].length === 3){ per[0].push(0); per[1].push(0); }
  const perHead = per[0].map((_,i) => i < 3 ? ["1st","2nd","3rd"][i] : "OT");
  const so = g.end === "SO" && fin;
  const ranked = R.filter(p => p.rating != null).sort((a,b) => b.rating - a.rating || b.raw - a.raw);
  const bestId = ranked[0]?.id;
  const stren = gl => gl[6] ? '<span class="tag">EN</span>' : gl[5] !== "EV" ? `<span class="tag">${gl[5]}</span>` : "";
  const tagLine = fin ? (g.end === "REG" ? "FINAL" : g.end === "OT" ? "FINAL · OT" : "FINAL · SHOOTOUT")
    : `<span class="live-tag"><i aria-hidden="true"></i>LIVE · ${esc(statusText(g))}</span>`;
  host.innerHTML = `
  <header class="card board">
    <div class="rink" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
    <div class="board-main">
      <div class="meta"><span class="label">NHL · ${String(g.id).slice(4,6) === "03" ? "Playoffs" : "Regular season"}</span><span class="label">${esc(shortDay(g.d))} · ${esc(g.v)}</span></div>
      <div class="score">
        <div class="team away"><span class="abbr">${esc(A.ab)}</span><span class="nm">${esc(A.nm)}</span></div>
        <div>
          <div class="final"><span class="${win === 1 ? "lose" : ""}">${A.sc}</span><span class="dash">–</span><span class="${win === 0 ? "lose" : ""}">${H.sc}</span></div>
          <div class="final-tag">${tagLine}</div>
        </div>
        <div class="team home"><span class="abbr">${esc(H.ab)}</span><span class="nm">${esc(H.nm)}</span></div>
      </div>
      <div class="xg-line">Expected goals <b class="mono">${xg(0).toFixed(2)}</b> – <b class="mono">${xg(1).toFixed(2)}</b></div>
      <div class="periods"><table aria-label="Goals by period">
        <thead><tr><th></th>${perHead.map(h => `<th>${h}</th>`).join("")}${so ? "<th>SO</th>" : ""}<th>T</th><th>SOG</th></tr></thead>
        <tbody>${[0,1].map(s => `<tr><td>${esc(g.t[s].ab)}</td>${per[s].map(v => `<td>${v}</td>`).join("")}${so ? `<td>${s === win ? 1 : 0}</td>` : ""}<td class="tot">${g.t[s].sc}</td><td class="tot">${g.t[s].sog}</td></tr>`).join("")}</tbody>
      </table></div>
      <details class="goals"${g.gl.length ? "" : " hidden"}><summary>Scoring summary (${g.gl.length} goal${g.gl.length === 1 ? "" : "s"}${so ? ", plus shootout" : ""})</summary>
        <ul class="goal-list">${g.gl.map(gl => `<li><span class="mono">${gl[0] > 3 ? "OT" : "P" + gl[0]} ${gl[1]}</span><span class="tm" style="color:var(--${gl[2] ? "home" : "away"})">${esc(g.t[gl[2]].ab)}</span><span><b>${esc(names[gl[3]] || "Unknown")}</b>${stren(gl)} <span class="muted">· ${gl[4].length ? gl[4].map(i => esc(names[i])).join(", ") : "Unassisted"}</span></span></li>`).join("")}</ul>
      </details>
    </div>
  </header>

  ${ranked.length ? `<section aria-labelledby="stars-h" style="display:flex;flex-direction:column;gap:10px">
    <h2 id="stars-h" class="label" style="font-size:13px">${fin ? "Three stars by rating" : "Top rated so far"}</h2>
    <div class="stars">${ranked.slice(0,3).map((p,i) => `
      <div class="card star${i === 0 ? " first" : ""}">${avatar(p, true, false)}
        <div class="who"><span class="rank">${fin ? ["1st star · Player of the game","2nd star","3rd star"][i] : ["Leading","2nd","3rd"][i]}</span>
        <b>${esc(p.name)}</b><span>${esc(g.t[p.side].ab)} · Top ${topPct(p.pct)} of ${GRP_NAME[p.grp]} games</span></div></div>`).join("")}</div>
  </section>` : ""}

  <div class="analysis">
    <section class="card panel-pad" aria-labelledby="ts-h">
      <div class="panel-head"><h2 id="ts-h">Team stats</h2><span class="label">All situations</span></div>
      <div class="ts-key"><span><i style="background:var(--away)"></i>${esc(A.ab)}</span><span>${esc(H.ab)}<i style="background:var(--home)"></i></span></div>
      <div class="tstats">${teamStats(g)}</div>
    </section>
    <section class="card panel-pad" aria-labelledby="map-h">
      <div class="panel-head">
        <h2 id="map-h">Shot map</h2>
        <div class="seg" role="group" aria-label="Game situation" id="map-filter">
          <button type="button" data-f="all" aria-pressed="${mapFilter === "all"}">All</button>
          <button type="button" data-f="ev" aria-pressed="${mapFilter === "ev"}">Even strength</button>
          <button type="button" data-f="pp" aria-pressed="${mapFilter === "pp"}">Power play</button>
        </div>
      </div>
      <div class="map-wrap" id="map-wrap"></div>
      <div class="map-legend">
        <span><svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="var(--muted)" stroke="var(--surface)" stroke-width="1.5"/></svg>Goal</span>
        <span><svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="var(--muted)" fill-opacity=".35" stroke="var(--muted)"/></svg>Shot on goal</span>
        <span><svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="var(--surface)" stroke="var(--muted)" stroke-dasharray="2 1.2"/></svg>Missed net</span>
        <span>Bigger dot = higher expected-goal value</span>
      </div>
      <div class="avg" id="map-summary"></div>
    </section>
  </div>

  <div class="lineups">${[0,1].map(side => {
    const mine = R.filter(p => p.side === side);
    const groups = [["Forwards", mine.filter(p => !p.goalie && p.pos !== "D")], ["Defense", mine.filter(p => p.pos === "D")], ["Goalies", mine.filter(p => p.goalie && !p.dnp)]];
    const rated = mine.filter(p => p.rating != null), avg = rated.length ? rated.reduce((a,p) => a + p.rating, 0) / rated.length : null;
    return `<section class="card lineup side${side}" aria-label="${esc(g.t[side].nm)} lineup">
      <div class="lineup-head"><h2>${esc(g.t[side].nm)}</h2><span class="avg">${avg == null ? "" : `Team average <b class="mono">${avg.toFixed(2)}</b>`}</span></div>
      ${groups.map(([lbl, arr]) => `<div class="group-label label">${lbl}</div>` + [...arr].sort((a,b) => (b.rating ?? -1) - (a.rating ?? -1)).map(p => playerRow(p, bestId)).join("")).join("")}
    </section>`; }).join("")}</div>`;
  drawMap();
}

function teamStats(g){
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
  return rows.map(([n,a,b,d]) => {
    const tot = a + b || 1;
    return `<div class="ts-row"><span class="v${a > b ? " lead" : ""}">${a.toFixed(d)}</span><span class="nm">${n}</span><span class="v r${b > a ? " lead" : ""}">${b.toFixed(d)}</span>
      <span class="bar" aria-hidden="true"><i class="a" style="width:${(a/tot*100).toFixed(1)}%"></i><i class="h" style="width:${(b/tot*100).toFixed(1)}%"></i></span></div>`;
  }).join("");
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
function leagueBox(pl){
  if(pl.rating == null) return "";
  const cal = CALS[pl.grp], who = GRP_NAME[pl.grp];
  const pool = calSource === "season" ? `${cal.n.toLocaleString()} ${who} games this season` : `${cal.n} ${who} games on this page`;
  const above = pl.raw > cal.q[200];
  return `<div class="league">
    <div class="league-top"><b>${above ? `Best ${who} game in the comparison set` : `Better than ${ord(pl.pct)}% of ${who} games`}</b><span class="avg">Compared with ${pool}</span></div>
    <div class="pbar" aria-hidden="true"><i style="width:${(pl.pct*100).toFixed(1)}%;background:var(--r-${band(pl.rating)})"></i><span class="tick" style="left:calc(50% - 1px)"></span></div>
    <div class="pscale"><span>Worst</span><span>Typical (${SCALE.center.toFixed(1)})</span><span>Best</span></div>
  </div>`;
}
function playerRow(pl, bestId){
  const isOpen = open.has(pl.id);
  let bd = "";
  if(isOpen){
    bd = `<div class="breakdown" id="bd-${pl.id}">`;
    if(pl.note) bd += `<div class="bd-note">${esc(pl.note)}</div>`;
    if(!pl.dnp){
      bd += leagueBox(pl) + advGrid(pl) + `<div class="bd">`;
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
    ${avatar(pl, false, pl.id === bestId)}
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
  $("map-summary").textContent = `Showing ${n(0)} ${g.t[0].ab} and ${n(1)} ${g.t[1].ab} unblocked shots · xG ${x(0).toFixed(2)} – ${x(1).toFixed(2)}`;
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

// ---------- Rating scale explainer ----------
function renderScale(){
  const c = SCALE.center, s = SCALE.spread;
  $("scale-formula").textContent = `${c.toFixed(1)} + ${s.toFixed(2)} × z`;
  const pct = v => v >= 99.95 ? "99.9" : v >= 99 ? v.toFixed(1) : String(Math.round(v));
  const rows = [`<tr><td class="mono">${c.toFixed(1)}</td><td>Half of all games at his position</td><td>The typical game</td></tr>`];
  [7,8,9,10].forEach(r => { if(r <= c + 0.05) return; const z = (r - c)/s, share = 1 - E.normCdf(z);
    rows.push(`<tr><td class="mono">${r === 10 ? "10.0" : r.toFixed(1) + "+"}</td><td>${pct(E.normCdf(z)*100)}%</td><td>About 1 in ${Math.max(2, Math.round(1/share)).toLocaleString()} games</td></tr>`); });
  $("scale-body").innerHTML = rows.join("");
  if(BASE){ const b = BASE.cal; $("pool-counts").textContent = `: ${b.F.n.toLocaleString()} forward games, ${b.D.n.toLocaleString()} defenseman games, and ${b.G.n.toLocaleString()} goalie games from ${BASE.games.toLocaleString()} games through ${shortDay(BASE.through).replace(/^\w+, /, "")}`;
    $("season-note").textContent = `${String(BASE.season).slice(0,4)}–${String(BASE.season).slice(6)} season`; }
}
function renderAll(){ rateAll(); renderSlate(); renderLeaderboard(); renderGame(); renderScale(); }

// ---------- Loading ----------
async function loadGames(ids){
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, async () => {
    while(k < ids.length){ const id = ids[k++];
      try { GAMES.set(id, await api(`/api/game?id=${id}`)); } catch(e){ console.warn(e); } }
  }));
}
async function loadDay(date, { keepGame = false } = {}){
  viewDate = date;
  SCHED = await api(`/api/schedule?date=${date}`);
  if(!keepGame || !SCHED.games.some(g => g.id === current)){ open.clear(); current = null; }
  lastUpdated = new Date();
  renderAll();
  const need = SCHED.games.filter(g => started(g.st) && (!GAMES.has(g.id) || !done(GAMES.get(g.id).st))).map(g => g.id);
  await loadGames(need);
  if(!current){
    rateAll();
    let best = null;
    dayGames().forEach(g => (RATED[g.id] || []).forEach(p => { if(p.rating != null && (!best || p.rating > best.r)) best = { r:p.rating, g:g.id }; }));
    current = best?.g ?? dayGames()[0]?.id ?? null;
  }
  setHash();
  renderAll();
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
    const y = window.scrollY; renderAll(); window.scrollTo(0, y);
  } catch(e){ $("updated").textContent = `Couldn't refresh: ${e.message}`; }
  schedulePoll();
}
function schedulePoll(){
  clearTimeout(pollTimer);
  if(!SCHED) return;
  const anyLive = SCHED.games.some(g => live(g.st));
  const soon = SCHED.games.some(g => !started(g.st) && g.start && new Date(g.start) - Date.now() < 30*60*1000 && g.st !== "PPD");
  const recentDone = SCHED.games.some(g => done(g.st)) && viewDate >= shiftDate(SCHED.today, -1) && SCHED.games.some(g => !started(g.st) || live(g.st));
  if(anyLive || soon) pollTimer = setTimeout(refresh, 60*1000);
  else if(recentDone || viewDate >= SCHED.today) pollTimer = setTimeout(refresh, 5*60*1000);
  else pollTimer = setTimeout(refresh, 15*60*1000);
}
function setHash(){ try { if(location.hash) history.replaceState(null, "", location.pathname); } catch(e){} }

// ---------- Events ----------
function selectGame(id, playerId){
  current = id; open.clear(); if(playerId) open.add(playerId);
  setHash(); renderSlate(); renderGame();
  if(playerId){ const row = document.querySelector(`.player[data-row="${playerId}"]`); if(row){ row.scrollIntoView({ block:"center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); row.querySelector("button")?.focus({ preventScroll:true }); } }
}
document.addEventListener("click", e => {
  const gc = e.target.closest(".gcard"); if(gc && !gc.disabled){ selectGame(+gc.dataset.g); $("game").scrollIntoView({ block:"start" }); return; }
  const lb = e.target.closest(".lb-list button"); if(lb){ selectGame(+lb.dataset.g, +lb.dataset.p); return; }
  const pb = e.target.closest(".player > button[data-id]"); if(pb){ const id = +pb.dataset.id; open.has(id) ? open.delete(id) : open.add(id); renderGame(); document.querySelector(`.player > button[data-id="${id}"]`)?.focus(); return; }
  const mf = e.target.closest("#map-filter button"); if(mf){ mapFilter = mf.dataset.f; document.querySelectorAll("#map-filter button").forEach(x => x.setAttribute("aria-pressed", x === mf)); drawMap(); return; }
  const sh = e.target.closest(".shot"); if(sh) showTip(sh);
});
document.addEventListener("mouseover", e => { const el = e.target.closest(".shot"); if(el) showTip(el); });
document.addEventListener("mouseout", e => { if(e.target.closest(".shot")){ const t = $("tip"); if(t) t.hidden = true; } });
document.addEventListener("focusin", e => { const el = e.target.closest(".shot"); if(el) showTip(el); });
document.addEventListener("focusout", e => { if(e.target.closest(".shot")){ const t = $("tip"); if(t) t.hidden = true; } });
const goDay = d => { current = null; $("slate").innerHTML = `<div class="empty">Loading games…</div>`; $("game").innerHTML = ""; loadDay(d).catch(showError); };
$("prev-day").addEventListener("click", () => goDay(shiftDate(viewDate, -1)));
$("next-day").addEventListener("click", () => goDay(shiftDate(viewDate, 1)));
$("today-btn").addEventListener("click", () => goDay(SCHED.today));
document.addEventListener("click", e => { if(e.target.id === "see-prev") goDay(shiftDate(viewDate, -1)); });
document.addEventListener("visibilitychange", () => { if(!document.hidden && SCHED && (viewDate === SCHED.today || SCHED.games.some(g => live(g.st)))) refresh(); });

let raf = 0;
const rerender = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { const y = window.scrollY; renderAll(); window.scrollTo(0, y); }); };

function showError(e){ $("slate").innerHTML = `<div class="empty">${esc(e.message || String(e))}</div>`; }

// ---------- Boot ----------
(async function boot(){
  renderScale();
  api("/api/baseline").then(b => { BASE = b; if(SCHED) rerender(); else renderScale(); })
    .catch(e => { $("pool-counts").textContent = " (the season comparison couldn't load, so ratings are graded against the games on this page)"; });
  try {
    setHash();                                   // drop any old #game link so every visit starts fresh
    const t = await api(`/api/schedule`);
    await loadDay(t.date);
  } catch(e){ showError(e); }
})();
