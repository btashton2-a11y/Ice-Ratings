// GET /api/search?q=name  ->  matching NHL players (active players first)
// GET /api/search?img=mug:8477492 | logo:COL_dark  ->  a headshot or team logo served from this site, so the share-image
//   maker can draw it on a canvas (the NHL's image server doesn't allow that from other sites)
import { getJSON } from "../lib/pipeline.js";
async function image(req, res){
  const m = /^(mug):(\d{7})$|^(logo):([A-Z]{2,3}_(?:light|dark))$/.exec(String(req.query.img || ""));
  if(!m) return res.status(400).json({ error: "Pass img=mug:<player id> or img=logo:<TEAM>_light|_dark." });
  const url = m[1] ? `https://assets.nhle.com/mugs/nhl/latest/${m[2]}.png` : `https://assets.nhle.com/logos/nhl/svg/${m[4]}.svg`;
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (PuckRatings)" } });
  if(!r.ok){ res.setHeader("Cache-Control", "public, s-maxage=3600"); return res.status(404).end(); }
  res.setHeader("Content-Type", m[1] ? "image/png" : "image/svg+xml");
  res.setHeader("Cache-Control", "public, s-maxage=604800, stale-while-revalidate=2592000");
  res.status(200).send(Buffer.from(await r.arrayBuffer()));
}
export default async function handler(req, res){
  if(req.query.img) return image(req, res).catch(e => res.status(502).json({ error: String(e) }));
  const q = String(req.query.q || "").trim();
  if(q.length < 2) return res.status(200).json({ players: [] });
  try {
    const j = await getJSON(`https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=20&q=${encodeURIComponent(q)}`);
    const players = (Array.isArray(j) ? j : []).map(p => ({
      id: +p.playerId, name: p.name, team: p.teamAbbrev || p.lastTeamAbbrev || "", pos: p.positionCode || "",
      num: p.sweaterNumber ?? null, active: !!p.active
    })).sort((a,b) => (b.active - a.active)).slice(0, 12);
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json({ players });
  } catch(e){ res.status(502).json({ error: "Player search isn't responding. Try again in a minute.", detail: String(e) }); }
}
