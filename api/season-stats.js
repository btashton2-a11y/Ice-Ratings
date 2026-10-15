// GET /api/season-stats  ->  season totals for every player using this site's models: average rating, xG, goals above expected,
// 5-on-5 on-ice shares, points per 60, goals saved above expected, high-danger save %,
// 8+ rated games (hi), each player's best game (top: [rating, date, gameId, opponent]) and his last-5-game average (l5)
import { seasonInfo, datesBetween, nhlToday, mapLimit } from "../lib/pipeline.js";
import { calibrate, grpOf } from "../public/engine.js";
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
export default async function handler(req, res){
  try {
    const today = nhlToday(), season = await seasonInfo(today);
    const proto = req.headers["x-forwarded-proto"] || "https", base = `${proto}://${req.headers.host}`;
    let cal = null; try { cal = (await (await fetch(`${base}/api/baseline`)).json()).cal; } catch(e){}
    const S = new Map(), G = new Map(), T = new Map(); let games = 0; const failed = [];
    const tm = ab => { let t = T.get(ab); if(!t){ t = { ab, xgf:0, gfne:0, icf:0, hd:0, xga:0, ga:0, sa:0, sv:0, hdf:0, hds:0 }; T.set(ab, t); } return t; };
    await mapLimit(datesBetween(season.start, today), 8, async d => {
      try {
        const r = await fetch(`${base}/api/day-stats?date=${d}`); if(!r.ok) throw new Error(r.status);
        const j = await r.json(); games += j.games;
        for(const [id, name, team, pos, raw, toi, g, a, g5, ixg, icf, hd, cf, ca, xgf, xga, sog, gid, opp] of j.sk){
          const o = S.get(id) || { id, name, team, pos, gp:0, toi:0, g:0, a:0, gne:0, ixg:0, icf:0, hd:0, cf:0, ca:0, xgf:0, xga:0, sog:0, rs:0, rn:0, last:"" };
          o.gp++; o.toi += toi; o.g += g; o.a += a; o.gne += g5; o.ixg += ixg; o.icf += icf; o.hd += hd; o.cf += cf; o.ca += ca; o.xgf += xgf; o.xga += xga; o.sog += sog;
          if(d >= o.last){ o.last = d; o.team = team; o.pos = pos; }
          { const t = tm(team); t.xgf += ixg; t.gfne += g5; t.icf += icf; t.hd += hd; }
          if(raw != null && cal){ const rt = calibrate(raw, cal[grpOf(pos)]).rating; o.rs += rt; o.rn++; if(rt >= 8) o.hi = (o.hi || 0) + 1; (o.log ||= []).push([d, rt]);
            if(!o.top || rt > o.top[0]) o.top = [Math.round(rt * 100) / 100, d, gid ?? null, opp ?? ""]; }
          S.set(id, o);
        }
        for(const [id, name, team, , raw, toi, xga, ga, hdf, hds, sa, sv, dec, gid, opp] of j.go){
          const o = G.get(id) || { id, name, team, gp:0, toi:0, xga:0, ga:0, hdf:0, hds:0, sa:0, sv:0, w:0, rs:0, rn:0, last:"" };
          o.gp++; o.toi += toi; o.xga += xga; o.ga += ga; o.hdf += hdf; o.hds += hds; o.sa += sa; o.sv += sv; if(dec === "W") o.w++;
          if(d >= o.last){ o.last = d; o.team = team; }
          { const t = tm(team); t.xga += xga; t.ga += ga; t.sa += sa; t.sv += sv; t.hdf += hdf; t.hds += hds; }
          if(raw != null && cal){ const rt = calibrate(raw, cal.G).rating; o.rs += rt; o.rn++; if(rt >= 8) o.hi = (o.hi || 0) + 1; (o.log ||= []).push([d, rt]);
            if(!o.top || rt > o.top[0]) o.top = [Math.round(rt * 100) / 100, d, gid ?? null, opp ?? ""]; }
          G.set(id, o);
        }
      } catch(e){ failed.push(d); }
    });
    // average of the last 5 rated games (for hot and cold lists)
    const last5 = o => { const L = (o.log || []).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 5); return L.length ? r2(L.reduce((a, x) => a + x[1], 0) / L.length) : null; };
    const skaters = [...S.values()].map(o => ({
      id:o.id, name:o.name, team:o.team, pos:o.pos, gp:o.gp, toi:o.toi, g:o.g, a:o.a, p:o.g+o.a, sog:o.sog,
      ixg:r2(o.ixg), gax:r2(o.gne - o.ixg), icf:o.icf, hd:o.hd,
      cfPct: o.cf + o.ca ? r3(o.cf / (o.cf + o.ca)) : null, xgPct: o.xgf + o.xga ? r3(o.xgf / (o.xgf + o.xga)) : null,
      xgf5: r2(o.xgf / 1000), xga5: r2(o.xga / 1000),
      p60: o.toi ? r2((o.g + o.a) / o.toi * 3600) : null, rating: o.rn ? r2(o.rs / o.rn) : null, rated: o.rn, hi: o.hi || 0, top: o.top || null, l5: last5(o)
    }));
    const goalies = [...G.values()].map(o => ({
      id:o.id, name:o.name, team:o.team, gp:o.gp, toi:o.toi, w:o.w, sa:o.sa, sv:o.sv, ga:o.ga,
      svp: o.sa ? r3(o.sv / o.sa) : null, xga:r2(o.xga), gsax:r2(o.xga - o.ga),
      hdsv: o.hdf ? r3(o.hds / o.hdf) : null, hdf:o.hdf, rating: o.rn ? r2(o.rs / o.rn) : null, rated: o.rn, hi: o.hi || 0, top: o.top || null, l5: last5(o)
    }));
    res.setHeader("Cache-Control", failed.length ? "public, s-maxage=300" : "public, s-maxage=1800, stale-while-revalidate=7200");
    // Teams: expected goals for (from their shooters) and against (from their goalies), all situations, empty-net shots left out
    const teams = [...T.values()].map(t => ({ ab: t.ab, xgf: r2(t.xgf), xga: r2(t.xga), xgPct: t.xgf + t.xga ? r3(t.xgf / (t.xgf + t.xga)) : null,
      gax: r2(t.gfne - t.xgf), gsax: r2(t.xga - t.ga), hd: t.hd, hdsv: t.hdf ? r3(t.hds / t.hdf) : null, icf: t.icf }));
    res.status(200).json({ season: season.id, through: today, games, failed, skaters, goalies, teams });
  } catch(e){ res.status(502).json({ error: "Couldn't build season stats.", detail: String(e) }); }
}
