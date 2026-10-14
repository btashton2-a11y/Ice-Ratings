// GET /api/preview?id=2026020107  ->  pregame preview: records, last 5 games, projected goalies, team stats, hot players, season series
import { WEB, getJSON } from "../lib/pipeline.js";

const nm = o => (o && (o.default || Object.values(o)[0])) || "";
const prevDay = d => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0,10); };
const tryJSON = async url => { try { return await getJSON(url); } catch(e){ return null; } };

// Who started a finished game for a team (boxscore marks the starter; fall back to most ice time)
async function starterIn(gameId, abbrev){
  const b = await tryJSON(`${WEB}/gamecenter/${gameId}/boxscore`);
  if(!b) return null;
  const side = b.awayTeam?.abbrev === abbrev ? "awayTeam" : "homeTeam";
  const gs = b.playerByGameStats?.[side]?.goalies || [];
  const toi = g => { const [m,s] = String(g.toi || "0:0").split(":").map(Number); return m*60 + (s||0); };
  const st = gs.find(g => g.starter) || [...gs].sort((a,b) => toi(b) - toi(a))[0];
  return st ? { id: st.playerId, name: nm(st.name) } : null;
}

export default async function handler(req, res){
  const id = +req.query.id;
  if(!/^\d{10}$/.test(String(id))) return res.status(400).json({ error: "Pass a 10-digit NHL game id." });
  try {
    const [L, RR] = await Promise.all([getJSON(`${WEB}/gamecenter/${id}/landing`), tryJSON(`${WEB}/gamecenter/${id}/right-rail`)]);
    const M = L.matchup || {};
    const sides = ["awayTeam", "homeTeam"];
    const yesterday = await tryJSON(`${WEB}/score/${prevDay(L.gameDate)}`);

    const teams = await Promise.all(sides.map(async (k, si) => {
      const T = L[k] || {};
      // Last 5 games (NHL lists most recent first; we send oldest -> newest)
      const past = (RR?.last10Record?.[k]?.pastGameResults || []).slice(0, 5).reverse()
        .map(r => ({ r: r.gameResult === "W" ? "W" : r.gameResult === "L" ? "L" : "OTL", opp: r.opponentAbbrev }));
      const l5 = past.length ? `${past.filter(r => r.r === "W").length}-${past.filter(r => r.r === "L").length}-${past.filter(r => r.r === "OTL").length}` : null;
      const ts = RR?.teamSeasonStats?.[k] || null;
      const stats = ts ? {
        gf: ts.goalsForPerGamePlayed, gfRk: ts.goalsForPerGamePlayedRank, ga: ts.goalsAgainstPerGamePlayed, gaRk: ts.goalsAgainstPerGamePlayedRank,
        pp: ts.ppPctg, ppRk: ts.ppPctgRank, pk: ts.pkPctg, pkRk: ts.pkPctgRank, fo: ts.faceoffWinningPctg, foRk: ts.faceoffWinningPctgRank
      } : null;

      // Goalies on this team this season, most games first
      let goalies = (M.goalieSeasonStats?.goalies || []).filter(g => g.teamId === T.id).map(g => ({
        id: g.playerId, name: nm(g.name), num: g.sweaterNumber ?? null, gp: g.gamesPlayed ?? 0,
        rec: `${g.wins ?? 0}-${g.losses ?? 0}-${g.otLosses ?? 0}`, svp: g.savePctg ?? null, gaa: g.goalsAgainstAvg ?? null, so: g.shutouts ?? 0
      }));
      if(!goalies.length) goalies = (M.goalieComparison?.[k]?.leaders || []).map(g => ({
        id: g.playerId, name: nm(g.name), num: g.sweaterNumber ?? null, gp: g.gamesPlayed ?? 0, rec: g.record || "", svp: g.savePctg ?? null, gaa: g.gaa ?? null, so: g.shutouts ?? 0
      }));
      goalies.sort((a,b) => b.gp - a.gp);

      // Projected starter: the goalie with the most games, unless he started last night (back-to-back)
      const ygame = (yesterday?.games || []).find(g => (g.awayTeam?.abbrev === T.abbrev || g.homeTeam?.abbrev === T.abbrev) && (g.gameState === "OFF" || g.gameState === "FINAL"));
      let proj = null, why = "";
      if(goalies.length){
        proj = goalies[0]; why = "Has started the most games this season";
        if(ygame && goalies.length > 1){
          const st = await starterIn(ygame.id, T.abbrev);
          if(st && st.id === goalies[0].id){ proj = goalies[1]; why = `Second night of a back-to-back, and ${goalies[0].name} started last night`; }
          else if(st){ why = `Second night of a back-to-back. ${st.name} started last night`; }
        }
      }
      return {
        ab: T.abbrev, nm: `${nm(T.placeName)} ${nm(T.commonName)}`.trim(), record: T.record || null,
        past, l5, streak: RR?.last10Record?.[k]?.streakType ? `${RR.last10Record[k].streakType}${RR.last10Record[k].streak}` : null,
        b2b: !!ygame, stats, goalies, proj: proj ? { ...proj, why } : null, coach: nm(RR?.gameInfo?.[k]?.headCoach) || null
      };
    }));

    // Hot players: last-5-game leaders by category
    const ldr = x => x ? { id: x.playerId, name: nm(x.name), num: x.sweaterNumber ?? null, pos: x.positionCode || "", val: x.value } : null;
    const leaders = (M.skaterComparison?.leaders || []).map(l => ({ cat: l.category, a: ldr(l.awayLeader), h: ldr(l.homeLeader) }));
    const leadersCtx = M.skaterComparison?.contextLabel || "";

    // Season series so far (finished meetings only)
    const series = (RR?.seasonSeries || []).filter(g => (g.gameState === "OFF" || g.gameState === "FINAL") && g.id !== id).map(g => ({
      id: g.id, d: g.gameDate, a: g.awayTeam?.abbrev, h: g.homeTeam?.abbrev, as: g.awayTeam?.score ?? null, hs: g.homeTeam?.score ?? null, end: g.gameOutcome?.lastPeriodType || "REG"
    }));

    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=1800");
    res.status(200).json({
      id, d: L.gameDate, st: L.gameState, start: L.startTimeUTC, venue: nm(L.venue), city: nm(L.venueLocation),
      tv: [...new Set((L.tvBroadcasts || []).map(b => b.network).filter(Boolean))],
      teams, leaders, leadersCtx, series,
      seriesWins: RR?.seasonSeriesWins ? [RR.seasonSeriesWins.awayTeamWins ?? 0, RR.seasonSeriesWins.homeTeamWins ?? 0] : null
    });
  } catch(e){ res.status(502).json({ error: "Couldn't load the preview from the NHL. Try again in a minute.", detail: String(e) }); }
}
