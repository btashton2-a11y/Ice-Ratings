// GET /api/league?view=standings | leaders | stats | teams | team&ab=COL | shotmap&ab=COL
//   standings: every team's record with division, conference, league and wild-card order
//   leaders:   the NHL's official top 10s for skaters and goalies
//   stats:     this season's full stat lines for every skater and goalie ("See all" lists, player Stats tabs)
// One function for all three keeps the site under Vercel's 12-function limit on the free plan.
import { WEB, getJSON, seasonInfo, nhlToday } from "../lib/pipeline.js";
const nm = o => (o && (o.default || Object.values(o)[0])) || "";
const STATS = "https://api.nhle.com/stats/rest/en";
const lastTeam = t => String(t || "").split(",").pop().trim();
const SK = ["points","goals","assists","plusMinus","goalsPp","goalsSh","toi","faceoffLeaders","penaltyMins"];
const GO = ["wins","savePctg","goalsAgainstAverage","shutouts"];
const slim = arr => (arr || []).map(p => ({ id: p.id, name: `${nm(p.firstName)} ${nm(p.lastName)}`.trim(), team: p.teamAbbrev || "", pos: p.position || "", num: p.sweaterNumber ?? null, v: p.value }));

async function standings(req, res){
    const j = await getJSON(`${WEB}/standings/now`);
    const teams = (j.standings || []).map(t => ({
      ab: nm(t.teamAbbrev), name: nm(t.teamName), short: nm(t.teamCommonName), place: nm(t.placeName),
      conf: t.conferenceName, div: t.divisionName,
      gp: t.gamesPlayed, w: t.wins, l: t.losses, otl: t.otLosses, pts: t.points, pct: t.pointPctg,
      rw: t.regulationWins, row: t.regulationPlusOtWins, gf: t.goalFor, ga: t.goalAgainst, diff: t.goalDifferential,
      home: `${t.homeWins}-${t.homeLosses}-${t.homeOtLosses}`, road: `${t.roadWins}-${t.roadLosses}-${t.roadOtLosses}`,
      l10: `${t.l10Wins}-${t.l10Losses}-${t.l10OtLosses}`, strk: t.streakCode ? `${t.streakCode}${t.streakCount}` : "",
      divSeq: t.divisionSequence, confSeq: t.conferenceSequence, leagueSeq: t.leagueSequence, wcSeq: t.wildcardSequence,
      clinch: t.clinchIndicator || ""
    }));
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
    res.status(200).json({ updated: j.standingsDateTimeUtc || null, wildCard: j.wildCardIndicator !== false, teams });
}
async function leaders(req, res){
    const [s, g] = await Promise.all([
      getJSON(`${WEB}/skater-stats-leaders/current?categories=${SK.join(",")}&limit=10`),
      getJSON(`${WEB}/goalie-stats-leaders/current?categories=${GO.join(",")}&limit=10`)
    ]);
    const skaters = {}, goalies = {};
    SK.forEach(k => skaters[k] = slim(s[k])); GO.forEach(k => goalies[k] = slim(g[k]));
    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
    res.status(200).json({ skaters, goalies });
}
async function stats(req, res){
    const season = (await seasonInfo(nhlToday())).id;
    const q = r => `${STATS}/${r}?isAggregate=false&isGame=false&start=0&limit=-1&cayenneExp=${encodeURIComponent(`gameTypeId=2 and seasonId<=${season} and seasonId>=${season}`)}`;
    const [sum, rt, fo, gs] = await Promise.all([q("skater/summary"), q("skater/realtime"), q("skater/faceoffwins"), q("goalie/summary")].map(u => getJSON(u).catch(() => ({ data: [] }))));
    const byId = (arr) => new Map((arr.data || []).map(r => [r.playerId, r]));
    const R = byId(rt), F = byId(fo);
    // Skater: [id, name, team, pos, gp, g, a, p, pm, pim, ppg, ppp, shg, shp, gwg, sog, shPct, toiPerGame, foPct, faceoffs, hits, blocks, takeaways, giveaways]
    const skaters = (sum.data || []).map(s => { const r = R.get(s.playerId) || {}, f = F.get(s.playerId) || {};
      return [s.playerId, s.skaterFullName, lastTeam(s.teamAbbrevs), s.positionCode, s.gamesPlayed, s.goals, s.assists, s.points, s.plusMinus, s.penaltyMinutes,
        s.ppGoals, s.ppPoints, s.shGoals, s.shPoints, s.gameWinningGoals, s.shots, s.shootingPct, Math.round(s.timeOnIcePerGame || 0),
        s.faceoffWinPct, f.totalFaceoffs ?? null, r.hits ?? null, r.blockedShots ?? null, r.takeaways ?? null, r.giveaways ?? null]; });
    // Goalie: [id, name, team, gp, gs, w, l, otl, sa, sv, ga, svPct, gaa, so, toi]
    const goalies = (gs.data || []).map(g => [g.playerId, g.goalieFullName, lastTeam(g.teamAbbrevs), g.gamesPlayed, g.gamesStarted, g.wins, g.losses, g.otLosses,
      g.shotsAgainst, g.saves, g.goalsAgainst, g.savePct, g.goalsAgainstAverage, g.shutouts, g.timeOnIce]);
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json({ season, skaters, goalies });
}

// Every team's season stats (summary, realtime, power play) merged with standings, keyed by abbreviation
const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
async function teams(req, res){
  const season = (await seasonInfo(nhlToday())).id;
  const q = r => `${STATS}/${r}?isAggregate=false&isGame=false&start=0&limit=-1&cayenneExp=${encodeURIComponent(`gameTypeId=2 and seasonId<=${season} and seasonId>=${season}`)}`;
  const [st, sum, rt, pp] = await Promise.all([getJSON(`${WEB}/standings/now`), ...["team/summary", "team/realtime", "team/powerplay"].map(r => getJSON(q(r)).catch(() => ({ data: [] })))]);
  const by = arr => new Map((arr.data || []).map(r => [norm(r.teamFullName), r]));
  const S = by(sum), R = by(rt), P = by(pp);
  const out = (st.standings || []).map(t => {
    const k = norm(nm(t.teamName)), s = S.get(k) || {}, r = R.get(k) || {}, p = P.get(k) || {};
    return { id: nm(t.teamAbbrev), ab: nm(t.teamAbbrev), name: nm(t.teamName), short: nm(t.teamCommonName), conf: t.conferenceName, div: t.divisionName,
      gp: t.gamesPlayed, w: t.wins, l: t.losses, otl: t.otLosses, pts: t.points, pct: t.pointPctg, rw: t.regulationWins, gf: t.goalFor, ga: t.goalAgainst, diff: t.goalDifferential,
      l10: `${t.l10Wins}-${t.l10Losses}-${t.l10OtLosses}`, strk: t.streakCode ? `${t.streakCode}${t.streakCount}` : "", home: `${t.homeWins}-${t.homeLosses}-${t.homeOtLosses}`, road: `${t.roadWins}-${t.roadLosses}-${t.roadOtLosses}`,
      divSeq: t.divisionSequence, confSeq: t.conferenceSequence, leagueSeq: t.leagueSequence,
      gfpg: s.goalsForPerGame ?? null, gapg: s.goalsAgainstPerGame ?? null, ppPct: s.powerPlayPct ?? null, pkPct: s.penaltyKillPct ?? null,
      sfpg: s.shotsForPerGame ?? null, sapg: s.shotsAgainstPerGame ?? null, foPct: s.faceoffWinPct ?? null, so: s.teamShutouts ?? null,
      ppg: p.powerPlayGoalsFor ?? null, ppo: p.ppOpportunities ?? null, shga: p.shGoalsAgainst ?? null,
      hits: r.hits ?? null, blk: r.blockedShots ?? null, tk: r.takeaways ?? null, gv: r.giveaways ?? null, satPct: r.satPct ?? null, att: r.totalShotAttempts ?? null, en: r.emptyNetGoals ?? null };
  });
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
  res.status(200).json({ season, teams: out });
}
// One team's shot map: where it shoots from and where it allows shots from, per game, next to the league average
async function shotmap(req, res){
  const ab = String(req.query.ab || "").toUpperCase();
  if(!/^[A-Z]{3}$/.test(ab)) return res.status(400).json({ error: "Pass ab=COL (a team abbreviation)." });
  const proto = req.headers["x-forwarded-proto"] || "https", base = `${proto}://${req.headers.host}`;
  const r = await fetch(`${base}/api/mp-season?maps=1`); if(!r.ok) throw new Error(`mp-season ${r.status}`);
  const j = await r.json(), M = j.maps || {}, me = M[ab];
  // MoneyPuck writes a few teams differently
  const MP = { TBL: "T.B", NJD: "N.J", LAK: "L.A", SJS: "S.J" };
  const key = me ? ab : MP[ab];
  const T = M[key];
  if(!T) { res.setHeader("Cache-Control", "public, s-maxage=600"); return res.status(200).json({ ab, gp: 0, cols: j.cols, rows: j.rows, none: true }); }
  const N = j.cols * j.rows, lg = { f: new Array(N).fill(0), fx: new Array(N).fill(0) }; let gp = 0;
  for(const t of Object.values(M)){ gp += t.gp; for(let i = 0; i < N; i++){ lg.f[i] += t.f[i]; lg.fx[i] += t.fx[i]; } }
  // league average per team-game (shots for and against are the same pool league-wide)
  const per = arr => arr.map(v => gp ? Math.round(v / gp * 1000) / 1000 : 0);
  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=7200");
  res.status(200).json({ ab, source: "MoneyPuck.com", updated: j.updated, cols: j.cols, rows: j.rows, gp: T.gp, f: T.f, fx: T.fx, a: T.a, ax: T.ax, lg: { f: per(lg.f), fx: per(lg.fx) } });
}
// One team's regular-season schedule and results
async function team(req, res){
  const ab = String(req.query.ab || "").toUpperCase();
  if(!/^[A-Z]{3}$/.test(ab)) return res.status(400).json({ error: "Pass ab=COL (a team abbreviation)." });
  const j = await getJSON(`${WEB}/club-schedule-season/${ab}/now`);
  const games = (j.games || []).filter(g => g.gameType === 2).map(g => { const home = g.homeTeam?.abbrev === ab, us = home ? g.homeTeam : g.awayTeam, them = home ? g.awayTeam : g.homeTeam;
    return { id: g.id, d: g.gameDate, start: g.startTimeUTC, st: g.gameState, home, opp: them?.abbrev, us: us?.score ?? null, them: them?.score ?? null, end: g.gameOutcome?.lastPeriodType || null }; });
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
  res.status(200).json({ ab, games });
}

export default async function handler(req, res){
  const view = String(req.query.view || "");
  const fn = { standings, leaders, stats, teams, team, shotmap }[view];
  if(!fn) return res.status(400).json({ error: "Pass view=standings, leaders, stats, teams, team or shotmap." });
  try { await fn(req, res); }
  catch(e){ res.status(502).json({ error: "Couldn't load this from the NHL. Try again in a minute.", detail: String(e) }); }
}
