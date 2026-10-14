// Expected goals from MoneyPuck.com (free for non-commercial use; credit MoneyPuck.com wherever it's shown).
// MoneyPuck posts this season's shots nightly. Finished games use MoneyPuck's xG for every shot we can match;
// live games and anything not yet in MoneyPuck's file use this site's own model (public/engine.js xgModel).
import zlib from "node:zlib";

const UA = { "user-agent": "Mozilla/5.0 (PuckRatings; credits MoneyPuck.com)" };

// Unzip the first file of a zip archive (MoneyPuck ships one CSV per zip)
function unzipFirst(buf){
  let eocd = -1;
  for(let i = buf.length - 22; i >= 0; i--) if(buf.readUInt32LE(i) === 0x06054b50){ eocd = i; break; }
  if(eocd < 0) throw new Error("not a zip file");
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10), csz = buf.readUInt32LE(cd + 20), lho = buf.readUInt32LE(cd + 42);
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const data = buf.subarray(start, start + csz);
  return (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
}
const splitCsv = line => {
  if(!line.includes('"')) return line.split(",");
  const out = []; let cur = "", q = false;
  for(const ch of line){ if(ch === '"') q = !q; else if(ch === "," && !q){ out.push(cur); cur = ""; } else cur += ch; }
  out.push(cur); return out;
};

// season: start year of the season (2026 for 2026-27). Returns { updated, shots, games: { gameId: [[period, gameSec, shooterId, xG*1000, ev, emptyNet]] } }
// ev: 0 missed, 1 on goal, 2 goal
export async function fetchMoneyPuckSeason(season){
  const r = await fetch(`https://peter-tanner.com/moneypuck/downloads/shots_${season}.zip`, { headers: UA });
  if(!r.ok) throw new Error(`MoneyPuck ${r.status}`);
  const csv = unzipFirst(Buffer.from(await r.arrayBuffer()));
  const lines = csv.split("\n"), head = splitCsv(lines[0].trim());
  const c = k => { const i = head.indexOf(k); if(i < 0) throw new Error(`MoneyPuck file is missing ${k}`); return i; };
  const iG = c("game_id"), iP = c("period"), iT = c("time"), iS = c("shooterPlayerId"), iX = c("xGoal"), iE = c("event"), iN = c("shotOnEmptyNet");
  const games = {}; let n = 0;
  for(let k = 1; k < lines.length; k++){
    const line = lines[k].trim(); if(!line) continue;
    const f = splitCsv(line);
    const gid = season * 1000000 + (+f[iG]);
    const ev = f[iE] === "GOAL" ? 2 : f[iE] === "SHOT" ? 1 : 0;
    (games[gid] ||= []).push([+f[iP], Math.round(+f[iT]), +f[iS] || 0, Math.round(+f[iX] * 1000), ev, +f[iN] ? 1 : 0]);
    n++;
  }
  return { updated: r.headers.get("last-modified"), shots: n, games };
}

// Cached copy of the season, served by our own /api/mp-season (edge-cached), shared by every function
let memo = null, memoAt = 0;
export async function moneyPuckGame(id, base){
  if(!base) return null;
  if(!memo || Date.now() - memoAt > 10 * 60 * 1000){
    try { const r = await fetch(`${base}/api/mp-season`); if(r.ok){ memo = await r.json(); memoAt = Date.now(); } } catch(e){}
  }
  return memo?.games?.[id] || null;
}

// Swap MoneyPuck's xG into our shot rows. shots: [gameSec, side, res, x, y, type, xG*1000, shooterIdx, goalieIdx, flags, hd]
// Returns the share of our unblocked shots that matched.
export function applyMoneyPuck(shots, roster, mp){
  if(!mp || !mp.length) return 0;
  const used = new Array(mp.length).fill(false), evOf = { G:2, S:1, M:0 };
  let total = 0, hit = 0;
  shots.forEach(s => {
    if(s[2] === "B") return; total++;
    const pid = s[7] >= 0 ? roster[s[7]]?.[1] : 0, ev = evOf[s[2]];
    let best = -1, bd = 99;
    for(let k = 0; k < mp.length; k++){
      if(used[k]) continue; const m = mp[k];
      const dt = Math.abs(m[1] - s[0]); if(dt > 3) continue;
      if(pid && m[2] && m[2] !== pid) continue;
      const score = dt + (m[4] === ev ? 0 : 2);
      if(score < bd){ bd = score; best = k; }
    }
    if(best >= 0){ used[best] = true; s[6] = mp[best][3]; hit++; }
  });
  return total ? hit / total : 0;
}
