// Builds compact game data from the NHL's public feeds.
// Game format (read by public/engine.js and public/index.html):
//   p:  skaters [side,id,num,name,pos,G,A,+/-,PIM,hits,PPG,SOG,toiSec,blocks,giveaways,takeaways,FOwon,FOlost,penTaken,penDrawn,CF,CA,xGF,xGA,GF,GA]
//       (the last six are on-ice at even strength; xG in thousandths), then goalies [side,id,num,name,"G",SA,SV,toiSec,decision]
//   s:  shots [gameSec, side, result G/S/M/B, x, y, shotTypeIdx, xG*1000, shooterIdx, goalieIdx, flags, highDanger]
//       flags: r rebound, u rush, p power play, s shorthanded, e empty net
//   gl: goals [period, "mm:ss", side, scorerIdx, [assistIdx...], "EV"|"PP"|"SH", emptyNet 0/1]
import { SHOT_TYPES, xgModel, isHD } from "../public/engine.js";
import { moneyPuckGame, applyMoneyPuck } from "./moneypuck.js";

export const WEB = "https://api-web.nhle.com/v1";
const STATS = "https://api.nhle.com/stats/rest/en";
const REPORTS = "https://www.nhl.com/scores/htmlreports";
const UA = { "user-agent": "Mozilla/5.0 (IceRatings)" };

export async function getJSON(url){
  const r = await fetch(url, { headers: UA });
  if(!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function getText(url){
  const r = await fetch(url, { headers: UA });
  if(!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
const mmss = t => { const [m,s] = String(t).split(":").map(Number); return m*60 + (s||0); };
const LIVE_STATES = ["LIVE", "CRIT"];
const DONE_STATES = ["OFF", "FINAL"];
export const isLive = st => LIVE_STATES.includes(st);
export const isDone = st => DONE_STATES.includes(st);

// ---------- Schedule ----------
export async function schedule(date){
  const j = await getJSON(`${WEB}/score/${date}`);
  return (j.games || []).filter(g => g.gameType === 2 || g.gameType === 3).map(g => ({
    id: g.id, d: g.gameDate, st: g.gameState, start: g.startTimeUTC,
    prd: g.periodDescriptor?.number || null, ptype: g.periodDescriptor?.periodType || null,
    clk: g.clock?.timeRemaining || null, inter: !!g.clock?.inIntermission,
    end: g.gameOutcome?.lastPeriodType || null,
    t: [g.awayTeam, g.homeTeam].map(t => ({ ab: t.abbrev, nm: t.name?.default || t.abbrev, sc: t.score ?? null, sog: t.sog ?? null }))
  }));
}

// ---------- Shifts ----------
async function apiShifts(id){
  const j = await getJSON(`${STATS}/shiftcharts?cayenneExp=gameId=${id}`);
  return (j.data || []).filter(s => s.typeCode === 517 && s.startTime && s.endTime && s.period <= 4)
    .map(s => ({ pid: s.playerId, a: (s.period-1)*1200 + mmss(s.startTime), b: (s.period-1)*1200 + mmss(s.endTime) }));
}
const strip = h => h.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
// Official time-on-ice reports (TV = visitor, TH = home). Used when the shift-chart API has no data for a game.
async function htmlShifts(id, g){
  const season = String(id).slice(0,4), yr = `${season}${+season+1}`, num = String(id).slice(-6);
  const out = [];
  for(const [code, side] of [["TV",0],["TH",1]]){
    let html;
    try { html = await getText(`${REPORTS}/${yr}/${code}${num}.HTM`); } catch(e){ continue; }
    const parts = html.split(/<td[^>]*class="[^"]*playerHeading[^"]*"[^>]*>/i).slice(1);
    parts.forEach(part => {
      const head = strip(part.slice(0, part.indexOf("</td>")));
      const sweater = parseInt(head, 10);
      const r = g.p.find((r,i) => i < g.g0 && r[0] === side && r[2] === sweater);
      if(!r) return;
      const rows = part.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
      for(const row of rows){
        const td = (row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(strip);
        if(td[0] === "Per" || /TOT/.test(td[0] || "")) break;
        if(td.length >= 5 && /^\d+$/.test(td[0])){
          const per = td[1] === "OT" ? 4 : parseInt(td[1], 10);
          if(per >= 1 && per <= 4){
            const a = mmss(td[2].split("/")[0].trim()), b = mmss(td[3].split("/")[0].trim());
            out.push({ pid: r[1], a: (per-1)*1200 + a, b: (per-1)*1200 + b });
          }
        }
      }
    });
  }
  return out;
}

// ---------- One game ----------
// opts.base: this site's own URL, so finished games can use MoneyPuck's expected goals (see lib/moneypuck.js)
export async function buildGame(id, opts = {}){
  const [box, pbp] = await Promise.all([ getJSON(`${WEB}/gamecenter/${id}/boxscore`), getJSON(`${WEB}/gamecenter/${id}/play-by-play`) ]);
  const HOME = pbp.homeTeam.id, AWAY = pbp.awayTeam.id;
  const sideOfTeam = t => t === HOME ? 1 : 0;
  const roster = [], idx = {};
  const pbs = box.playerByGameStats || { awayTeam:{forwards:[],defense:[],goalies:[]}, homeTeam:{forwards:[],defense:[],goalies:[]} };
  const addSkater = (side, p) => { idx[p.playerId] = roster.length;
    roster.push([side, p.playerId, p.sweaterNumber, p.name.default, p.position, p.goals||0, p.assists||0, p.plusMinus||0, p.pim||0, p.hits||0, p.powerPlayGoals||0, p.sog||0, mmss(p.toi||"0:00"), p.blockedShots||0, p.giveaways||0, p.takeaways||0, 0,0,0,0, 0,0,0,0,0,0]); };
  const addGoalie = (side, p) => { idx[p.playerId] = roster.length;
    roster.push([side, p.playerId, p.sweaterNumber, p.name.default, "G", p.shotsAgainst||0, p.saves||0, mmss(p.toi||"00:00"), p.decision||""]); };
  [["awayTeam",0],["homeTeam",1]].forEach(([k,side]) => { (pbs[k].forwards||[]).forEach(p=>addSkater(side,p)); (pbs[k].defense||[]).forEach(p=>addSkater(side,p)); });
  const g0 = roster.length;
  [["awayTeam",0],["homeTeam",1]].forEach(([k,side]) => (pbs[k].goalies||[]).forEach(p=>addGoalie(side,p)));
  const teamOfId = {}; (pbp.rosterSpots||[]).forEach(r => teamOfId[r.playerId] = r.teamId);
  const R = i => i == null ? -1 : (idx[i] ?? -1);

  const plays = (pbp.plays||[]).filter(p => p.periodDescriptor?.periodType !== "SO");
  const gsec = p => (p.periodDescriptor.number-1)*1200 + mmss(p.timeInPeriod);
  const sideBy = {}; plays.forEach(p => { if(p.homeTeamDefendingSide) sideBy[p.periodDescriptor.number] = p.homeTeamDefendingSide; });
  const first = sideBy[1] || "right";
  const homeDef = per => sideBy[per] || (per % 2 ? first : (first === "right" ? "left" : "right"));
  const attackSign = (team, per) => { const homeAttack = homeDef(per) === "right" ? -1 : 1; return team === HOME ? homeAttack : -homeAttack; };
  const isShot = t => ["shot-on-goal","missed-shot","goal","blocked-shot"].includes(t);
  const shotTeam = d => d.typeDescKey === "blocked-shot" ? (teamOfId[d.details?.shootingPlayerId] || (d.details?.eventOwnerTeamId === HOME ? AWAY : HOME)) : d.details?.eventOwnerTeamId;

  const shots = [], goals = [];
  plays.forEach((p, i) => {
    const d = p.details || {}, t = gsec(p), per = p.periodDescriptor.number;
    if(p.typeDescKey === "faceoff"){ const w = R(d.winningPlayerId), l = R(d.losingPlayerId); if(w>=0 && w<g0) roster[w][16]++; if(l>=0 && l<g0) roster[l][17]++; }
    if(p.typeDescKey === "penalty" && ["MIN","MAJ","BEN"].includes(d.typeCode)){
      const c = R(d.committedByPlayerId), dr = R(d.drawnByPlayerId);
      if(c>=0 && c<g0) roster[c][18]++; if(dr>=0 && dr<g0) roster[dr][19]++;
    }
    if(!isShot(p.typeDescKey)) return;
    const shooterId = d.shootingPlayerId || d.scoringPlayerId;
    const team = shotTeam(p);
    const sgn = attackSign(team, per);
    const sc = p.situationCode || "1551";
    const aG = +sc[0], aS = +sc[1], hS = +sc[2], hG = +sc[3];
    const mySk = team === HOME ? hS : aS, opSk = team === HOME ? aS : hS, opG = team === HOME ? aG : hG;
    let rush = false;
    for(let j=i-1; j>=0; j--){ const q = plays[j]; if(t - gsec(q) > 4) break; const qd = q.details || {};
      if(qd.xCoord != null && !isShot(q.typeDescKey) && q.typeDescKey !== "faceoff" && qd.xCoord*sgn < 25) rush = true; }
    let fl = ""; if(rush) fl += "u"; if(mySk > opSk) fl += "p"; if(mySk < opSk) fl += "s"; if(opG === 0) fl += "e";
    const x = Math.round((d.xCoord ?? 0)*sgn), y = Math.round((d.yCoord ?? 0)*sgn);
    const res = {"goal":"G","shot-on-goal":"S","missed-shot":"M","blocked-shot":"B"}[p.typeDescKey];
    const ti = SHOT_TYPES.indexOf(d.shotType || "");
    shots.push([t, sideOfTeam(team), res, x, y, ti < 0 ? 11 : ti, 0, R(shooterId), R(d.goalieInNetId), fl, 0]);
    if(res === "G"){
      const str = /p/.test(fl) && !/e/.test(fl) ? "PP" : /s/.test(fl) ? "SH" : "EV";
      goals.push([per, p.timeInPeriod, sideOfTeam(team), R(d.scoringPlayerId), [R(d.assist1PlayerId), R(d.assist2PlayerId)].filter(v => v >= 0), str, opG === 0 ? 1 : 0]);
    }
  });
  // Rebounds (an unblocked attempt by the same team within 3 seconds), then expected goals
  shots.forEach((s, i) => {
    for(let j=i-1; j>=0; j--){ const q = shots[j]; if(s[0]-q[0] > 3) break; if(q[1] === s[1] && (q[2] === "S" || q[2] === "M")){ s[9] = "r" + s[9]; break; } }
    if(s[2] !== "B"){ s[6] = Math.round(xgModel(s[3], s[4], SHOT_TYPES[s[5]], s[9])*1000); s[10] = isHD(s[3], s[4]); }
  });
  // Finished games: use MoneyPuck's expected goals where its nightly file has the game
  let xgSrc = "model", xgCov = 0;
  if(opts.base && isDone(pbp.gameState)){
    try { const mp = await moneyPuckGame(id, opts.base); if(mp){ xgCov = applyMoneyPuck(shots, roster, mp); if(xgCov >= 0.9) xgSrc = "moneypuck"; } } catch(e){}
  }

  const tA = box.awayTeam, tH = box.homeTeam;
  const g = {
    id, d: pbp.gameDate, v: pbp.venue?.default || "", st: pbp.gameState,
    end: pbp.gameOutcome?.lastPeriodType || null,
    prd: pbp.periodDescriptor?.number || null, clk: pbp.clock?.timeRemaining || null, inter: !!pbp.clock?.inIntermission,
    t: [{ab:tA.abbrev, nm:tA.commonName?.default || tA.abbrev, sc:tA.score ?? 0, sog:tA.sog ?? 0},
        {ab:tH.abbrev, nm:tH.commonName?.default || tH.abbrev, sc:tH.score ?? 0, sog:tH.sog ?? 0}],
    g0, p: roster, s: shots, gl: goals, xs: xgSrc, xc: Math.round(xgCov * 1000) / 1000
  };
  const maxPer = Math.max(3, g.prd && g.prd <= 4 ? g.prd : 3, ...goals.map(x => x[0]));
  g.per = [0,1].map(side => Array.from({length:maxPer}, (_,k) => goals.filter(x => x[2] === side && x[0] === k+1).length));

  // On-ice at even strength from shift data
  let sh = [];
  try { sh = await apiShifts(id); } catch(e){}
  const elapsed = Math.max(0, ...shots.map(s => s[0]));
  if(sh.length < 30 * Math.max(1, elapsed/600)) { try { const h = await htmlShifts(id, g); if(h.length > sh.length) sh = h; } catch(e){} }
  const sk = sh.map(s => ({ i: idx[s.pid], a: s.a, b: s.b })).filter(s => s.i != null && s.i < g0);
  shots.forEach(s => {
    const [t, side, res, , , , xg, , , fl] = s;
    if(/[pse]/.test(fl)) return;
    sk.forEach(z => { if(z.a < t && t <= z.b){ const r = roster[z.i], mine = r[0] === side;
      r[mine?20:21]++; r[mine?22:23] += xg; if(res === "G") r[mine?24:25]++; } });
  });
  try { g.ln = buildLines(roster, g0, sk, shots); } catch(e){ g.ln = []; }
  return g;
}

// Lines: forward trios and defense pairs that played the most 5-on-5 time together, with their results while all of them were on.
// Each team's lines come out in the coach's order (1st line first), ranked by how much ice time their players get.
// Each entry: [side, "F"|"D", [roster index...], seconds together, shot attempts for, against, xG for x1000, xG against x1000, goals for, against]
function buildLines(roster, g0, sk, shots){
  if(!sk.length) return [];
  const T = Math.max(3600, ...sk.map(z => z.b)) + 1;
  const on = new Map();
  sk.forEach(z => { let a = on.get(z.i); if(!a){ a = new Uint8Array(T); on.set(z.i, a); } for(let t = Math.max(0, z.a + 1); t <= Math.min(T - 1, z.b); t++) a[t] = 1; });
  // 5-on-5 seconds: five skaters on for each side (from the shift charts)
  const cnt = [new Uint8Array(T), new Uint8Array(T)];
  on.forEach((a, i) => { const c = cnt[roster[i][0]]; for(let t = 0; t < T; t++) if(a[t]) c[t]++; });
  const ev = new Uint8Array(T); for(let t = 0; t < T; t++) ev[t] = cnt[0][t] === 5 && cnt[1][t] === 5 ? 1 : 0;
  const together = ids => { let n = 0; const arrs = ids.map(i => on.get(i)); for(let t = 0; t < T; t++){ if(!ev[t]) continue; let all = 1; for(const a of arrs) if(!a[t]){ all = 0; break; } n += all; } return n; };
  const out = [];
  for(const side of [0, 1]){
    for(const [kind, size, want] of [["F", 3, 4], ["D", 2, 3]]){
      let pool = [...on.keys()].filter(i => i < g0 && roster[i][0] === side && (kind === "D" ? roster[i][4] === "D" : roster[i][4] !== "D"));
      const combos = [];
      const rec = (start, pick) => { if(pick.length === size){ combos.push([...pick]); return; } for(let k = start; k < pool.length; k++){ pick.push(pool[k]); rec(k + 1, pick); pick.pop(); } };
      rec(0, []);
      const scored = combos.map(c => [c, together(c)]).sort((a, b) => b[1] - a[1]);
      const used = new Set(), grp = [];
      for(const [c, sec] of scored){
        if(grp.length >= want) break;
        if(c.some(i => used.has(i))) continue;
        c.forEach(i => used.add(i));
        const arrs = c.map(i => on.get(i)), allOn = t => t >= 0 && t < T && ev[t] && arrs.every(a => a[t]);
        let cf = 0, ca = 0, xf = 0, xa = 0, gf = 0, ga = 0;
        // details: shots on goal, high-danger chances, the shots themselves (for a map), goals, stretches together, time by period,
        // and the team's 5-on-5 results with this unit off the ice
        const D = { sf: 0, sa: 0, hf: 0, ha: 0, sh: [], gl: [], n: 0, per: [0, 0, 0, 0], off: [0, 0, 0, 0] };
        shots.forEach(s => { const [t, sd, res, x, y, , xg, si, , fl, hd] = s; if(/[pse]/.test(fl)) return;
          if(!allOn(t)){ if(ev[t]){ const m = sd === side; D.off[m ? 0 : 1]++; if(res !== "B"){ D.off[m ? 2 : 3] += xg; } } return; }
          const mine = sd === side;
          if(mine){ cf++; if(res !== "B"){ xf += xg; if(res === "G") gf++; } } else { ca++; if(res !== "B"){ xa += xg; if(res === "G") ga++; } }
          if(res === "S" || res === "G") D[mine ? "sf" : "sa"]++;
          if(res !== "B" && hd) D[mine ? "hf" : "ha"]++;
          if(res !== "B") D.sh.push([mine ? 1 : 0, res, x, y, xg]);
          if(res === "G") D.gl.push([t, mine ? 1 : 0, si]); });
        let prev = 0; for(let t = 0; t < T; t++){ const all = ev[t] && arrs.every(a => a[t]); if(all){ D.per[Math.min(3, Math.floor((t - 1) / 1200))]++; if(!prev) D.n++; } prev = all ? 1 : 0; }
        D.off[2] = Math.round(D.off[2]); D.off[3] = Math.round(D.off[3]);
        grp.push([side, kind, c.sort((a, b) => a - b), sec, cf, ca, xf, xa, gf, ga, D]);
      }
      // 1st line, 2nd line...: the coach's order, read from how much total ice time its players get (power play and penalty kill included,
      // since top units get those minutes too)
      const avg = l => l[2].reduce((x, i) => x + (roster[i][12] || 0), 0) / l[2].length;
      grp.map(l => [l, avg(l)]).sort((a, b) => b[1] - a[1]).forEach(([l]) => out.push(l));
    }
  }
  return out;
}

// ---------- Season ----------
export async function seasonInfo(today){
  try {
    const j = await getJSON(`${WEB}/standings-season`);
    const seasons = (j.seasons || []).filter(s => s.standingsStart && s.standingsStart <= today).sort((a,b) => b.id - a.id);
    if(seasons.length) return { id: seasons[0].id, start: seasons[0].standingsStart };
  } catch(e){}
  return { id: 20262027, start: "2026-09-29" };
}
export function datesBetween(a, b){
  const out = []; const d = new Date(a + "T12:00:00Z"), end = new Date(b + "T12:00:00Z");
  while(d <= end){ out.push(d.toISOString().slice(0,10)); d.setUTCDate(d.getUTCDate()+1); }
  return out;
}
// "Today" on the NHL's calendar (US Eastern; games before 6 AM ET still count as the previous day)
export function nhlToday(){
  const et = new Date(Date.now() - 6*3600*1000).toLocaleString("en-CA", { timeZone: "America/New_York", year:"numeric", month:"2-digit", day:"2-digit" });
  return et.slice(0,10);
}
export async function mapLimit(items, n, fn){
  const out = new Array(items.length); let k = 0;
  await Promise.all(Array.from({length: Math.min(n, items.length)}, async () => { while(k < items.length){ const i = k++; out[i] = await fn(items[i], i); } }));
  return out;
}
