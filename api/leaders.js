// GET /api/leaders  ->  NHL's official league leaders (top 10) for skaters and goalies this season
import { WEB, getJSON } from "../lib/pipeline.js";
const nm = o => (o && (o.default || Object.values(o)[0])) || "";
const SK = ["points","goals","assists","plusMinus","goalsPp","goalsSh","toi","faceoffLeaders","penaltyMins"];
const GO = ["wins","savePctg","goalsAgainstAverage","shutouts"];
const slim = arr => (arr || []).map(p => ({ id: p.id, name: `${nm(p.firstName)} ${nm(p.lastName)}`.trim(), team: p.teamAbbrev || "", pos: p.position || "", num: p.sweaterNumber ?? null, v: p.value }));
export default async function handler(req, res){
  try {
    const [s, g] = await Promise.all([
      getJSON(`${WEB}/skater-stats-leaders/current?categories=${SK.join(",")}&limit=10`),
      getJSON(`${WEB}/goalie-stats-leaders/current?categories=${GO.join(",")}&limit=10`)
    ]);
    const skaters = {}, goalies = {};
    SK.forEach(k => skaters[k] = slim(s[k])); GO.forEach(k => goalies[k] = slim(g[k]));
    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
    res.status(200).json({ skaters, goalies });
  } catch(e){ res.status(502).json({ error: "Couldn't load league leaders from the NHL. Try again in a minute.", detail: String(e) }); }
}
