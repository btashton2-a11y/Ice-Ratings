// GET /api/standings  ->  every team's record, with division, conference, league and wild-card order
import { WEB, getJSON } from "../lib/pipeline.js";
const nm = o => (o && (o.default || Object.values(o)[0])) || "";
export default async function handler(req, res){
  try {
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
  } catch(e){ res.status(502).json({ error: "Couldn't load the standings from the NHL. Try again in a minute.", detail: String(e) }); }
}
