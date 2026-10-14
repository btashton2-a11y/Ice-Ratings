// GET /api/player?id=8477492  ->  profile, this season's games with ratings, and NHL career by season
import { WEB, getJSON, mapLimit, seasonInfo, nhlToday } from "../lib/pipeline.js";
import { ratePlayer } from "../public/engine.js";

const name = o => (o && (o.default || Object.values(o)[0])) || "";
export default async function handler(req, res){
  const id = +req.query.id;
  if(!/^\d{7}$/.test(String(id))) return res.status(400).json({ error: "Pass a 7-digit NHL player id." });
  try {
    const L = await getJSON(`${WEB}/player/${id}/landing`);
    const goalie = L.position === "G";
    const season = (await seasonInfo(nhlToday())).id;
    const proto = req.headers["x-forwarded-proto"] || "https", base = `${proto}://${req.headers.host}`;

    // This season's games, each rated with the same formula and season comparison as the scores page
    let log = [];
    try { log = (await getJSON(`${WEB}/player/${id}/game-log/${season}/2`)).gameLog || []; } catch(e){}
    let cal = null;
    try { cal = (await (await fetch(`${base}/api/baseline`)).json()).cal; } catch(e){}
    const games = await mapLimit(log, 6, async gl => {
      const row = { id: gl.gameId, date: gl.gameDate, opp: gl.opponentAbbrev, home: gl.homeRoadFlag === "H",
        g: gl.goals ?? 0, a: gl.assists ?? 0, toi: gl.toi || "", rating: null, result: "" };
      if(goalie) Object.assign(row, { sa: gl.shotsAgainst ?? null, ga: gl.goalsAgainst ?? null, dec: gl.decision || "" });
      try {
        const g = await (await fetch(`${base}/api/game?id=${gl.gameId}`)).json();
        const me = g.p.find(r => r[1] === id), side = me ? me[0] : (gl.homeRoadFlag === "H" ? 1 : 0);
        const us = g.t[side].sc, them = g.t[1-side].sc;
        row.score = `${us}–${them}`;
        row.result = (g.st === "OFF" || g.st === "FINAL") ? (us > them ? "W" : g.end && g.end !== "REG" ? "OTL" : "L") : "Live";
        if(cal){ const r = ratePlayer(g, id, cal); if(r && r.rating != null){ row.rating = +r.rating.toFixed(2); row.pct = +r.pct.toFixed(4); } }
      } catch(e){}
      return row;
    });
    games.sort((a,b) => b.date.localeCompare(a.date));

    // NHL regular-season career, one row per season and team
    const seasons = (L.seasonTotals || []).filter(s => s.leagueAbbrev === "NHL" && s.gameTypeId === 2).map(s => ({
      season: s.season, team: name(s.teamName), gp: s.gamesPlayed ?? 0,
      g: s.goals ?? 0, a: s.assists ?? 0, p: s.points ?? ((s.goals ?? 0) + (s.assists ?? 0)), pm: s.plusMinus ?? null,
      w: s.wins ?? null, l: s.losses ?? null, otl: s.otLosses ?? null, svp: s.savePctg ?? null, gaa: s.goalsAgainstAvg ?? null, so: s.shutouts ?? null
    }));
    const ct = L.careerTotals?.regularSeason || null;
    const career = ct ? { gp: ct.gamesPlayed ?? 0, g: ct.goals ?? 0, a: ct.assists ?? 0, p: ct.points ?? 0, pm: ct.plusMinus ?? null,
      w: ct.wins ?? null, l: ct.losses ?? null, otl: ct.otLosses ?? null, svp: ct.savePctg ?? null, gaa: ct.goalsAgainstAvg ?? null, so: ct.shutouts ?? null } : null;

    const d = L.draftDetails;
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json({
      id, season, goalie, active: !!L.isActive,
      first: name(L.firstName), last: name(L.lastName), num: L.sweaterNumber ?? null, pos: L.position,
      team: L.currentTeamAbbrev || "", teamName: name(L.fullTeamName),
      heightIn: L.heightInInches ?? null, heightCm: L.heightInCentimeters ?? null, weightLb: L.weightInPounds ?? null, weightKg: L.weightInKilograms ?? null,
      birthDate: L.birthDate || null, birthCity: name(L.birthCity), birthState: name(L.birthStateProvince), birthCountry: L.birthCountry || "",
      shoots: L.shootsCatches || "",
      draft: d ? { year: d.year, round: d.round, pick: d.pickInRound, overall: d.overallPick, team: d.teamAbbrev } : null,
      games, seasons, career
    });
  } catch(e){ res.status(502).json({ error: "Couldn't load this player from the NHL. Try again in a minute.", detail: String(e) }); }
}
