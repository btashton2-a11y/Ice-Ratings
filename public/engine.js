// Ice Ratings engine. Shared by the server (api/) and the page (public/index.html).
export const SHOT_TYPES = ['wrist','snap','slap','backhand','tip-in','deflected','wrap-around','poke','bat','between-legs','cradle',''];
export const DEFAULTS = {
  goal:0.8, enGoal:0.25, ixg:0.6, a1:0.55, a2:0.3,
  sog:0.03, icf:0.015, hd:0.06,
  gd5:0.15, xgd5:0.35, cfd5:0.01,
  hit:0.04, block:0.1, take:0.12, give:0.12,
  penTaken:0.25, penDrawn:0.15, fo:0.02, toi:0.03,
  gsax:0.45, hdsv:0.03, shsv:0.02, win:0.3
};
export const SLIDER_GROUPS = [
  ["Scoring", [["goal","Goal",0,2,.05],["enGoal","Empty-net goal",0,1,.05],["ixg","Expected goals created (per 1.0 xG)",0,2,.05],["a1","Primary assist",0,1.5,.05],["a2","Secondary assist",0,1,.05]]],
  ["Shooting", [["sog","Shot on goal",0,.2,.01],["icf","Shot attempt (any)",0,.1,.005],["hd","High-danger chance",0,.3,.01]]],
  ["On-ice at even strength", [["gd5","Goal differential (per goal)",0,.6,.05],["xgd5","Expected-goal differential (per 1.0 xG)",0,1.5,.05],["cfd5","Shot-attempt differential (per attempt)",0,.06,.005]]],
  ["Physical and puck", [["hit","Hit",0,.15,.01],["block","Blocked shot",0,.3,.01],["take","Takeaway",0,.4,.01],["give","Giveaway (penalty)",0,.4,.01]]],
  ["Discipline and draws", [["penTaken","Penalty taken",0,.8,.05],["penDrawn","Penalty drawn",0,.8,.05],["fo","Faceoff (per net win)",0,.1,.005],["toi","Ice time (per min vs. 15:00)",0,.1,.005]]],
  ["Goalies", [["gsax","Goals saved above expected (per goal)",0,1.2,.05],["hdsv","High-danger save",0,.15,.01],["shsv","Save while shorthanded",0,.1,.01],["win","Win bonus",0,1,.05]]]
];
export const MIN_TOI_SK = 300, MIN_TOI_G_BASE = 1200;
export const grpOf = pos => pos==="G" ? "G" : pos==="D" ? "D" : "F";
export const fmtToi = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;

// Per-game derived stats for every player
export function derive(g){
  const n = g.p.length, sk = [];
  for(let i=0;i<n;i++) sk.push({icf:0, iff:0, ixg:0, hd:0, miss:0, blockedBy:0, en:0, a1:0, a2:0,
    xga:0, ga:0, faced:0, hdFaced:0, hdSaves:0, shFaced:0, shSaves:0});
  g.s.forEach(s=>{
    const [, , res, , , , xg, sh, gk, fl, hd] = s;
    const en = fl.includes("e");
    if(sh>=0){ const p = sk[sh]; p.icf++;
      if(res==="B") p.blockedBy++; else { p.iff++; if(!en){ p.ixg += xg/1000; if(hd) p.hd++; } }
      if(res==="M") p.miss++; if(res==="G" && en) p.en++; }
    if(res!=="B" && !en && gk>=0 && gk>=g.g0){ const q = sk[gk];
      q.xga += xg/1000; q.faced++; if(res==="G") q.ga++;
      if(hd){ q.hdFaced++; if(res==="S") q.hdSaves++; }
      if(fl.includes("p") && res!=="M"){ q.shFaced++; if(res==="S") q.shSaves++; } }
  });
  g.gl.forEach(([, , , , as])=>{ if(as[0]!=null) sk[as[0]].a1++; if(as[1]!=null) sk[as[1]].a2++; });
  return sk;
}

// Raw score: sum of weighted components, with labelled rows for the breakdown
export function scorePlayer(g, i, dv, W){
  const r = g.p[i], rows = [];
  const add = (grp, lbl, v) => rows.push([grp, lbl, v]);
  if(i >= g.g0){
    const [side,id,num,name,, sa, sv, toi, dec] = r, q = dv[i];
    if(toi === 0) return {i, id, num, name, pos:"G", side, goalie:true, dnp:true, rows:[], raw:null, toi};
    const gsax = q.xga - q.ga;
    add("Goaltending", `Goals saved above expected (${q.xga.toFixed(2)} xGA, ${q.ga} GA)`, gsax*W.gsax);
    add("Goaltending", `High-danger saves (${q.hdSaves} of ${q.hdFaced})`, q.hdSaves*W.hdsv);
    add("Goaltending", `Saves while shorthanded (${q.shSaves} of ${q.shFaced})`, q.shSaves*W.shsv);
    if(dec==="W") add("Goaltending", "Win", W.win);
    return {i, id, num, name, pos:"G", side, goalie:true, rows, raw: rows.reduce((a,x)=>a+x[2],0), toi,
      adv:{xga:q.xga, ga:q.ga, gsax, hdSaves:q.hdSaves, hdFaced:q.hdFaced, sa, sv},
      line:`${sv}/${sa} saves · ${gsax>=0?"+":""}${gsax.toFixed(2)} GSAx · ${fmtToi(toi)}`};
  }
  const [side,id,num,name,pos,goals,assists,pm,pim,hits,ppg,sog,toi,blk,gv,tk,fw,fl,pt,pd,cf,ca,xgf,xga,gf,ga] = r, s = dv[i];
  const regG = goals - s.en, tm = toi/60;
  add("Scoring", `Goals (${regG}${ppg?`, ${ppg} on PP`:""})`, regG*W.goal);
  if(s.en) add("Scoring", `Empty-net goals (${s.en})`, s.en*W.enGoal);
  add("Scoring", `Expected goals created (${s.ixg.toFixed(2)} xG)`, s.ixg*W.ixg);
  add("Scoring", `Primary assists (${s.a1})`, s.a1*W.a1);
  add("Scoring", `Secondary assists (${s.a2})`, s.a2*W.a2);
  add("Shooting", `Shots on goal (${sog})`, sog*W.sog);
  add("Shooting", `Shot attempts (${s.icf})`, s.icf*W.icf);
  add("Shooting", `High-danger chances (${s.hd})`, s.hd*W.hd);
  add("On-ice, even strength", `Goals for/against (${gf}–${ga})`, (gf-ga)*W.gd5);
  add("On-ice, even strength", `Expected goals for/against (${(xgf/1000).toFixed(2)}–${(xga/1000).toFixed(2)})`, ((xgf-xga)/1000)*W.xgd5);
  add("On-ice, even strength", `Shot attempts for/against (${cf}–${ca})`, (cf-ca)*W.cfd5);
  add("Physical and puck", `Hits (${hits})`, hits*W.hit);
  add("Physical and puck", `Blocked shots (${blk})`, blk*W.block);
  add("Physical and puck", `Takeaways (${tk})`, tk*W.take);
  add("Physical and puck", `Giveaways (${gv})`, -gv*W.give);
  add("Discipline and draws", `Penalties taken (${pt})`, -pt*W.penTaken);
  add("Discipline and draws", `Penalties drawn (${pd})`, pd*W.penDrawn);
  if(fw+fl) add("Discipline and draws", `Faceoffs (${fw}–${fl})`, (fw-fl)*W.fo);
  add("Discipline and draws", `Ice time (${fmtToi(toi)})`, Math.max(-.15, Math.min(.3, (tm-15)*W.toi)));
  return {i, id, num, name, pos, side, goalie:false, rows, raw: rows.reduce((a,x)=>a+x[2],0), toi,
    adv:{ixg:s.ixg, gax: regG - s.ixg, icf:s.icf, blockedBy:s.blockedBy, miss:s.miss, fw, fl,
      cfpct: cf+ca ? cf/(cf+ca) : null, xgpct: xgf+xga ? xgf/(xgf+xga) : null},
    box:{goals, assists},
    line:`${goals}G ${assists}A · ${s.ixg.toFixed(2)} xG · ${fmtToi(toi)}`};
}

export function scoreGame(g, W){
  const dv = derive(g);
  return g.p.map((_,i)=>scorePlayer(g, i, dv, W));
}

// ---------- Calibration against the league ----------
// Ratings come from where a raw score falls among every game of the same position this season.
// rating = center + spread * z, where z is the normal score of that percentile.
export const SCALE_DEFAULT = {center:6.6, spread:1.1};
export const normCdf = z => { const t = 1/(1+0.2316419*Math.abs(z)), d = 0.3989423*Math.exp(-z*z/2);
  const p = d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274)))); return z>0 ? 1-p : p; };
export function probit(p){ // Acklam's inverse normal CDF
  const a=[-39.69683028665376,220.9460984245205,-275.9285104469687,138.357751867269,-30.66479806614716,2.506628277459239],
        b=[-54.47609879822406,161.5858368580409,-155.6989798598866,66.80131188771612,-13.28068155288572],
        c=[-0.007784894002430293,-0.3223964580411365,-2.400758277161838,-2.549732539343734,4.374664141464968,2.938163982698783],
        d=[0.007784695709041462,0.3224671290700398,2.445134137142996,3.754408661907416], pl=0.02425;
  if(p<pl){ const q=Math.sqrt(-2*Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if(p>1-pl){ const q=Math.sqrt(-2*Math.log(1-p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  const q=p-.5, r=q*q; return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
// Build a calibration table from an array of raw scores
export function makeCal(raws){
  const s = [...raws].sort((a,b)=>a-b), n = s.length;
  const mean = s.reduce((a,v)=>a+v,0)/n, sd = Math.sqrt(s.reduce((a,v)=>a+(v-mean)**2,0)/n) || 1;
  const q = []; for(let k=0;k<=200;k++){ const pos = k/200*(n-1), lo = Math.floor(pos), hi = Math.ceil(pos); q.push(s[lo] + (s[hi]-s[lo])*(pos-lo)); }
  return {n, mean, sd, q};
}
export function calibrate(raw, cal, scale = SCALE_DEFAULT){
  const {n, sd, q} = cal, pMin = 0.5/n, pMax = 1-0.5/n;
  let z, p;
  if(raw > q[200]){ z = probit(pMax) + (raw-q[200])/sd; p = pMax; }
  else if(raw < q[0]){ z = probit(pMin) - (q[0]-raw)/sd; p = pMin; }
  else {
    let k = 0; while(k<199 && q[k+1] < raw) k++;
    const span = q[k+1]-q[k], f = span>0 ? (raw-q[k])/span : 0.5;
    // ties: use the middle of the tied run
    let lo = k, hi = k+1; if(span===0){ while(lo>0 && q[lo-1]===raw) lo--; while(hi<200 && q[hi+1]===raw) hi++; }
    p = span===0 ? ((lo+hi)/2)/200 : (k+f)/200;
    p = Math.min(pMax, Math.max(pMin, p));
    z = probit(p);
  }
  return {rating: Math.max(3, Math.min(10, scale.center + scale.spread*z)), pct: p, z};
}

// ---------- Expected goals ----------
// Chance an average shooter scores, from the NHL's shot coordinates (x toward the attacked net at x=89).
export function xgModel(x, y, type, flags){
  const dx = 89 - x, d = Math.hypot(dx, y), ang = Math.abs(Math.atan2(y, Math.max(dx,0.1))*180/Math.PI);
  if(flags.includes('e')) return Math.max(0.30, Math.min(0.95, 1.05 - 0.006*d));
  if(x < 25) return 0.01;
  const dd = Math.min(d, 62);
  let z = -0.15 - 0.10*dd + 0.0008*dd*dd - 0.03*Math.max(0, d-62) - 0.010*Math.min(ang,80);
  z += ({'tip-in':0.35,'deflected':0.35,'backhand':-0.10,'slap':0.10,'wrap-around':-0.50,'between-legs':0.2}[type] ?? 0);
  if(flags.includes('r')) z += 0.80; if(flags.includes('u')) z += 0.30; if(flags.includes('p')) z += 0.30;
  return 1/(1+Math.exp(-z));
}
export const isHD = (x, y) => { const dx = 89 - x, d = Math.hypot(dx, y), ang = Math.abs(Math.atan2(y, Math.max(dx,0.1))*180/Math.PI); return d <= 25 && ang <= 45 ? 1 : 0; };

// Raw game scores of every rated player in one game, grouped by position (for the season baseline)
export function gameRaws(g){
  const out = {F:[], D:[], G:[]};
  scoreGame(g, DEFAULTS).forEach(p=>{
    if(p.raw==null) return;
    if(p.goalie ? p.toi < MIN_TOI_G_BASE : p.toi < MIN_TOI_SK) return;
    out[grpOf(p.pos)].push(Math.round(p.raw*1000)/1000);
  });
  return out;
}
