// GET /api/league-stats  ->  this season's full NHL stat lines for every skater and goalie (for "See all" lists and player Stats tabs)
import { getJSON, seasonInfo, nhlToday } from "../lib/pipeline.js";
const STATS = "https://api.nhle.com/stats/rest/en";
const lastTeam = t => String(t || "").split(",").pop().trim();
export default async function handler(req, res){
  try {
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
  } catch(e){ res.status(502).json({ error: "Couldn't load league stats from the NHL. Try again in a minute.", detail: String(e) }); }
}
