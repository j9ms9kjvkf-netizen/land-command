import React, { useState, useEffect, useMemo } from "react";

/* ============================================================
   LAND COMMAND — Buy Box → Deal Engine for land wholesaling
   Tabs: Buy Boxes · Find Deals · Match a Parcel · Pipeline
   Persists via window.storage (falls back to memory).
   ============================================================ */

const C = {
  ink: "#18241D",
  paper: "#F3F4EE",
  panel: "#FFFFFF",
  line: "#D9DDD1",
  faint: "#6B7569",
  orange: "#FF5A1F",
  orangeDark: "#D8430E",
  green: "#2E6B4F",
  greenPale: "#E4EFE7",
  blue: "#2F62A8",
  amber: "#B57A12",
  amberPale: "#F7EDD8",
  red: "#B3261E",
  redPale: "#F8E3E1",
};

const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
.lc-display { font-family: 'Saira Condensed', 'Arial Narrow', sans-serif; }
.lc-body { font-family: 'Inter', system-ui, sans-serif; }
.lc-mono { font-family: 'JetBrains Mono', monospace; }
.lc-flagtab { clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%); }
.lc-input { border: 1px solid ${C.line}; border-radius: 4px; padding: 7px 9px; font-size: 13px; width: 100%; background: #fff; color: ${C.ink}; font-family: 'Inter', system-ui, sans-serif; }
.lc-input:focus { outline: 2px solid ${C.orange}; outline-offset: 0; border-color: ${C.orange}; }
.lc-label { font-size: 10.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: ${C.faint}; display: block; margin-bottom: 4px; }
.lc-link { color: ${C.blue}; text-decoration: none; font-weight: 600; font-size: 13px; }
.lc-link:hover { text-decoration: underline; }
.lc-stamp { display:inline-block; border: 3px double currentColor; padding: 2px 12px; font-family:'Saira Condensed',sans-serif; font-weight:800; letter-spacing:.12em; transform: rotate(-2deg); }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

const STORE_KEY = "landcommand:data";
let memoryStore = null;

async function loadData() {
  try {
    const r = await window.storage.get(STORE_KEY);
    if (r && r.value) return JSON.parse(r.value);
  } catch (e) { /* key missing or storage unavailable */ }
  return memoryStore || { buyboxes: [], leads: [], settings: { myName: "", myPhone: "", myCompany: "" } };
}
async function saveData(data) {
  memoryStore = data;
  try {
    const r = await window.storage.set(STORE_KEY, JSON.stringify(data));
    return !!r;
  } catch (e) { return false; }
}
async function probeStorage() {
  try {
    if (typeof window === "undefined" || !window.storage) return false;
    await window.storage.set("landcommand:probe", String(Date.now()));
    const r = await window.storage.get("landcommand:probe");
    return !!(r && r.value);
  } catch (e) { return false; }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const splitList = (s) => (s || "").split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);

/* Zero-dependency CSV/TSV parser (handles quoted fields, "" escapes, \r\n) */
function parseDelimited(text) {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? "\t" : ",";
  const rows = [];
  let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some(c => String(c).trim() !== "")) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some(c => String(c).trim() !== "")) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => String(h).trim());
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h || `col${i}`] = r[i] ?? ""; });
    return obj;
  });
}

/* ---------------- Buy box defaults ---------------- */
const emptyBox = () => ({
  id: uid(),
  builder: "", company: "", phone: "", email: "",
  state: "FL", counties: "", zips: "",
  lotMin: "", lotMax: "", maxPrice: "", maxPerAcre: "",
  sewer: "nearby", water: "nearby", electric: "nearby",
  topo: "flat", maxSlope: "5",
  frontageMin: "", pavedRoad: false,
  condition: "any",
  flood: "none", wetlands: "none",
  zoning: "", legalAccess: true,
  percReq: false, hoaOk: true, mobileOk: false, infill: "any",
  utilitiesMaxDist: "", soilNotes: "",
  lotsPerMonth: "", closeDays: "30", pofVerified: false,
  notes: "",
});

/* ---------------- Parcel scoring engine ---------------- */
const UTIL_LABEL = { on: "On site", nearby: "Nearby (at street)", none: "Not available" };

function scoreParcel(p, b) {
  const hard = [];   // deal breakers
  const soft = [];   // verify / negotiate
  const pass = [];
  let applicable = 0, hit = 0;
  const check = (ok, label, isHard, softLabel) => {
    applicable++;
    if (ok) { hit++; pass.push(label); }
    else if (isHard) hard.push(softLabel || label);
    else soft.push(softLabel || label);
  };

  // Location
  const zips = splitList(b.zips), counties = splitList(b.counties).map(x => x.toLowerCase());
  if (zips.length || counties.length) {
    const zipOk = zips.length ? zips.includes((p.zip || "").trim()) : false;
    const coOk = counties.length ? counties.includes((p.county || "").trim().toLowerCase()) : false;
    check(zipOk || coOk, "Inside target area", true, `Outside target area (${p.zip || "?"} / ${p.county || "?"})`);
  }
  // Size
  const ac = parseFloat(p.acres);
  if (!isNaN(ac) && (b.lotMin || b.lotMax)) {
    const mn = parseFloat(b.lotMin) || 0, mx = parseFloat(b.lotMax) || Infinity;
    const inRange = ac >= mn && ac <= mx;
    const close = ac >= mn * 0.8 && ac <= mx * 1.2;
    check(inRange, `Lot size ${ac} ac in range`, !close, inRange ? "" : `Lot size ${ac} ac vs target ${b.lotMin || "0"}–${b.lotMax || "∞"} ac`);
  }
  // Price
  const price = parseFloat(p.price);
  if (!isNaN(price) && b.maxPrice) {
    const mx = parseFloat(b.maxPrice);
    check(price <= mx, `Asking $${price.toLocaleString()} ≤ max $${mx.toLocaleString()}`, price > mx * 1.25,
      `Asking $${price.toLocaleString()} over max $${mx.toLocaleString()} — negotiate down`);
  }
  if (!isNaN(price) && !isNaN(ac) && ac > 0 && b.maxPerAcre) {
    const ppa = price / ac, mx = parseFloat(b.maxPerAcre);
    check(ppa <= mx, `$${Math.round(ppa).toLocaleString()}/ac ≤ $${mx.toLocaleString()}/ac`, false,
      `$${Math.round(ppa).toLocaleString()}/ac over $${mx.toLocaleString()}/ac target`);
  }
  // Utilities
  const utilOk = (need, have) => {
    if (need === "any" || need === "septic" || need === "well") return true;
    if (need === "on") return have === "on";
    if (need === "nearby") return have === "on" || have === "nearby";
    return true;
  };
  check(utilOk(b.sewer, p.sewer), `Sewer: ${UTIL_LABEL[p.sewer] || p.sewer}`, b.sewer === "on" && p.sewer === "none",
    `Sewer is "${UTIL_LABEL[p.sewer] || p.sewer}" but builder needs "${b.sewer}"`);
  check(utilOk(b.water, p.water), `Water: ${UTIL_LABEL[p.water] || p.water}`, b.water === "on" && p.water === "none",
    `Water is "${UTIL_LABEL[p.water] || p.water}" but builder needs "${b.water}"`);
  check(utilOk(b.electric, p.electric), `Electric: ${UTIL_LABEL[p.electric] || p.electric}`, false,
    `Electric is "${UTIL_LABEL[p.electric] || p.electric}" but builder needs "${b.electric}"`);
  // Topography
  const slope = parseFloat(p.slope);
  if (!isNaN(slope)) {
    const maxS = b.topo === "flat" ? (parseFloat(b.maxSlope) || 5) : (parseFloat(b.maxSlope) || 15);
    check(slope <= maxS, `Slope ${slope}% within ${maxS}% max`, slope > maxS * 2, `Slope ${slope}% exceeds ${maxS}% max`);
  }
  // Frontage / road
  const fr = parseFloat(p.frontage);
  if (!isNaN(fr) && b.frontageMin) {
    const mn = parseFloat(b.frontageMin);
    check(fr >= mn, `Frontage ${fr} ft ≥ ${mn} ft`, fr < mn * 0.6, `Frontage ${fr} ft under ${mn} ft minimum`);
  }
  if (b.pavedRoad) check(!!p.paved, "Paved road frontage", false, "Road is not paved — builder prefers paved");
  // Condition
  if (b.condition !== "any") {
    const ok = b.condition === "cleared" ? p.cleared : true;
    check(ok, b.condition === "cleared" ? "Cleared / build-ready" : "Wooded OK", false,
      "Not cleared — builder wants build-ready (price in clearing cost)");
  }
  // Flood
  const floodRank = { none: 0, x: 1, ae: 2, other: 3 };
  const needFlood = b.flood === "none" ? 0 : b.flood === "x" ? 1 : 3;
  check((floodRank[p.flood] ?? 3) <= needFlood, `Flood zone: ${(p.flood || "?").toUpperCase()}`, true,
    `Flood zone ${(p.flood || "?").toUpperCase()} — buy box allows ${b.flood === "none" ? "no flood zones" : b.flood.toUpperCase() + " max"}`);
  // Wetlands
  const wetRank = { none: 0, minor: 1, major: 2 };
  const needWet = b.wetlands === "none" ? 0 : b.wetlands === "minor" ? 1 : 2;
  check((wetRank[p.wetlands] ?? 2) <= needWet, `Wetlands: ${p.wetlands || "none"}`, (wetRank[p.wetlands] ?? 0) === 2 && needWet === 0,
    `Wetlands (${p.wetlands}) exceed builder tolerance (${b.wetlands})`);
  // Access
  if (b.legalAccess) check(!!p.legalAccess, "Legal / recorded access", true, "No legal access (landlocked) — deal breaker");
  // Zoning
  const zlist = splitList(b.zoning).map(z => z.toLowerCase());
  if (zlist.length && p.zoning) {
    const pz = p.zoning.trim().toLowerCase();
    check(zlist.some(z => pz.includes(z) || z.includes(pz)), `Zoning ${p.zoning} matches`, false,
      `Zoning ${p.zoning} not in builder list (${b.zoning}) — check rezoning/variance`);
  }

  const score = applicable ? Math.round((hit / applicable) * 100) : 0;
  let verdict, color, bg;
  if (hard.length) { verdict = "PASS — DEAL BREAKER"; color = C.red; bg = C.redPale; }
  else if (score >= 85) { verdict = "STRONG MATCH — SEND IT"; color = C.green; bg = C.greenPale; }
  else if (score >= 65) { verdict = "CLOSE — VERIFY & NEGOTIATE"; color = C.amber; bg = C.amberPale; }
  else { verdict = "WEAK MATCH"; color = C.faint; bg = "#EEEFEA"; }
  return { score, hard, soft, pass, verdict, color, bg };
}

/* ---------------- Search link generator ---------------- */
const g = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

function linksForBox(b) {
  const zips = splitList(b.zips);
  const counties = splitList(b.counties);
  const st = b.state || "FL";
  const zipLinks = zips.map(z => ({
    zip: z,
    items: [
      { name: "Zillow (filter: Lots/Land)", url: `https://www.zillow.com/homes/for_sale/${z}_rb/` },
      { name: "Redfin — Land only", url: `https://www.redfin.com/zipcode/${z}/filter/property-type=land` },
      { name: "LandSearch", url: `https://www.landsearch.com/properties/${z}` },
      { name: "LoopNet — Land", url: `https://www.loopnet.com/search/land/${z}/for-sale/` },
      { name: "Facebook Marketplace", url: `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent("vacant land " + z)}` },
      { name: "Craigslist (Google index)", url: g(`site:craigslist.org vacant land ${z}`) },
      { name: "LandWatch / Land.com", url: g(`landwatch OR land.com vacant land for sale ${z}`) },
      { name: "FSBO land listings", url: g(`"for sale by owner" vacant land ${z}`) },
    ],
  }));
  const countyLinks = counties.map(co => ({
    county: co,
    items: [
      { name: "Property Appraiser / Assessor", url: g(`${co} county ${st} property appraiser parcel search`) },
      { name: "GIS Parcel Viewer", url: g(`${co} county ${st} GIS map parcel viewer`) },
      { name: "Delinquent Tax List", url: g(`${co} county ${st} delinquent tax list real property`) },
      { name: "Tax Deed / Tax Lien Sales", url: g(`${co} county ${st} tax deed sale upcoming list`) },
      { name: "Clerk Foreclosure Auctions", url: g(`${co} county ${st} clerk of court foreclosure auction calendar`) },
      { name: "Code Enforcement Liens", url: g(`${co} county ${st} code enforcement lien list`) },
      { name: "Probate Case Search", url: g(`${co} county ${st} probate court records search`) },
      { name: "County Surplus Land", url: g(`${co} county ${st} surplus property land list for sale`) },
      { name: "Auction.com — county land", url: g(`auction.com land ${co} county ${st}`) },
    ],
  }));
  const global = [
    { name: "Regrid (parcel data + owners)", url: "https://app.regrid.com/" },
    { name: "PropStream", url: "https://login.propstream.com/" },
    { name: "Land Portal", url: "https://thelandportal.com/" },
    { name: "Land Insights", url: "https://www.landinsights.co/" },
    { name: "Google Earth (terrain/clearing check)", url: "https://earth.google.com/web/" },
    { name: "FEMA Flood Map (verify zones)", url: "https://msc.fema.gov/portal/home" },
    { name: "USFWS Wetlands Mapper", url: "https://www.fws.gov/program/national-wetlands-inventory/wetlands-mapper" },
    { name: "Web Soil Survey (perc/soils)", url: "https://websoilsurvey.nrcs.usda.gov/app/" },
    { name: "HUD Home Store", url: "https://www.hudhomestore.gov/" },
    { name: "GovDeals (gov surplus)", url: "https://www.govdeals.com/" },
    { name: "Bid4Assets (county tax sales)", url: "https://www.bid4assets.com/" },
    { name: "GSA Real Property Auctions", url: "https://realestatesales.gov/" },
    { name: "Census QuickFacts (growth check)", url: "https://www.census.gov/quickfacts/" },
  ];
  return { zipLinks, countyLinks, global };
}

/* ---------------- Off-market playbook content ---------------- */
const PLAYBOOK = [
  {
    title: "The money stack — pull this list first (Regrid / PropStream)",
    steps: [
      "Property type: Vacant land only, inside the buy box zips/counties.",
      "Lot size: set min/max acres straight from the buy box.",
      "Owner location: Out-of-state owner (absentee). These owners answer mail.",
      "Ownership length: 7+ years (5–10+ is the sweet spot — high equity, low attachment).",
      "Tax status: layer in 'tax delinquent' as a second list — these are your hottest leads.",
      "No mortgage / free & clear: filter on, so they can take a cash discount.",
      "Export with owner mailing address + APN, then skip trace for phones.",
    ],
  },
  {
    title: "Secondary stacks (run monthly)",
    steps: [
      "In-state absentee owners (own land in county A, live in county B).",
      "Inherited / probate land — cross-reference county probate filings with vacant parcels.",
      "Code violation liens on vacant lots (owner is bleeding money on mowing fines).",
      "Owners with 2+ vacant parcels — one call can net multiple deals.",
      "Pre-foreclosure (lis pendens) on land notes via the county clerk.",
      "Expired/withdrawn land listings on MLS history in PropStream — motivated but failed to sell.",
    ],
  },
  {
    title: "Verify the parcel before you offer (15-minute desktop diligence)",
    steps: [
      "Google Earth: confirm clearing, tree cover, structures, road frontage, neighbors.",
      "Regrid/county GIS: APN, acreage, zoning, dimensions, legal access (does it touch a road?).",
      "FEMA flood map: confirm Zone X or none — screenshot for the builder.",
      "USFWS Wetlands Mapper + Web Soil Survey: wetlands overlap and soil/perc viability.",
      "Utility check: county/city utility maps or call the utility — sewer & water at street?",
      "Tax collector: verify amounts owed (delinquency = negotiating leverage).",
      "Comp it: sold vacant lots in same zip, last 12 months, similar size — Redfin/Zillow sold filter.",
    ],
  },
  {
    title: "Outreach cadence (text → call → mail)",
    steps: [
      "Day 1 — Text: short, human, specific: 'Hi {name}, are you the owner of the {acres}-acre lot on {road}? I'm a local cash buyer.'",
      "Day 2 — Call: two attempts (morning + early evening). Leave one voicemail max.",
      "Day 5 — Mailer #1: handwritten-style postcard with the APN and a real callback number.",
      "Day 21 — Mailer #2: offer-range letter ('I can pay $X–$Y cash, close in 30 days, I pay all costs').",
      "Day 45+ — Repeat quarterly. Land sellers convert on touch 4–7, not touch 1.",
      "Log every touch in the Pipeline tab so nothing slips.",
    ],
  },
];

/* ============================================================
   UI atoms
   ============================================================ */
const Field = ({ label, children, span }) => (
  <div style={{ gridColumn: span ? `span ${span}` : undefined }}>
    <label className="lc-label">{label}</label>
    {children}
  </div>
);

const Seg = ({ value, onChange, options }) => (
  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
    {options.map(([val, lab]) => (
      <button key={val} onClick={() => onChange(val)} type="button"
        style={{
          padding: "6px 10px", fontSize: 12, fontWeight: 600, borderRadius: 4, cursor: "pointer",
          border: `1px solid ${value === val ? C.ink : C.line}`,
          background: value === val ? C.ink : "#fff",
          color: value === val ? "#fff" : C.ink,
        }}>{lab}</button>
    ))}
  </div>
);

const Toggle = ({ checked, onChange, label }) => (
  <button type="button" onClick={() => onChange(!checked)}
    style={{
      display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 4,
      border: `1px solid ${checked ? C.green : C.line}`, background: checked ? C.greenPale : "#fff",
      cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: checked ? C.green : C.faint, width: "100%",
    }}>
    <span style={{
      width: 14, height: 14, borderRadius: 3, flexShrink: 0,
      border: `2px solid ${checked ? C.green : C.faint}`, background: checked ? C.green : "transparent",
    }} />
    {label}
  </button>
);

const SectionHead = ({ children }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0 10px" }}>
    <span className="lc-display" style={{ fontSize: 15, fontWeight: 800, letterSpacing: ".1em", textTransform: "uppercase", color: C.ink }}>{children}</span>
    <span style={{ flex: 1, height: 1, background: C.line }} />
  </div>
);

const Btn = ({ children, onClick, kind = "primary", small }) => {
  const styles = {
    primary: { background: C.orange, color: "#fff", border: `1px solid ${C.orangeDark}` },
    ghost: { background: "#fff", color: C.ink, border: `1px solid ${C.line}` },
    danger: { background: "#fff", color: C.red, border: `1px solid ${C.red}` },
  }[kind];
  return (
    <button type="button" onClick={onClick}
      style={{ ...styles, padding: small ? "5px 10px" : "9px 16px", borderRadius: 4, fontWeight: 700, fontSize: small ? 12 : 13.5, cursor: "pointer", letterSpacing: ".02em" }}>
      {children}
    </button>
  );
};

/* ============================================================
   TAB 1 — Buy Boxes
   ============================================================ */
function BuyBoxForm({ initial, onSave, onCancel }) {
  const [b, setB] = useState(initial);
  const set = (k) => (e) => setB({ ...b, [k]: e.target ? e.target.value : e });
  const setV = (k) => (v) => setB({ ...b, [k]: v });
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 20 }}>
      <SectionHead>Builder identity</SectionHead>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        <Field label="Builder name"><input className="lc-input" value={b.builder} onChange={set("builder")} placeholder="John Smith" /></Field>
        <Field label="Company"><input className="lc-input" value={b.company} onChange={set("company")} placeholder="Smith Custom Homes" /></Field>
        <Field label="Phone"><input className="lc-input" value={b.phone} onChange={set("phone")} placeholder="(727) 555-0142" /></Field>
        <Field label="Email"><input className="lc-input" value={b.email} onChange={set("email")} placeholder="john@..." /></Field>
      </div>

      <SectionHead>Target area</SectionHead>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        <Field label="State"><input className="lc-input" value={b.state} onChange={set("state")} placeholder="FL" /></Field>
        <Field label="Counties (comma separated)" span={2}><input className="lc-input" value={b.counties} onChange={set("counties")} placeholder="Pinellas, Pasco, Hillsborough" /></Field>
        <Field label="Target zip codes (comma separated)" span={2}><input className="lc-input" value={b.zips} onChange={set("zips")} placeholder="33755, 33756, 34652" /></Field>
      </div>

      <SectionHead>Lot & price</SectionHead>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <Field label="Min lot size (acres)"><input className="lc-input" type="number" value={b.lotMin} onChange={set("lotMin")} placeholder="0.15" /></Field>
        <Field label="Max lot size (acres)"><input className="lc-input" type="number" value={b.lotMax} onChange={set("lotMax")} placeholder="1.0" /></Field>
        <Field label="Max price per lot ($)"><input className="lc-input" type="number" value={b.maxPrice} onChange={set("maxPrice")} placeholder="60000" /></Field>
        <Field label="Max $ / acre (optional)"><input className="lc-input" type="number" value={b.maxPerAcre} onChange={set("maxPerAcre")} placeholder="120000" /></Field>
      </div>

      <SectionHead>Utilities</SectionHead>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        <Field label="Sewer"><Seg value={b.sewer} onChange={setV("sewer")} options={[["on","On site"],["nearby","Nearby OK"],["septic","Septic OK"],["any","Any"]]} /></Field>
        <Field label="Water"><Seg value={b.water} onChange={setV("water")} options={[["on","On site"],["nearby","Nearby OK"],["well","Well OK"],["any","Any"]]} /></Field>
        <Field label="Electric"><Seg value={b.electric} onChange={setV("electric")} options={[["on","On site"],["nearby","Nearby OK"],["any","Any"]]} /></Field>
        <Field label="Max distance to utilities (ft, optional)"><input className="lc-input" type="number" value={b.utilitiesMaxDist} onChange={set("utilitiesMaxDist")} placeholder="300" /></Field>
      </div>

      <SectionHead>Land characteristics</SectionHead>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        <Field label="Topography"><Seg value={b.topo} onChange={setV("topo")} options={[["flat","Flat only"],["slope","Some slope OK"]]} /></Field>
        <Field label="Max slope %"><input className="lc-input" type="number" value={b.maxSlope} onChange={set("maxSlope")} placeholder="5" /></Field>
        <Field label="Min road frontage (ft)"><input className="lc-input" type="number" value={b.frontageMin} onChange={set("frontageMin")} placeholder="50" /></Field>
        <Field label="Lot condition"><Seg value={b.condition} onChange={setV("condition")} options={[["cleared","Cleared / build-ready"],["wooded","Wooded OK"],["any","Any"]]} /></Field>
        <Field label="Flood zone tolerance"><Seg value={b.flood} onChange={setV("flood")} options={[["none","No flood zones"],["x","Zone X OK"],["any","Any"]]} /></Field>
        <Field label="Wetlands tolerance"><Seg value={b.wetlands} onChange={setV("wetlands")} options={[["none","None"],["minor","Minor edge OK"],["any","Any"]]} /></Field>
        <Field label="Acceptable zoning (comma separated)" span={2}><input className="lc-input" value={b.zoning} onChange={set("zoning")} placeholder="R-1, R-2, RSF, AR" /></Field>
        <Field label="Infill vs rural"><Seg value={b.infill} onChange={setV("infill")} options={[["infill","Infill"],["rural","Rural"],["any","Any"]]} /></Field>
        <Field label="Soil / perc notes"><input className="lc-input" value={b.soilNotes} onChange={set("soilNotes")} placeholder="Needs sandy soil, no muck" /></Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginTop: 12 }}>
        <Toggle checked={b.pavedRoad} onChange={setV("pavedRoad")} label="Paved road required" />
        <Toggle checked={b.legalAccess} onChange={setV("legalAccess")} label="Legal access required (no landlocked)" />
        <Toggle checked={b.percReq} onChange={setV("percReq")} label="Perc test required before close" />
        <Toggle checked={b.hoaOk} onChange={setV("hoaOk")} label="HOA / deed-restricted OK" />
        <Toggle checked={b.mobileOk} onChange={setV("mobileOk")} label="Mobile/manufactured zones OK" />
        <Toggle checked={b.pofVerified} onChange={setV("pofVerified")} label="Proof of funds verified" />
      </div>

      <SectionHead>Deal terms</SectionHead>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        <Field label="Lots per month they can absorb"><input className="lc-input" type="number" value={b.lotsPerMonth} onChange={set("lotsPerMonth")} placeholder="2" /></Field>
        <Field label="Closing timeline (days)"><input className="lc-input" type="number" value={b.closeDays} onChange={set("closeDays")} placeholder="30" /></Field>
        <Field label="Notes" span={2}><input className="lc-input" value={b.notes} onChange={set("notes")} placeholder="Prefers corner lots; will pay premium for double lots" /></Field>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
        <Btn onClick={() => onSave(b)}>Save buy box</Btn>
        <Btn kind="ghost" onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}

function boxSummary(b) {
  const bits = [];
  if (b.lotMin || b.lotMax) bits.push(`${b.lotMin || "0"}–${b.lotMax || "∞"} ac`);
  if (b.maxPrice) bits.push(`≤ $${Number(b.maxPrice).toLocaleString()}`);
  bits.push(`Sewer: ${b.sewer}`, `Water: ${b.water}`, b.topo === "flat" ? `flat ≤${b.maxSlope || 5}%` : `slope ≤${b.maxSlope}%`);
  if (b.flood === "none") bits.push("no flood");
  if (b.condition !== "any") bits.push(b.condition);
  return bits.join(" · ");
}

function BuyBoxesTab({ data, update, prefill, onPrefillConsumed }) {
  const [editing, setEditing] = useState(null); // box object or null
  useEffect(() => {
    if (prefill) {
      setEditing({ ...emptyBox(), counties: prefill.counties || "", state: prefill.state || "" });
      onPrefillConsumed && onPrefillConsumed();
    }
  }, [prefill]);
  const save = (box) => {
    const exists = data.buyboxes.some(x => x.id === box.id);
    const buyboxes = exists ? data.buyboxes.map(x => x.id === box.id ? box : x) : [...data.buyboxes, box];
    update({ ...data, buyboxes });
    setEditing(null);
  };
  if (editing) return <BuyBoxForm initial={editing} onSave={save} onCancel={() => setEditing(null)} />;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div>
          <div className="lc-display" style={{ fontSize: 22, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em" }}>Builder buy boxes</div>
          <div style={{ fontSize: 13, color: C.faint }}>Every criterion you capture here powers the deal finder and the match scorer.</div>
        </div>
        <Btn onClick={() => setEditing(emptyBox())}>+ New buy box</Btn>
      </div>
      {data.buyboxes.length === 0 && (
        <div style={{ border: `2px dashed ${C.line}`, borderRadius: 8, padding: 40, textAlign: "center", color: C.faint, fontSize: 14 }}>
          No buy boxes yet. Add your first builder — capture exactly what they'll pay cash for.
        </div>
      )}
      <div style={{ display: "grid", gap: 12 }}>
        {data.buyboxes.map(b => (
          <div key={b.id} style={{ background: C.panel, border: `1px solid ${C.line}`, borderLeft: `5px solid ${C.orange}`, borderRadius: 8, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div>
                <div className="lc-display" style={{ fontSize: 18, fontWeight: 800, textTransform: "uppercase" }}>{b.builder || "Unnamed builder"}{b.company ? <span style={{ color: C.faint, fontWeight: 600 }}> — {b.company}</span> : null}</div>
                <div className="lc-mono" style={{ fontSize: 12, color: C.green, fontWeight: 600, margin: "3px 0" }}>{splitList(b.counties).join(" · ") || "No counties"} | {splitList(b.zips).slice(0, 8).join(", ") || "no zips"}{splitList(b.zips).length > 8 ? "…" : ""}</div>
                <div style={{ fontSize: 12.5, color: C.ink }}>{boxSummary(b)}</div>
                {b.notes && <div style={{ fontSize: 12, color: C.faint, marginTop: 4 }}>“{b.notes}”</div>}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                {b.pofVerified && <span className="lc-stamp" style={{ color: C.green, fontSize: 11 }}>POF ✓</span>}
                <Btn small kind="ghost" onClick={() => setEditing({ ...b })}>Edit</Btn>
                <Btn small kind="danger" onClick={() => update({ ...data, buyboxes: data.buyboxes.filter(x => x.id !== b.id) })}>Delete</Btn>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   TAB 2 — Find Deals
   ============================================================ */
function FindDealsTab({ data }) {
  const [boxId, setBoxId] = useState(data.buyboxes[0]?.id || "");
  const [open, setOpen] = useState(0);
  const box = data.buyboxes.find(b => b.id === boxId);
  const links = useMemo(() => box ? linksForBox(box) : null, [box]);

  if (!data.buyboxes.length) return (
    <div style={{ border: `2px dashed ${C.line}`, borderRadius: 8, padding: 40, textAlign: "center", color: C.faint }}>
      Add a buy box first — the deal finder builds every search around the builder's exact criteria.
    </div>
  );
  return (
    <div>
      <div className="lc-display" style={{ fontSize: 22, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em" }}>Deal sourcing engine</div>
      <div style={{ fontSize: 13, color: C.faint, marginBottom: 14 }}>Pick a buy box. Every link below is pre-targeted to that builder's zips and counties — open them in tabs and run the route.</div>
      <div style={{ maxWidth: 420, marginBottom: 18 }}>
        <label className="lc-label">Active buy box</label>
        <select className="lc-input" value={boxId} onChange={e => setBoxId(e.target.value)}>
          {data.buyboxes.map(b => <option key={b.id} value={b.id}>{b.builder || "Unnamed"} — {splitList(b.counties).join(", ") || "no counties"}</option>)}
        </select>
      </div>

      {box && (
        <div style={{ background: C.greenPale, border: `1px solid ${C.green}`, borderRadius: 8, padding: "10px 14px", marginBottom: 18, fontSize: 12.5, color: C.ink }}>
          <strong>Hunting for:</strong> {boxSummary(box)} {box.frontageMin ? `· ≥${box.frontageMin} ft frontage` : ""} {box.legalAccess ? "· legal access required" : ""}
        </div>
      )}

      <SectionHead>On-market — by zip code</SectionHead>
      {links.zipLinks.length === 0 && <div style={{ fontSize: 13, color: C.faint }}>No zips in this buy box — add zips to generate listing searches.</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
        {links.zipLinks.map(zl => (
          <div key={zl.zip} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14 }}>
            <div className="lc-mono" style={{ fontWeight: 600, fontSize: 14, color: C.orange, marginBottom: 8 }}>ZIP {zl.zip}</div>
            <div style={{ display: "grid", gap: 6 }}>
              {zl.items.map(it => <a key={it.name} className="lc-link" href={it.url} target="_blank" rel="noreferrer">↗ {it.name}</a>)}
            </div>
          </div>
        ))}
      </div>

      <SectionHead>Off-market & public records — by county</SectionHead>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
        {links.countyLinks.map(cl => (
          <div key={cl.county} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14 }}>
            <div className="lc-display" style={{ fontWeight: 800, fontSize: 15, textTransform: "uppercase", marginBottom: 8 }}>{cl.county} County</div>
            <div style={{ display: "grid", gap: 6 }}>
              {cl.items.map(it => <a key={it.name} className="lc-link" href={it.url} target="_blank" rel="noreferrer">↗ {it.name}</a>)}
            </div>
          </div>
        ))}
      </div>

      <SectionHead>Data, diligence & auction tools</SectionHead>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8 }}>
        {links.global.map(it => <a key={it.name} className="lc-link" href={it.url} target="_blank" rel="noreferrer">↗ {it.name}</a>)}
      </div>

      <SectionHead>Off-market playbook</SectionHead>
      <div style={{ display: "grid", gap: 8 }}>
        {PLAYBOOK.map((p, i) => (
          <div key={i} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
            <button type="button" onClick={() => setOpen(open === i ? -1 : i)}
              style={{ width: "100%", textAlign: "left", padding: "12px 16px", background: open === i ? C.ink : "#fff", color: open === i ? "#fff" : C.ink, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 14, fontFamily: "'Saira Condensed', sans-serif", textTransform: "uppercase", letterSpacing: ".05em" }}>
              {open === i ? "▾ " : "▸ "}{p.title}
            </button>
            {open === i && (
              <ol style={{ margin: 0, padding: "12px 16px 14px 34px", display: "grid", gap: 7 }}>
                {p.steps.map((s, j) => <li key={j} style={{ fontSize: 13.5, lineHeight: 1.5 }}>{s}</li>)}
              </ol>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   TAB 3 — Match a Parcel
   ============================================================ */
const emptyParcel = () => ({
  apn: "", zip: "", county: "", acres: "", price: "",
  sewer: "nearby", water: "nearby", electric: "nearby",
  slope: "", frontage: "", paved: true, cleared: false,
  flood: "none", wetlands: "none", legalAccess: true, zoning: "",
});

function MatchTab({ data, update }) {
  const [p, setP] = useState(emptyParcel());
  const [results, setResults] = useState(null);
  const set = (k) => (e) => setP({ ...p, [k]: e.target ? e.target.value : e });
  const setV = (k) => (v) => setP({ ...p, [k]: v });

  const run = () => {
    const r = data.buyboxes.map(b => ({ box: b, ...scoreParcel(p, b) })).sort((a, b2) => (b2.hard.length ? -1000 + b2.score : b2.score) - (a.hard.length ? -1000 + a.score : a.score));
    setResults(r);
  };
  const pushToPipeline = (boxName) => {
    const lead = {
      id: uid(), owner: "", apn: p.apn, county: p.county, zip: p.zip, acres: p.acres,
      price: p.price, address: "", mailing: "", offer: "", source: "Match scorer", phone: "", status: "New",
      buybox: boxName, texted: "", called: "", mailed: "", notes: "",
      created: new Date().toISOString().slice(0, 10),
    };
    update({ ...data, leads: [lead, ...data.leads] });
  };

  if (!data.buyboxes.length) return (
    <div style={{ border: `2px dashed ${C.line}`, borderRadius: 8, padding: 40, textAlign: "center", color: C.faint }}>
      Add at least one buy box to score parcels against.
    </div>
  );
  return (
    <div>
      <div className="lc-display" style={{ fontSize: 22, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em" }}>Match a parcel</div>
      <div style={{ fontSize: 13, color: C.faint, marginBottom: 14 }}>Found a lot? Enter what you verified (Google Earth, GIS, FEMA) — it gets scored against every builder instantly.</div>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
          <Field label="APN / Parcel ID"><input className="lc-input" value={p.apn} onChange={set("apn")} placeholder="12-34-56-..." /></Field>
          <Field label="Zip"><input className="lc-input" value={p.zip} onChange={set("zip")} placeholder="33755" /></Field>
          <Field label="County"><input className="lc-input" value={p.county} onChange={set("county")} placeholder="Pinellas" /></Field>
          <Field label="Acres"><input className="lc-input" type="number" value={p.acres} onChange={set("acres")} placeholder="0.25" /></Field>
          <Field label="Asking / target price ($)"><input className="lc-input" type="number" value={p.price} onChange={set("price")} placeholder="45000" /></Field>
          <Field label="Zoning"><input className="lc-input" value={p.zoning} onChange={set("zoning")} placeholder="R-2" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginTop: 14 }}>
          <Field label="Sewer"><Seg value={p.sewer} onChange={setV("sewer")} options={[["on","On site"],["nearby","At street"],["none","None"]]} /></Field>
          <Field label="Water"><Seg value={p.water} onChange={setV("water")} options={[["on","On site"],["nearby","At street"],["none","None"]]} /></Field>
          <Field label="Electric"><Seg value={p.electric} onChange={setV("electric")} options={[["on","On site"],["nearby","At street"],["none","None"]]} /></Field>
          <Field label="Flood zone"><Seg value={p.flood} onChange={setV("flood")} options={[["none","None"],["x","X"],["ae","AE"],["other","Other"]]} /></Field>
          <Field label="Wetlands"><Seg value={p.wetlands} onChange={setV("wetlands")} options={[["none","None"],["minor","Minor"],["major","Major"]]} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 14 }}>
          <Field label="Slope %"><input className="lc-input" type="number" value={p.slope} onChange={set("slope")} placeholder="2" /></Field>
          <Field label="Road frontage (ft)"><input className="lc-input" type="number" value={p.frontage} onChange={set("frontage")} placeholder="75" /></Field>
          <Toggle checked={p.paved} onChange={setV("paved")} label="Paved road" />
          <Toggle checked={p.cleared} onChange={setV("cleared")} label="Cleared / build-ready" />
          <Toggle checked={p.legalAccess} onChange={setV("legalAccess")} label="Legal access" />
        </div>
        <div style={{ marginTop: 16 }}><Btn onClick={run}>Score against all buy boxes</Btn></div>
      </div>

      {results && (
        <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
          {results.map(r => (
            <div key={r.box.id} style={{ background: r.bg, border: `1px solid ${r.color}`, borderRadius: 8, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
                <div>
                  <div className="lc-display" style={{ fontSize: 17, fontWeight: 800, textTransform: "uppercase" }}>{r.box.builder || "Unnamed builder"}</div>
                  <div className="lc-mono" style={{ fontSize: 12, color: C.faint }}>{splitList(r.box.counties).join(" · ")}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span className="lc-stamp" style={{ color: r.color, fontSize: 14 }}>{r.verdict}</span>
                  <div className="lc-mono" style={{ fontSize: 24, fontWeight: 600, color: r.color, marginTop: 4 }}>{r.score}%</div>
                </div>
              </div>
              {r.hard.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="lc-label" style={{ color: C.red }}>Deal breakers</div>
                  {r.hard.map((h, i) => <div key={i} style={{ fontSize: 13, color: C.red }}>✕ {h}</div>)}
                </div>
              )}
              {r.soft.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="lc-label" style={{ color: C.amber }}>Verify / negotiate</div>
                  {r.soft.map((h, i) => <div key={i} style={{ fontSize: 13, color: C.amber }}>⚠ {h}</div>)}
                </div>
              )}
              {r.pass.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="lc-label" style={{ color: C.green }}>Matches ({r.pass.length})</div>
                  <div style={{ fontSize: 12.5, color: C.green }}>{r.pass.join("  ·  ")}</div>
                </div>
              )}
              {!r.hard.length && r.score >= 65 && (
                <div style={{ marginTop: 12 }}>
                  <Btn small onClick={() => pushToPipeline(r.box.builder)}>+ Add to pipeline for {r.box.builder || "this builder"}</Btn>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   TAB 4 — Pipeline (owner leads + outreach tracking)
   ============================================================ */
const STATUSES = ["New", "Researching", "Skip traced", "Contacted", "Negotiating", "Under contract", "Assigned", "Closed", "Dead"];
const STATUS_COLOR = {
  "New": C.blue, "Researching": C.blue, "Skip traced": C.amber, "Contacted": C.amber,
  "Negotiating": C.orange, "Under contract": C.green, "Assigned": C.green, "Closed": C.green, "Dead": C.faint,
};

const emptyLead = () => ({
  id: uid(), owner: "", apn: "", county: "", zip: "", acres: "", price: "",
  address: "", mailing: "", offer: "",
  source: "", phone: "", status: "New", buybox: "",
  texted: "", called: "", mailed: "", notes: "",
  created: new Date().toISOString().slice(0, 10),
});

function LeadForm({ initial, buyboxes, onSave, onCancel }) {
  const [l, setL] = useState(initial);
  const set = (k) => (e) => setL({ ...l, [k]: e.target.value });
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 18, marginBottom: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <Field label="Owner name"><input className="lc-input" value={l.owner} onChange={set("owner")} placeholder="Mary Johnson" /></Field>
        <Field label="Phone"><input className="lc-input" value={l.phone} onChange={set("phone")} placeholder="(813) 555-0190" /></Field>
        <Field label="APN / Parcel ID"><input className="lc-input" value={l.apn} onChange={set("apn")} /></Field>
        <Field label="County"><input className="lc-input" value={l.county} onChange={set("county")} /></Field>
        <Field label="Zip"><input className="lc-input" value={l.zip} onChange={set("zip")} /></Field>
        <Field label="Acres"><input className="lc-input" type="number" value={l.acres} onChange={set("acres")} /></Field>
        <Field label="Target price ($)"><input className="lc-input" type="number" value={l.price} onChange={set("price")} /></Field>
        <Field label="Your offer ($, from Deal Calc)"><input className="lc-input" type="number" value={l.offer || ""} onChange={set("offer")} /></Field>
        <Field label="Property address / road" span={2}><input className="lc-input" value={l.address || ""} onChange={set("address")} placeholder="Vacant lot on Pine St" /></Field>
        <Field label="Owner mailing address (for mailers/skip trace)" span={2}><input className="lc-input" value={l.mailing || ""} onChange={set("mailing")} placeholder="123 Oak Ave, Columbus, OH 43004" /></Field>
        <Field label="Lead source"><input className="lc-input" value={l.source} onChange={set("source")} placeholder="Tax delinquent list" /></Field>
        <Field label="Matched buy box">
          <select className="lc-input" value={l.buybox} onChange={set("buybox")}>
            <option value="">—</option>
            {buyboxes.map(b => <option key={b.id} value={b.builder}>{b.builder || "Unnamed"}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select className="lc-input" value={l.status} onChange={set("status")}>
            {STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Last text"><input className="lc-input" type="date" value={l.texted} onChange={set("texted")} /></Field>
        <Field label="Last call"><input className="lc-input" type="date" value={l.called} onChange={set("called")} /></Field>
        <Field label="Last mailer"><input className="lc-input" type="date" value={l.mailed} onChange={set("mailed")} /></Field>
        <Field label="Notes" span={3}><input className="lc-input" value={l.notes} onChange={set("notes")} placeholder="Owns since 2009, lives in Ohio, 2 yrs taxes owed" /></Field>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <Btn onClick={() => onSave(l)}>Save lead</Btn>
        <Btn kind="ghost" onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}

function PipelineTab({ data, update }) {
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState("All");
  const [scriptsFor, setScriptsFor] = useState(null); // lead id
  const [importMsg, setImportMsg] = useState("");
  const save = (lead) => {
    const exists = data.leads.some(x => x.id === lead.id);
    const leads = exists ? data.leads.map(x => x.id === lead.id ? lead : x) : [lead, ...data.leads];
    update({ ...data, leads });
    setEditing(null);
  };
  const touch = (lead, kind) => {
    const today = new Date().toISOString().slice(0, 10);
    save({ ...lead, [kind]: today, status: lead.status === "New" || lead.status === "Skip traced" ? "Contacted" : lead.status });
  };
  const shown = data.leads.filter(l => filter === "All" || l.status === filter);
  const counts = STATUSES.reduce((a, s) => ({ ...a, [s]: data.leads.filter(l => l.status === s).length }), {});

  const [csvOut, setCsvOut] = useState(null);     // export panel content
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [copiedCsv, setCopiedCsv] = useState(false);

  const buildCSV = () => {
    const headers = ["OwnerName","Phone","MailingAddress","PropertyAddress","APN","County","Zip","Acres","TargetPrice","MyOffer","Status","BuyBox","Source","LastText","LastCall","LastMailer","Created","Notes"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = data.leads.map(l => [l.owner,l.phone,l.mailing,l.address,l.apn,l.county,l.zip,l.acres,l.price,l.offer,l.status,l.buybox,l.source,l.texted,l.called,l.mailed,l.created,l.notes].map(esc).join(","));
    return [headers.join(","), ...rows].join("\r\n");
  };

  const exportCSV = () => {
    const csv = buildCSV();
    setCsvOut(csv); // guaranteed path: always show the panel
    try {           // bonus path: real download where the environment allows it
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url; a.download = `landcommand-leads-${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { /* sandbox blocked the download — panel below still has the data */ }
  };

  const ingestRows = (rows) => {
    try {
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const pick = (row, names) => {
        for (const key of Object.keys(row)) if (names.includes(norm(key)) && String(row[key]).trim()) return String(row[key]).trim();
        return "";
      };
      const newLeads = rows.map(row => ({
        ...emptyLead(),
        owner: pick(row, ["owner","ownername","name","fullname","owner1","ownernamefull","firstownername"]),
        phone: pick(row, ["phone","phonenumber","phone1","mobile","cell","telephone"]),
        apn: pick(row, ["apn","parcel","parcelid","parcelnumber","parcelno","pin","accountnumber"]),
        county: pick(row, ["county","countyname"]),
        zip: pick(row, ["zip","zipcode","zip5","postalcode","situszip","propertyzip"]),
        acres: pick(row, ["acres","acreage","lotsize","lotacres","lotsizeacres","calculatedacres"]),
        address: pick(row, ["address","propertyaddress","situsaddress","situs","siteaddress","propertyfulladdress"]),
        mailing: pick(row, ["mailing","mailingaddress","owneraddress","mailaddress","mailingfulladdress","ownermailingaddress"]),
        price: pick(row, ["price","askingprice","listprice","assessedvalue","marketvalue"]),
        source: "CSV import",
      })).filter(l => l.owner || l.apn || l.address);
      if (!newLeads.length) {
        setImportMsg("No usable rows found — make sure the first line is a header row with owner / APN / address columns.");
        setTimeout(() => setImportMsg(""), 6000);
        return;
      }
      update({ ...data, leads: [...newLeads, ...data.leads] });
      setImportMsg(`Imported ${newLeads.length} lead${newLeads.length === 1 ? "" : "s"} ✓`);
      setPasteOpen(false); setPasteText("");
      setTimeout(() => setImportMsg(""), 5000);
    } catch (e) {
      setImportMsg(`Import error: ${e.message || e}`);
      setTimeout(() => setImportMsg(""), 8000);
    }
  };

  const importFile = (file) => {
    if (!file) return;
    try {
      const reader = new FileReader();
      reader.onload = () => ingestRows(parseDelimited(String(reader.result || "")));
      reader.onerror = () => { setImportMsg("Couldn't read that file — use Paste CSV instead."); setTimeout(() => setImportMsg(""), 6000); };
      reader.readAsText(file);
    } catch (e) {
      setImportMsg(`File error: ${e.message || e} — use Paste CSV instead.`);
      setTimeout(() => setImportMsg(""), 8000);
    }
  };

  const importPasted = () => {
    try {
      const txt = pasteText.trim();
      if (!txt) { setImportMsg("Paste your CSV text first (including the header row)."); setTimeout(() => setImportMsg(""), 4000); return; }
      ingestRows(parseDelimited(txt));
    } catch (e) {
      setImportMsg(`Import error: ${e.message || e}`);
      setTimeout(() => setImportMsg(""), 8000);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div className="lc-display" style={{ fontSize: 22, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em" }}>Owner pipeline</div>
          <div style={{ fontSize: 13, color: C.faint }}>Every owner you find, every text/call/mailer you send — logged here so touches 4–7 actually happen.</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {importMsg && <span style={{ fontSize: 12.5, fontWeight: 700, color: importMsg.includes("✓") ? C.green : C.red }}>{importMsg}</span>}
          <label style={{ padding: "9px 16px", borderRadius: 4, fontWeight: 700, fontSize: 13.5, cursor: "pointer", border: `1px solid ${C.line}`, background: "#fff", color: C.ink }}>
            ⇪ Import file
            <input type="file" accept=".csv,text/csv,text/plain" style={{ display: "none" }} onChange={(e) => { importFile(e.target.files[0]); e.target.value = ""; }} />
          </label>
          <Btn kind="ghost" onClick={() => { setPasteOpen(!pasteOpen); setCsvOut(null); }}>{pasteOpen ? "✕ Close paste" : "⇪ Paste CSV"}</Btn>
          <Btn kind="ghost" onClick={() => { if (csvOut) { setCsvOut(null); } else { setPasteOpen(false); exportCSV(); } }}>{csvOut ? "✕ Close export" : "⇩ Export CSV"}</Btn>
          <Btn onClick={() => setEditing(emptyLead())}>+ New lead</Btn>
        </div>
      </div>

      {pasteOpen && (
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, margin: "10px 0" }}>
          <div className="lc-label">Paste CSV text (header row + data) — works with Regrid, PropStream, or county list exports</div>
          <textarea className="lc-input" rows={7} value={pasteText} onChange={e => setPasteText(e.target.value)}
            placeholder={"OwnerName,Phone,APN,County,Zip,Acres,MailingAddress\nMary Johnson,(813) 555-0190,12-34-56,Hays,78640,0.25,123 Oak Ave Columbus OH"}
            style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <Btn onClick={importPasted}>Import pasted rows</Btn>
            <Btn small kind="ghost" onClick={() => setPasteText("")}>Clear</Btn>
          </div>
        </div>
      )}

      {csvOut !== null && (
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, margin: "10px 0" }}>
          <div className="lc-label">Your pipeline as CSV ({data.leads.length} lead{data.leads.length === 1 ? "" : "s"}) — copy it, then paste into a .csv file, Google Sheets, or your skip-trace upload</div>
          <textarea className="lc-input" rows={8} readOnly value={csvOut} onFocus={e => e.target.select()}
            style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
            <Btn onClick={async () => { await copyText(csvOut); setCopiedCsv(true); setTimeout(() => setCopiedCsv(false), 2000); }}>{copiedCsv ? "Copied ✓" : "Copy all"}</Btn>
            <span style={{ fontSize: 11.5, color: C.faint }}>Tip: in Google Sheets, paste then use Data → Split text to columns if needed. A file download was also attempted — check your downloads.</span>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "10px 0 16px" }}>
        {["All", ...STATUSES].map(s => (
          <button key={s} type="button" onClick={() => setFilter(s)}
            style={{ padding: "5px 10px", borderRadius: 99, fontSize: 11.5, fontWeight: 700, cursor: "pointer",
              border: `1px solid ${filter === s ? C.ink : C.line}`, background: filter === s ? C.ink : "#fff", color: filter === s ? "#fff" : C.ink }}>
            {s}{s !== "All" ? ` (${counts[s]})` : ` (${data.leads.length})`}
          </button>
        ))}
      </div>
      {editing && <LeadForm initial={editing} buyboxes={data.buyboxes} onSave={save} onCancel={() => setEditing(null)} />}
      {shown.length === 0 && !editing && (
        <div style={{ border: `2px dashed ${C.line}`, borderRadius: 8, padding: 40, textAlign: "center", color: C.faint, fontSize: 14 }}>
          No leads here yet. Pull a list from the Find Deals tab, then add the owners you want to chase.
        </div>
      )}
      <div style={{ display: "grid", gap: 10 }}>
        {shown.map(l => (
          <div key={l.id} style={{ background: C.panel, border: `1px solid ${C.line}`, borderLeft: `5px solid ${STATUS_COLOR[l.status] || C.line}`, borderRadius: 8, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div style={{ minWidth: 220 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{l.owner || "Unknown owner"} {l.phone && <span className="lc-mono" style={{ fontSize: 12, color: C.blue }}> {l.phone}</span>}</div>
                <div className="lc-mono" style={{ fontSize: 12, color: C.faint }}>
                  {l.apn && `APN ${l.apn} · `}{l.county && `${l.county} Co · `}{l.zip && `${l.zip} · `}{l.acres && `${l.acres} ac · `}{l.price && `$${Number(l.price).toLocaleString()}`}
                </div>
                {(l.buybox || l.source) && <div style={{ fontSize: 12, color: C.green, fontWeight: 600 }}>{l.buybox && `For: ${l.buybox}`}{l.buybox && l.source ? "  ·  " : ""}{l.source && `Source: ${l.source}`}</div>}
                {l.notes && <div style={{ fontSize: 12.5, color: C.ink, marginTop: 3 }}>{l.notes}</div>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: STATUS_COLOR[l.status] }}>{l.status}</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Btn small kind="ghost" onClick={() => touch(l, "texted")}>✉ Texted{l.texted ? ` ${l.texted.slice(5)}` : ""}</Btn>
                  <Btn small kind="ghost" onClick={() => touch(l, "called")}>☎ Called{l.called ? ` ${l.called.slice(5)}` : ""}</Btn>
                  <Btn small kind="ghost" onClick={() => touch(l, "mailed")}>▣ Mailed{l.mailed ? ` ${l.mailed.slice(5)}` : ""}</Btn>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn small onClick={() => setScriptsFor(scriptsFor === l.id ? null : l.id)}>{scriptsFor === l.id ? "▾ Hide texts & mailers" : "✉ Texts & Mailers"}</Btn>
                  <Btn small kind="ghost" onClick={() => setEditing({ ...l })}>Edit</Btn>
                  <Btn small kind="danger" onClick={() => update({ ...data, leads: data.leads.filter(x => x.id !== l.id) })}>Delete</Btn>
                </div>
              </div>
            </div>
            {scriptsFor === l.id && <ScriptsPanel lead={l} data={data} update={update} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   App shell
   ============================================================ */
const TABS = [
  ["home", "Command"],
  ["scout", "Market Scout"],
  ["boxes", "Buy Boxes"],
  ["find", "Find Deals"],
  ["delinq", "Delinquency Hub"],
  ["match", "Match a Parcel"],
  ["pricing", "Pricing Calc"],
  ["calls", "Call Scripts"],
  ["pipeline", "Pipeline"],
];

export default function LandCommand() {
  const [tab, setTab] = useState("home");
  const [data, setData] = useState({ buyboxes: [], leads: [] });
  const [loaded, setLoaded] = useState(false);
  const [prefillBox, setPrefillBox] = useState(null); // handoff: Market Scout → Buy Boxes
  const [storageOk, setStorageOk] = useState(null);   // null=checking, true=auto-save on, false=unavailable
  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreText, setRestoreText] = useState("");
  const [backupMsg, setBackupMsg] = useState("");
  const [copiedBackup, setCopiedBackup] = useState(false);

  useEffect(() => {
    let live = true;
    loadData().then(d => { if (live) { setData(d); setLoaded(true); } });
    probeStorage().then(ok => { if (live) setStorageOk(ok); });
    return () => { live = false; };
  }, []);

  const update = (next) => {
    setData(next);
    saveData(next).then(ok => { if (!ok) setStorageOk(false); else if (storageOk === false) setStorageOk(true); });
  };

  const doRestore = () => {
    try {
      const parsed = JSON.parse(restoreText.trim());
      if (!parsed || typeof parsed !== "object" || (!Array.isArray(parsed.buyboxes) && !Array.isArray(parsed.leads))) {
        setBackupMsg("That doesn't look like a Land Command backup — paste the full text starting with { and ending with }.");
        return;
      }
      const restored = { buyboxes: parsed.buyboxes || [], leads: parsed.leads || [], settings: parsed.settings || {}, delinq: parsed.delinq || {} };
      update(restored);
      setRestoreText("");
      setBackupMsg(`Restored ✓ — ${restored.buyboxes.length} buy box(es), ${restored.leads.length} lead(s)`);
      setTimeout(() => setBackupMsg(""), 6000);
    } catch (e) {
      setBackupMsg("Couldn't read that backup — make sure you pasted the complete text.");
    }
  };

  return (
    <div className="lc-body" style={{ minHeight: "100vh", background: `${C.paper} radial-gradient(circle at 1px 1px, rgba(20,60,45,.05) 1px, transparent 0) 0 0 / 22px 22px`, color: C.ink }}>
      <style>{FONTS}{CC_CSS}</style>
      {/* Command header */}
      <div className="cc-header">
        <div className="cc-contour" />
        <div style={{ position: "relative", maxWidth: 1180, margin: "0 auto", padding: "14px 20px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span className="cc-dot" />
            <span className="lc-display" style={{ fontSize: 28, fontWeight: 800, color: "#EAF2EC", letterSpacing: ".1em", textTransform: "uppercase", lineHeight: 1 }}>
              Land<span style={{ color: CC.phosphor }}>Command</span>
            </span>
            <span className="lc-mono" style={{ fontSize: 10, color: CC.phosphorDim, letterSpacing: ".18em", textTransform: "uppercase", borderLeft: `1px solid ${CC.edge}`, paddingLeft: 12 }}>Land Acquisition Control</span>
            <span className="lc-mono" style={{ marginLeft: "auto", fontSize: 10.5, color: CC.stakeDim, letterSpacing: ".05em" }}>
              {data.buyboxes.length} BOX · {data.leads.length} LEAD
            </span>
            <span className="lc-mono" style={{ fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 3, letterSpacing: ".08em", background: storageOk === false ? "#3A2200" : "#0E2A1C", color: storageOk === false ? "#FFC966" : CC.phosphor, border: `1px solid ${storageOk === false ? "#6B4A12" : "#1C4A33"}` }}>
              {storageOk === false ? "⚠ SAVE OFF" : storageOk ? "● SAVE ON" : "…"}
            </span>
            <button type="button" onClick={() => setBackupOpen(!backupOpen)} className="cc-chip"
              style={{ background: backupOpen ? CC.signal : "transparent", color: backupOpen ? "#0A0F0D" : CC.stakeDim, borderColor: backupOpen ? CC.signal : CC.edge }}>
              ⛁ BACKUP
            </button>
          </div>
          <div style={{ display: "flex", gap: 3, marginTop: 12, flexWrap: "wrap" }}>
            {TABS.map(([id, label]) => (
              <button key={id} type="button" onClick={() => setTab(id)} className={"cc-tab lc-display" + (tab === id ? " cc-tab-on" : "")}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {/* Body */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "22px 20px 60px" }}>
        {!loaded ? <div style={{ color: C.faint, fontSize: 14 }}>Loading your saved buy boxes and leads…</div> : (
          <>
            {tab === "home" && (
              <CommandCenterTab data={data} onNavigate={setTab} storageOk={storageOk} onOpenBackup={() => setBackupOpen(true)} />
            )}
            {storageOk === false && !backupOpen && tab !== "home" && (
              <div style={{ background: C.amberPale, border: `1px solid ${C.amber}`, borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: C.ink, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span><strong>Heads up:</strong> auto-save isn't available in this environment, so your work lives only in this session. Use Backup before you leave — restoring takes 5 seconds.</span>
                <Btn small onClick={() => setBackupOpen(true)}>Open Backup</Btn>
              </div>
            )}
            {backupOpen && (
              <div style={{ background: C.panel, border: `2px solid ${C.orange}`, borderRadius: 8, padding: 16, marginBottom: 16 }}>
                <div className="lc-display" style={{ fontSize: 16, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>Backup & restore</div>
                <div style={{ fontSize: 12.5, color: C.faint, marginBottom: 12 }}>Your entire database — buy boxes, leads, settings, county research — as one block of text. Copy it somewhere safe (notes app, email to yourself). Paste it back anytime, in any session, to pick up exactly where you left off.</div>
                <div className="lc-label">1 · Backup — copy this</div>
                <textarea className="lc-input" rows={4} readOnly value={JSON.stringify(data)} onFocus={e => e.target.select()}
                  style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, resize: "vertical", marginBottom: 8 }} />
                <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
                  <Btn small onClick={async () => { await copyText(JSON.stringify(data)); setCopiedBackup(true); setTimeout(() => setCopiedBackup(false), 2000); }}>{copiedBackup ? "Copied ✓" : "Copy backup"}</Btn>
                </div>
                <div className="lc-label">2 · Restore — paste a backup here</div>
                <textarea className="lc-input" rows={4} value={restoreText} onChange={e => setRestoreText(e.target.value)} placeholder='Paste your saved backup text — starts with {"buyboxes":...'
                  style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, resize: "vertical", marginBottom: 8 }} />
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <Btn small onClick={doRestore}>Restore data</Btn>
                  {backupMsg && <span style={{ fontSize: 12.5, fontWeight: 700, color: backupMsg.includes("✓") ? C.green : C.red }}>{backupMsg}</span>}
                </div>
              </div>
            )}
            {tab === "scout" && <MarketScoutTab data={data} update={update} onCreateBox={(co, st) => { setPrefillBox({ counties: co, state: st }); setTab("boxes"); }} />}
            {tab === "boxes" && <BuyBoxesTab data={data} update={update} prefill={prefillBox} onPrefillConsumed={() => setPrefillBox(null)} />}
            {tab === "find" && <FindDealsTab data={data} />}
            {tab === "delinq" && <DelinquencyHubTab data={data} update={update} onGoImport={() => setTab("pipeline")} />}
            {tab === "match" && <MatchTab data={data} update={update} />}
            {tab === "pricing" && <PricingTab data={data} update={update} />}
            {tab === "calls" && <CallScriptsTab settings={data.settings || {}} />}
            {tab === "pipeline" && <PipelineTab data={data} update={update} />}
          </>
        )}
      </div>
    </div>
  );
}


/* ============================================================
   Shared helpers for outreach + scripts
   ============================================================ */
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch (e) {
    const ta = document.createElement("textarea");
    ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand("copy"); } catch (e2) {}
    document.body.removeChild(ta); return true;
  }
}

/* Fills [YOUR NAME]/[PHONE]/[EMAIL] tokens from settings — leaves brackets if not set */
function fillTokens(text, settings) {
  if (!text) return text;
  let t = text;
  if (settings.myName) t = t.split("[YOUR NAME]").join(settings.myName);
  if (settings.myPhone) t = t.split("[PHONE]").join(settings.myPhone);
  if (settings.myEmail) t = t.split("[EMAIL]").join(settings.myEmail);
  if (settings.myCompany) t = t.split("[COMPANY NAME]").join(settings.myCompany);
  return t;
}

/* ============================================================
   TEXTS & MAILERS — refined bonus campaign (per pipeline lead)
   Sequenced touches + response handling, auto-filled per lead
   ============================================================ */
function buildOutreach(lead, settings, box) {
  const first = (lead.owner || "").trim().split(/\s+/)[0] || "there";
  const me = settings.myName || "[YOUR NAME]";
  const myPhone = settings.myPhone || "[PHONE]";
  const acres = lead.acres ? `${lead.acres}-acre ` : "";
  const where = lead.address || (lead.county ? `in ${lead.county} County` : "in the area");
  const apn = lead.apn ? ` (parcel ${lead.apn})` : "";
  const offerT = parseFloat(lead.offer || lead.price);
  const hasOffer = !isNaN(offerT) && offerT > 0;
  const anchor = hasOffer ? Math.round(offerT * 0.85 / 100) * 100 : null;
  const fmt = (n) => "$" + Number(n).toLocaleString();
  const closeDays = box?.closeDays || "30";

  return [
    {
      title: "Text #1 — Opener (Day 1)",
      why: "Short, specific, and asks a yes/no identity question — the easiest possible reply. Naming the lot proves you're not a mass blast.",
      body: `Hi ${first}, this is ${me}. Are you the owner of the ${acres}vacant lot ${where}${apn}? I'm a local cash buyer and I'd like to make you an offer on it. No agents, no fees on your side.`,
    },
    {
      title: "Text #2 — Bump (Day 4)",
      why: "Assumes Text #1 got buried, not rejected. The 'even a no helps me close the file' line removes all pressure — and gets replies.",
      body: `Hi ${first}, ${me} again — just floating my message back up. I'm still interested in the ${acres}lot ${where}. Cash, I cover all closing costs, and we close in about ${closeDays} days. Even a quick "no thanks" helps me close the file. Any interest?`,
    },
    {
      title: "Response playbook — when they text back",
      why: "Text deals are won in the reply, not the opener. Match their energy: short answers, always end with a question or a next step.",
      body: `THEM: "How much?"\nYOU: ${hasOffer ? `"Based on recent lot sales nearby I'm around ${fmt(anchor)} cash, as-is, I pay all costs. Walk me through the lot — if access and utilities check out there may be some room. Got 5 minutes for a quick call?"` : `"I'd be guessing without confirming access and utilities — give me 5 minutes on a quick call and I'll give you a real number, not a lowball or a teaser. When's good?"`}\n\nTHEM: "Who is this? / How did you get my number?"\nYOU: "Totally fair question — I'm ${me}, a local land buyer. Your info comes up in county property records tied to the parcel. I only reach out when I'm genuinely interested in buying. Have you ever thought about selling it?"\n\nTHEM: "Not interested."\nYOU: "All good, ${first} — appreciate the straight answer. If anything changes or the taxes ever stop making sense, save my number: ${myPhone}. I'll be buying in the area for a long time."\n\nTHEM: "Make me an offer."\nYOU: ${hasOffer ? `"Happy to. I can do ${fmt(anchor)} cash as-is, all closing costs on me, close in ~${closeDays} days. If the lot checks out better than expected, there's room to talk. Want me to send a simple one-page agreement?"` : `"Will do — give me 24 hours to verify access and utilities so my number is real. What's the best way to send it, text or email?"`}\n\nTHEM: "It's worth way more than that."\nYOU: "On the open market with an agent, maybe — after commissions and months of waiting. What I'm offering is certainty: cash, no fees, ${closeDays}-day close. What number would actually move you?"`,
    },
    {
      title: "Mailer #1 — Postcard (Day 7)",
      why: "Hits the owners who don't text. The APN on the card is the credibility hook — it reads like real business, not junk mail.",
      body: `${first !== "there" ? first.toUpperCase() : "PROPERTY OWNER"} — I WANT TO BUY YOUR LAND${apn ? ` ${apn.trim()}` : ""}\n\nI'm a local buyer paying CASH for vacant land ${lead.county ? `in ${lead.county} County` : "in your area"}.\n\n✓ No realtor commissions\n✓ I pay ALL closing costs\n✓ Close in ~${closeDays} days — or on your timeline\n✓ Sell as-is: back taxes, liens, overgrowth — I handle it\n\nCall or text me directly: ${myPhone}\n${me}${settings.myCompany ? ` · ${settings.myCompany}` : ""}\n\n(Not interested? Toss this card — no hard feelings. But if that lot is just a tax bill you pay every year, let's talk.)`,
    },
    {
      title: `Mailer #2 — Offer letter (Day 21)${hasOffer ? "" : " — set 'Your offer' on the lead to auto-fill the numbers"}`,
      why: "A real number in writing. The range (anchor to target) leaves negotiating room while the certainty pitch does the selling.",
      body: `Dear ${lead.owner || "Property Owner"},\n\nMy name is ${me}${settings.myCompany ? ` with ${settings.myCompany}` : ""}. I'm writing about your ${acres}vacant land ${where}${apn}.\n\nI'd like to buy your property for cash. ${hasOffer ? `Based on recent sales of similar lots in the area, I'm prepared to offer in the range of ${fmt(anchor)} to ${fmt(offerT)}, depending on a quick review of access and utilities.` : `After a quick review of access and utilities, I can present you a firm cash number within 48 hours of hearing from you.`}\n\nWhat that means for you:\n• CASH — no financing contingencies, no waiting on a bank\n• I pay 100% of closing costs and there are zero commissions\n• We close through a licensed local title company in about ${closeDays} days\n• Completely as-is — overgrowth, back taxes, liens — I deal with all of it\n\nIf the timing isn't right, no problem — keep this letter. But if that land has become a line item you pay taxes on and never visit, call or text me at ${myPhone} and let's turn it into cash.\n\nRespectfully,\n${me}\n${settings.myCompany || ""}\n${myPhone}`,
    },
    {
      title: "Quarterly re-touch text (Day 90+)",
      why: "Land sellers convert on touch 4–7. This keeps you in their phone without being a pest — markets and circumstances change.",
      body: `Hi ${first}, ${me} here — I reached out a while back about your ${acres}lot ${where}. Still buying in the area and wanted to check in: any change of heart on selling? Happy to refresh my cash offer either way.`,
    },
  ];
}

function ScriptsPanel({ lead, data, update }) {
  const settings = data.settings || { myName: "", myPhone: "", myCompany: "", myEmail: "" };
  const [copied, setCopied] = useState(-1);
  const box = data.buyboxes.find(b => b.builder === lead.buybox);
  const sections = buildOutreach(lead, settings, box);
  const setS = (k) => (e) => update({ ...data, settings: { ...settings, [k]: e.target.value } });
  return (
    <div style={{ marginTop: 12, borderTop: `2px solid ${C.line}`, paddingTop: 12 }}>
      <div className="lc-label" style={{ marginBottom: 6 }}>Text & mailer campaign — auto-filled for this lead · for live calls use the Call Scripts tab</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12, background: C.amberPale, border: `1px solid ${C.amber}`, borderRadius: 6, padding: 10 }}>
        <Field label="Your name"><input className="lc-input" value={settings.myName || ""} onChange={setS("myName")} placeholder="Mike" /></Field>
        <Field label="Your phone"><input className="lc-input" value={settings.myPhone || ""} onChange={setS("myPhone")} placeholder="(727) 555-0100" /></Field>
        <Field label="Company"><input className="lc-input" value={settings.myCompany || ""} onChange={setS("myCompany")} placeholder="Arcadia Land Capital" /></Field>
        <Field label="Email"><input className="lc-input" value={settings.myEmail || ""} onChange={setS("myEmail")} placeholder="you@..." /></Field>
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {sections.map((s, i) => (
          <div key={i} style={{ background: "#FAFBF7", border: `1px solid ${C.line}`, borderRadius: 6, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 4 }}>
              <span className="lc-display" style={{ fontWeight: 800, fontSize: 13.5, textTransform: "uppercase", letterSpacing: ".05em" }}>{s.title}</span>
              <Btn small kind={copied === i ? "primary" : "ghost"} onClick={async () => { await copyText(s.body); setCopied(i); setTimeout(() => setCopied(-1), 1800); }}>
                {copied === i ? "Copied ✓" : "Copy"}
              </Btn>
            </div>
            <div style={{ fontSize: 11.5, color: C.green, fontWeight: 600, marginBottom: 8 }}>Why this works: {s.why}</div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13, lineHeight: 1.55, color: C.ink, fontFamily: "'Inter', system-ui, sans-serif" }}>{s.body}</pre>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: C.faint, marginTop: 8 }}>
        Heads-up: scrub phone lists against the Do Not Call registry and follow TCPA/state texting rules before mass outreach.
      </div>
    </div>
  );
}

/* ============================================================
   TAB — PRICING CALC (your original formula system)
   CMV → My Price → Investor Value → MAO → Gross/Net Spread
   ============================================================ */
function PricingTab({ data, update }) {
  const [cmv, setCmv] = useState("");
  const [acres, setAcres] = useState("");
  const [comps, setComps] = useState([{ price: "", acres: "" }, { price: "", acres: "" }, { price: "", acres: "" }]);
  const [myPct, setMyPct] = useState("35");
  const [invPct, setInvPct] = useState("65");
  const [fee, setFee] = useState("10000");
  const [closing, setClosing] = useState("1500");
  const [holding, setHolding] = useState("500");
  const [bufferPct, setBufferPct] = useState("10");
  const [savedMsg, setSavedMsg] = useState("");

  const n = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
  const fmt = (v) => isFinite(v) && !isNaN(v) ? "$" + Math.round(v).toLocaleString() : "—";
  const pct = (v) => n(cmv) > 0 ? ((v / n(cmv)) * 100).toFixed(1) + "% of CMV" : "";

  const setComp = (i, k, v) => setComps(comps.map((c, j) => j === i ? { ...c, [k]: v } : c));
  const validComps = comps.filter(c => n(c.price) > 0 && n(c.acres) > 0);
  const avgPPA = validComps.length ? validComps.reduce((s, c) => s + n(c.price) / n(c.acres), 0) / validComps.length : 0;
  const compCMV = avgPPA * n(acres);

  const CMV = n(cmv);
  const myPrice = CMV * n(myPct) / 100;
  const investorValue = CMV * n(invPct) / 100;
  const buffer = investorValue * n(bufferPct) / 100;
  const mao = investorValue - n(fee) - n(closing) - n(holding) - buffer;
  const gross = investorValue - myPrice;
  const net = gross - n(fee) - n(closing);
  const ready = CMV > 0;

  let grade = { label: "—", color: C.faint, bg: "#EEEFEA" };
  if (ready) {
    if (myPrice > mao) grade = { label: "OVER MAO — PASS", color: C.red, bg: C.redPale };
    else if (net >= 10000) grade = { label: "STRONG DEAL", color: C.green, bg: C.greenPale };
    else if (net > 0) grade = { label: "THIN DEAL — TIGHTEN IT", color: C.amber, bg: C.amberPale };
    else grade = { label: "NO SPREAD — PASS", color: C.red, bg: C.redPale };
  }

  const sendToPipeline = () => {
    const lead = {
      ...emptyLead(), acres, price: String(Math.round(investorValue)), offer: String(Math.round(myPrice)),
      source: "Pricing Calc",
      notes: `CMV ${fmt(CMV)} · My Price ${fmt(myPrice)} (${myPct}%) · Investor ${fmt(investorValue)} (${invPct}%) · MAO ${fmt(mao)} · Net spread ${fmt(net)}`,
    };
    update({ ...data, leads: [lead, ...data.leads] });
    setSavedMsg("Saved to Pipeline ✓ — open the lead and add owner/APN");
    setTimeout(() => setSavedMsg(""), 5000);
  };

  return (
    <div>
      <div className="lc-display" style={{ fontSize: 22, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em" }}>Pricing calculator</div>
      <div style={{ fontSize: 13, color: C.faint, marginBottom: 14 }}>Your repeatable valuation chain: CMV → My Price → Investor Value → MAO → spread. Run it on every lot before you name a number.</div>

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 18 }}>
        <SectionHead>Step 1 — Current market value (CMV)</SectionHead>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <Field label="CMV ($) — from comps, Zillow, or assessor"><input className="lc-input" type="number" value={cmv} onChange={e => setCmv(e.target.value)} placeholder="60000" /></Field>
          <Field label="Subject lot acres (for comps helper)"><input className="lc-input" type="number" value={acres} onChange={e => setAcres(e.target.value)} placeholder="0.25" /></Field>
        </div>
        <div style={{ marginTop: 12, background: "#FAFBF7", border: `1px dashed ${C.line}`, borderRadius: 6, padding: 12 }}>
          <div className="lc-label">Comps helper (optional) — sold lots, same zip, last 12 mo</div>
          <div style={{ display: "grid", gap: 8 }}>
            {comps.map((c, i) => {
              const ppa = n(c.price) > 0 && n(c.acres) > 0 ? n(c.price) / n(c.acres) : 0;
              return (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 110px", gap: 8, alignItems: "center" }}>
                  <input className="lc-input" type="number" placeholder={`Comp ${i + 1} sold price ($)`} value={c.price} onChange={e => setComp(i, "price", e.target.value)} />
                  <input className="lc-input" type="number" placeholder="Acres" value={c.acres} onChange={e => setComp(i, "acres", e.target.value)} />
                  <span className="lc-mono" style={{ fontSize: 12, color: ppa ? C.green : C.faint, fontWeight: 600 }}>{ppa ? `$${Math.round(ppa).toLocaleString()}/ac` : "—"}</span>
                </div>
              );
            })}
          </div>
          {compCMV > 0 && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
              <span className="lc-mono" style={{ fontSize: 13, fontWeight: 600 }}>Comp-based CMV: {fmt(compCMV)}</span>
              <Btn small onClick={() => setCmv(String(Math.round(compCMV)))}>Use as CMV →</Btn>
            </div>
          )}
        </div>

        <SectionHead>Step 2 — Your percentages</SectionHead>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <Field label="My Price % of CMV (offer to seller)"><input className="lc-input" type="number" value={myPct} onChange={e => setMyPct(e.target.value)} placeholder="35" /></Field>
          <Field label="Investor Buy % of CMV (builder pays)"><input className="lc-input" type="number" value={invPct} onChange={e => setInvPct(e.target.value)} placeholder="65" /></Field>
        </div>
        <div style={{ fontSize: 11.5, color: C.faint, marginTop: 8 }}>Your model: offer sellers 30–50% of CMV; builders/investors typically buy at 60–70%. Adjust per market heat.</div>

        <SectionHead>Step 3 — Costs & safety</SectionHead>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
          <Field label="Assignment fee target ($)"><input className="lc-input" type="number" value={fee} onChange={e => setFee(e.target.value)} /></Field>
          <Field label="Closing costs ($)"><input className="lc-input" type="number" value={closing} onChange={e => setClosing(e.target.value)} /></Field>
          <Field label="Holding costs ($)"><input className="lc-input" type="number" value={holding} onChange={e => setHolding(e.target.value)} /></Field>
          <Field label="Safety buffer (% of Investor Value)"><input className="lc-input" type="number" value={bufferPct} onChange={e => setBufferPct(e.target.value)} /></Field>
        </div>
      </div>

      {ready && (
        <div style={{ background: C.ink, borderRadius: 8, padding: 20, color: "#fff", marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
            <div className="lc-display" style={{ fontSize: 16, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: C.orange }}>Deal breakdown</div>
            <span className="lc-stamp" style={{ color: grade.color, fontSize: 14, background: grade.bg, borderRadius: 4 }}>{grade.label}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14 }}>
            <div><div className="lc-label" style={{ color: "#9DAB9F" }}>CMV</div><div className="lc-mono" style={{ fontSize: 22, fontWeight: 600 }}>{fmt(CMV)}</div></div>
            <div><div className="lc-label" style={{ color: "#9DAB9F" }}>My Price (offer seller)</div><div className="lc-mono" style={{ fontSize: 22, fontWeight: 600, color: C.orange }}>{fmt(myPrice)}</div><div style={{ fontSize: 10.5, color: "#9DAB9F" }}>{pct(myPrice)}</div></div>
            <div><div className="lc-label" style={{ color: "#9DAB9F" }}>Investor Value (builder pays)</div><div className="lc-mono" style={{ fontSize: 22, fontWeight: 600 }}>{fmt(investorValue)}</div><div style={{ fontSize: 10.5, color: "#9DAB9F" }}>{pct(investorValue)}</div></div>
            <div><div className="lc-label" style={{ color: "#9DAB9F" }}>MAO — never exceed</div><div className="lc-mono" style={{ fontSize: 22, fontWeight: 600, color: myPrice > mao ? "#E8A6A0" : "#7FD8A4" }}>{fmt(mao)}</div><div style={{ fontSize: 10.5, color: "#9DAB9F" }}>{pct(mao)}</div></div>
            <div><div className="lc-label" style={{ color: "#9DAB9F" }}>Gross spread</div><div className="lc-mono" style={{ fontSize: 22, fontWeight: 600 }}>{fmt(gross)}</div></div>
            <div><div className="lc-label" style={{ color: "#9DAB9F" }}>Net spread (take-home)</div><div className="lc-mono" style={{ fontSize: 22, fontWeight: 600, color: net >= 10000 ? "#7FD8A4" : net > 0 ? "#F2CD88" : "#E8A6A0" }}>{fmt(net)}</div></div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
            <Btn onClick={sendToPipeline}>+ Save deal to Pipeline</Btn>
            <Btn kind="ghost" onClick={async () => { await copyText(`CMV: ${fmt(CMV)}\nMy Price (${myPct}%): ${fmt(myPrice)}\nInvestor Value (${invPct}%): ${fmt(investorValue)}\nMAO: ${fmt(mao)}\nGross spread: ${fmt(gross)}\nNet spread: ${fmt(net)}\nGrade: ${grade.label}`); setSavedMsg("Breakdown copied ✓"); setTimeout(() => setSavedMsg(""), 2500); }}>Copy breakdown</Btn>
            {savedMsg && <span style={{ fontSize: 13, fontWeight: 700, color: "#7FD8A4" }}>{savedMsg}</span>}
          </div>
        </div>
      )}

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 16, marginTop: 14 }}>
        <div className="lc-label" style={{ marginBottom: 10 }}>Formula reference</div>
        {[
          ["My Price", "CMV × My Price %", "What you offer the motivated seller"],
          ["Investor Value", "CMV × Investor Buy %", "What your cash buyer / builder will pay"],
          ["MAO", "Investor Value − Assignment Fee − Closing − Holding − Buffer", "Your absolute ceiling — never exceed this"],
          ["Gross Spread", "Investor Value − My Price", "Potential profit before fees"],
          ["Net Spread", "Gross Spread − Assignment Fee − Closing Costs", "Your take-home on the deal"],
        ].map(([name, formula, desc]) => (
          <div key={name} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${C.line}` }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>{name}</span>
            <span className="lc-mono" style={{ fontSize: 12, color: C.green, margin: "0 8px" }}>{formula}</span>
            <span style={{ fontSize: 12, color: C.faint }}>{desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   CALL SCRIPTS — your original 4-script system (verbatim)
   Scripts 1 & 2 + 4 imported word-for-word from your files.
   Script 3 (Title) rebuilt from your original chat — proof it.
   ============================================================ */
const BUYER_SELLER_SCRIPTS = {
  builder: {
    id: "builder",
    label: "Script 1",
    title: "Builder & Contractor Outreach",
    goal: "Build the relationship. Learn their buy box.",
    accent: "#3b82f6",
    accentDim: "#1e3a5f",
    badge: "BUYER SIDE",
    badgeColor: "#3b82f6",
    steps: [
      {
        id: "gatekeeper",
        label: "Gatekeeper",
        icon: "🚪",
        intro: "You've called their office and someone other than the decision-maker picks up.",
        blocks: [
          {
            type: "say",
            label: "Say This",
            color: "#22c55e",
            bg: "#0f2a1a",
            text: `"Hi, this is [YOUR NAME]. I was hoping to reach [OWNER NAME] — is he or she available?"`,
          },
          {
            type: "tip",
            label: "Don't know the name?",
            color: "#a78bfa",
            bg: "#1a1030",
            text: `Ask: "Who would be the best person to speak with about land acquisitions or new build projects?"`,
          },
        ],
        rebuttals: [
          {
            them: `"What's this in regards to?"`,
            you: `"Sure — I source vacant land in specific markets and connect with builders before it ever hits the MLS. I just wanted to introduce myself to [OWNER NAME] and see if the timing makes sense."`,
          },
          {
            them: `"He/She isn't available right now."`,
            you: `"No problem. When is the best time to reach them directly? Is there a direct number or email I can use so I don't miss them?"`,
          },
          {
            them: `"Can I take a message?"`,
            you: `"Absolutely. [YOUR NAME], I'm calling about off-market land deals in their target markets. My number is [PHONE]. What's the best time for me to try back as well?"`,
          },
          {
            them: `"We're not interested."`,
            you: `"I understand — and I appreciate that. Just to confirm, is that something [OWNER NAME] would want to weigh in on themselves? We're talking off-market land — not a pitch, just a quick conversation."`,
          },
        ],
        comeback: [
          "Decision-maker's full name",
          "Direct number or email",
          "Best callback time",
          "Company name confirmed",
        ],
      },
      {
        id: "opener",
        label: "Opener",
        icon: "🎙",
        intro: "You've reached the builder, contractor, or owner directly — on their cell or transferred through.",
        blocks: [
          {
            type: "say",
            label: "Opening Line",
            color: "#22c55e",
            bg: "#0f2a1a",
            text: `"Hey [NAME], this is [YOUR NAME] — I'll keep it quick. I'm a land acquisitions specialist and I focus on sourcing off-market vacant lots in specific markets before they ever list publicly. I've been building relationships with builders in [AREA/MARKET] and wanted to connect with you directly to understand what you're looking for — so if the right lot comes across my desk, you're already the first call I make."`,
          },
          {
            type: "tip",
            label: "Tone Check",
            color: "#a78bfa",
            bg: "#1a1030",
            text: "You're positioning yourself as a resource, not a salesperson. You're building a pipeline for them. Confident, direct, peer-level.",
          },
        ],
        rebuttals: [
          {
            them: `"How'd you get my number?"`,
            you: `"Your number is registered to your business — I do my homework before I reach out. I only call people I think are worth talking to."`,
          },
          {
            them: `"We already have land sources."`,
            you: `"That's great — the best builders usually do. I'm not here to replace anything you've got. I'm just adding one more direct line to off-market lots. More options, zero obligation."`,
          },
        ],
        comeback: [],
      },
      {
        id: "buybox",
        label: "Buy Box Questions",
        icon: "📋",
        intro: "Once they're engaged, work through their buy box. This is the core of the call — take notes on everything.",
        blocks: [],
        questions: [
          { q: "What zip codes or cities are you actively looking to build in right now?", why: "This is your targeting list — where you'll go find land for them." },
          { q: "What's your ideal lot size — minimum and maximum square footage or acreage?", why: "Filters out every lot that won't work before you waste anyone's time." },
          { q: "Do you need the lot to be road-frontage accessible — and if so, what's your minimum frontage in feet?", why: "Critical for buildability — many rural lots lack proper access." },
          { q: "What utilities do you need on-site or nearby — water, sewer, electric, gas?", why: "Determines if a lot needs hookups or is shovel-ready." },
          { q: "What's your preference on topography — flat, slight slope, or does it matter?", why: "Slope affects foundation cost and buildability significantly." },
          { q: "Are you building single-family, multi-family, or mixed use?", why: "Shapes zoning requirements you'll need to look for." },
          { q: "What price range per lot are you working with?", why: "Tells you your ceiling when making offers to land sellers." },
          { q: "How quickly are you typically looking to break ground once you acquire a lot?", why: "Tells you their urgency — are they buying now or building a future pipeline?" },
          { q: "Do you prefer lots that are already zoned and permitted, or are you comfortable with the entitlement process?", why: "Some builders handle zoning themselves — others need turnkey." },
          { q: "Are you buying lots individually or are you open to bulk acquisitions?", why: "Opens the door to larger deals if you find a multi-lot opportunity." },
          { q: "Is there anything that's an automatic deal-killer for you — wetlands, easements, HOA restrictions?", why: "Saves you from bringing them a lot that wastes everyone's time." },
          { q: "What does your current acquisition pipeline look like — are you actively buying now?", why: "Gauges urgency and whether they're a hot buyer or just exploring." },
        ],
        rebuttals: [],
        comeback: [],
      },
      {
        id: "objections",
        label: "Objections",
        icon: "🥊",
        intro: "Common pushback from builders during or after the buy box conversation.",
        blocks: [],
        rebuttals: [
          {
            them: `"Send me something in writing and I'll look it over."`,
            you: `"Absolutely — I'll keep it to one page. Before I do, let me just confirm your buy box so what I send is specific to what you're actually looking for. What markets are top of mind right now?"`,
          },
          {
            them: `"We work exclusively through agents."`,
            you: `"That's totally fine — I can loop your agent in on anything that makes sense. This is really just about making sure you hear about the right lot before it gets listed. Your agent can handle the paperwork."`,
          },
          {
            them: `"We're not buying right now."`,
            you: `"Understood — this is a long-term relationship, not a one-call close. Even if it's 6 months out, I'd rather have your buy box now so I'm ready when you are. Takes two minutes."`,
          },
          {
            them: `"How do we know you can actually deliver?"`,
            you: `"Fair question. I don't promise lots I don't have — when I call you with something, it'll be because it actually fits what you told me. You can judge from there."`,
          },
          {
            them: `"What do you charge or make on these deals?"`,
            you: `"I buy the land and resell it to you — my margin is built into the acquisition side, not a fee on top of your deal. You pay one price, I handle everything else."`,
          },
        ],
        comeback: [],
      },
      {
        id: "close",
        label: "Close the Call",
        icon: "🤝",
        intro: "Lock in the relationship and set the next touchpoint before you hang up.",
        blocks: [
          {
            type: "say",
            label: "Closing Line",
            color: "#f59e0b",
            bg: "#1f1500",
            text: `"This is really helpful, [NAME]. I've got everything I need to start looking. Here's what I'll do — I'll reach out the moment something comes across my desk that fits what you described. In the meantime, let me send you a quick summary of what I'm sourcing so you have my contact info handy. Best email for you?"`,
          },
          {
            type: "say",
            label: "Confirm Everything",
            color: "#f59e0b",
            bg: "#1f1500",
            text: `"And just to confirm — best number to reach you directly is this one? And it's okay if I follow up in a few weeks even if I don't have something specific yet, just to stay on your radar?"`,
          },
        ],
        rebuttals: [
          {
            them: `"Just reach out when you have something."`,
            you: `"Will do. I may check in once in a while just to see if your criteria shifted — markets move fast and I want to make sure I'm chasing the right stuff for you. That okay?"`,
          },
        ],
        comeback: [
          "Buy box zip codes locked in",
          "Lot size range confirmed",
          "Utility / zoning requirements noted",
          "Price ceiling per lot",
          "Direct number + email captured",
          "Follow-up permission granted",
        ],
      },
      {
        id: "voicemail",
        label: "Voicemail",
        icon: "📱",
        intro: "If they don't pick up — leave a message that sounds like a peer with something real to offer.",
        blocks: [
          {
            type: "say",
            label: "Leave This",
            color: "#22c55e",
            bg: "#0f2a1a",
            text: `"Hey [NAME], this is [YOUR NAME]. I source off-market vacant land for builders in [MARKET] — I wanted to connect and learn what you're looking for so when the right lot comes in, you're the first call. Give me a ring when you get a chance — [PHONE]. Again, [YOUR NAME] at [PHONE]. Thanks."`,
          },
          {
            type: "tip",
            label: "Voicemail Rules",
            color: "#a78bfa",
            bg: "#1a1030",
            text: "Under 25 seconds. Say your number twice. Sound like someone with deals, not someone asking for favors.",
          },
        ],
        rebuttals: [],
        comeback: [],
      },
    ],
  },

  seller: {
    id: "seller",
    label: "Script 2",
    title: "Vacant Land Owner Outreach",
    goal: "Get the seller talking. Make a low cash offer they'll consider.",
    accent: "#f59e0b",
    accentDim: "#3d2500",
    badge: "SELLER SIDE",
    badgeColor: "#f59e0b",
    steps: [
      {
        id: "gatekeeper",
        label: "Gatekeeper",
        icon: "🚪",
        intro: "A family member, spouse, or property manager picks up instead of the owner.",
        blocks: [
          {
            type: "say",
            label: "Say This",
            color: "#22c55e",
            bg: "#0f2a1a",
            text: `"Hi there, is [OWNER NAME] available? My name is [YOUR NAME] and I'm calling about the property they own on [ROAD / PARCEL AREA]."`,
          },
          {
            type: "tip",
            label: "Know your data",
            color: "#a78bfa",
            bg: "#1a1030",
            text: "Always pull the owner's name and general property location from county records before dialing. It builds instant credibility.",
          },
        ],
        rebuttals: [
          {
            them: `"What's this about?"`,
            you: `"I'm a local land buyer and I came across a vacant lot they own in [GENERAL AREA]. I wanted to reach out directly to see if they'd ever considered selling — completely their call, just wanted to make the offer."`,
          },
          {
            them: `"They're not interested in selling."`,
            you: `"I totally understand. Would it be okay if I spoke with them just for a moment? Sometimes it makes sense when they hear the offer — and if it doesn't, no harm done."`,
          },
          {
            them: `"How did you get this number?"`,
            you: `"The number came up through public property records associated with the parcel. I always try to reach owners directly rather than going through other channels."`,
          },
          {
            them: `"Can you call back?"`,
            you: `"Of course — what time works best? And is this the best number, or do you have a direct line for [OWNER NAME]?"`,
          },
        ],
        comeback: [
          "Owner's name confirmed",
          "Best time to call back",
          "Direct number if different",
          "Any info on their situation (moving, estate, etc.)",
        ],
      },
      {
        id: "opener",
        label: "Opener",
        icon: "🎙",
        intro: "The owner picks up. Lead with who you are, why you're calling, and that this is quick — most land owners are not expecting your call.",
        blocks: [
          {
            type: "say",
            label: "Opening Line",
            color: "#22c55e",
            bg: "#0f2a1a",
            text: `"Hi, is this [OWNER NAME]? Great — my name is [YOUR NAME]. I'll keep this quick. I'm a local land buyer and I came across the vacant lot you own over on [ROAD / GENERAL AREA]. I'm actively looking to purchase land in that area for cash and wanted to reach out directly to see if you'd ever thought about selling."`,
          },
          {
            type: "tip",
            label: "Tone Check",
            color: "#a78bfa",
            bg: "#1a1030",
            text: "Calm, unhurried, respectful. You're not pressuring them — you're presenting an option. Many land owners have forgotten they even own it or are paying taxes on something they don't use.",
          },
          {
            type: "say",
            label: "If They Say 'Maybe' or Pause",
            color: "#3b82f6",
            bg: "#0f1e30",
            text: `"I completely understand if it's not something you've thought about — I just wanted to make a direct offer rather than go through a whole listing process. Do you mind if I ask you a couple of quick questions about the property?"`,
          },
        ],
        rebuttals: [
          {
            them: `"How do you know I own land there?"`,
            you: `"County property records are public — I do research on parcels in specific areas before I reach out. I only call owners directly when I'm genuinely interested in making an offer."`,
          },
          {
            them: `"I wasn't planning on selling."`,
            you: `"That's completely fair — most people I call weren't planning on it. But sometimes the offer makes sense, especially when it's cash, no listing, no commissions, and a fast close. Would you be open to just hearing a number?"`,
          },
        ],
        comeback: [],
      },
      {
        id: "qualify",
        label: "Qualifying Questions",
        icon: "📋",
        intro: "Before you make any offer, you need to understand the property and the seller's situation. Ask naturally — like a conversation, not a form.",
        blocks: [],
        questions: [
          { q: "How long have you owned the property?", why: "Long-term owners have less emotional attachment and often more motivation to simplify." },
          { q: "Are you currently using the land for anything, or is it just sitting?", why: "If it's idle, they're paying taxes for nothing — that's leverage for your offer." },
          { q: "Do you know roughly what the lot size is?", why: "Confirms what you pulled from records and shows you've done homework." },
          { q: "Is there any road access to the property — does it front a road?", why: "Impacts your ability to resell and affects your offer price." },
          { q: "Do you know if it has any utilities — water, sewer, electric nearby?", why: "Same — affects value and your buyer's interest." },
          { q: "Have you had the land appraised or looked at its value recently?", why: "Tells you their anchor — important before you name a number." },
          { q: "Are there any liens, back taxes, or legal issues on the property you're aware of?", why: "Critical to know before making any offer." },
          { q: "Is there anyone else on the deed — a spouse, family member, or partner?", why: "You need all decision-makers in agreement before moving forward." },
          { q: "What would make this a no-brainer for you — is it purely the price, or is timeline important too?", why: "Reveals their real motivation. Some need speed; others need a number." },
        ],
        rebuttals: [],
        comeback: [],
      },
      {
        id: "offer",
        label: "Making the Offer",
        icon: "💵",
        intro: "You've qualified the property. Now it's time to present the cash offer — confidently and without over-explaining.",
        blocks: [
          {
            type: "say",
            label: "Set Up the Offer",
            color: "#f59e0b",
            bg: "#1f1500",
            text: `"Based on everything you've shared and what I know about the area, I'd like to make you a straightforward cash offer. I want to be upfront with you — my offer is going to come in below what you might see listed on the market, because I'm buying direct, paying cash, and we can close fast without any agents, fees, or months of waiting. What that means for you is a guaranteed sale, no surprises, and money in your account quickly."`,
          },
          {
            type: "say",
            label: "Name the Number",
            color: "#f59e0b",
            bg: "#1f1500",
            text: `"With that said — I'd like to offer you $[YOUR OFFER] for the property as-is. I can have a simple purchase agreement over to you within 24 hours, and we can close in as little as [X] days."`,
          },
          {
            type: "tip",
            label: "After You Say the Number",
            color: "#ef4444",
            bg: "#2a0f0f",
            text: "STOP TALKING. Let them respond. Silence after the offer is normal. The first person to speak after the number loses leverage.",
          },
        ],
        rebuttals: [
          {
            them: `"That's way too low."`,
            you: `"I hear you — and I respect that. Can I ask, what number would feel fair to you? I want to see if there's a way to make this work for both of us."`,
          },
          {
            them: `"I need to think about it."`,
            you: `"Absolutely — take your time. This isn't a pressure situation. Can I follow up with you on [SPECIFIC DAY]? And is it okay if I send over a simple one-page summary of the offer so you have it in writing to look over?"`,
          },
          {
            them: `"I think it's worth more than that."`,
            you: `"It may very well be on the open market — and if you listed it with an agent, you might get closer to that number eventually. What I'm offering is certainty: cash, fast, no fees, no waiting. Sometimes that's worth the difference. Does the speed and simplicity have any value to you?"`,
          },
          {
            them: `"I want to talk to a real estate agent first."`,
            you: `"That's totally reasonable — I'd encourage that. Just keep in mind that an agent will list it, take a commission, and it could sit for months depending on the market. If after talking to them you want a guaranteed buyer on standby, I'm here."`,
          },
          {
            them: `"Why is the offer so low?"`,
            you: `"Great question. I buy, hold risk, and resell — I'm not retail. My profit is built into the spread, which is how I can move fast and close without financing contingencies. It's a different model than listing on the MLS, but for a lot of sellers, the certainty and speed is worth it."`,
          },
          {
            them: `"Can you go higher?"`,
            you: `"Depending on what I find in due diligence, there may be a little room. Can you help me understand what number would get you to yes? I want to be realistic with you — I just need to make sure the numbers work on my end too."`,
          },
        ],
        comeback: [],
      },
      {
        id: "close",
        label: "Close the Call",
        icon: "🤝",
        intro: "Whether they say yes, maybe, or need time — always leave with a clear next step.",
        blocks: [
          {
            type: "say",
            label: "If They're Open to It",
            color: "#22c55e",
            bg: "#0f2a1a",
            text: `"Wonderful. Here's what I'll do — I'll send you a simple one-page purchase agreement to look over. No pressure to sign right away. Just take a look and let me know if you have any questions. What's the best email or mailing address for you?"`,
          },
          {
            type: "say",
            label: "If They Need Time",
            color: "#3b82f6",
            bg: "#0f1e30",
            text: `"Completely understand. I'll follow up on [DAY] — is a call or a text better for you? And in the meantime, I'll send that one-pager so you have everything in writing."`,
          },
          {
            type: "tip",
            label: "Never Leave Without a Next Step",
            color: "#ef4444",
            bg: "#2a0f0f",
            text: "Every call ends with either a signed agreement, a scheduled follow-up call, or a written offer sent. Never just 'I'll be in touch.' Pin the day.",
          },
        ],
        rebuttals: [
          {
            them: `"Don't bother sending anything."`,
            you: `"Understood. Would it be okay if I just checked back in with you in a few weeks? Sometimes things change and I'd hate for you to not have a buyer when you're ready."`,
          },
        ],
        comeback: [
          "Owner's decision and interest level noted",
          "Any counter-number they gave",
          "All decision-makers identified",
          "Liens / title issues flagged",
          "Follow-up date locked in",
          "Email or address for written offer",
        ],
      },
      {
        id: "voicemail",
        label: "Voicemail",
        icon: "📱",
        intro: "Many land owners won't pick up the first time. Leave a message that's personal and curious — not a robo-pitch.",
        blocks: [
          {
            type: "say",
            label: "Leave This",
            color: "#22c55e",
            bg: "#0f2a1a",
            text: `"Hi [OWNER NAME], my name is [YOUR NAME]. I'm a local land buyer and I came across the property you own over on [ROAD / AREA]. I'd love to have a quick conversation — I may have an offer for you. Give me a call when you get a chance at [PHONE]. Again, that's [YOUR NAME] at [PHONE]. Thank you."`,
          },
          {
            type: "tip",
            label: "Voicemail Rules",
            color: "#a78bfa",
            bg: "#1a1030",
            text: "Use their name. Reference the specific property — it proves you're not random. Say your number twice. Under 25 seconds.",
          },
        ],
        rebuttals: [],
        comeback: [],
      },
    ],
  },
};

const ATTORNEY_SCRIPT = {
  id: "attorney",
  label: "Script 4",
  title: "Real Estate Attorney Outreach",
  goal: "Find a state-licensed real estate attorney to draft your land purchase & sale agreement, assignment of contract, and double close agreement — once per state.",
  accent: "#e879f9",
  badge: "LEGAL SIDE",
  steps: [
    {
      id: "gatekeeper",
      label: "Gatekeeper",
      icon: "🚪",
      intro: "Law offices almost always have a receptionist or legal assistant screening calls. Your goal is to get to the attorney directly, or schedule a consultation. You are a potential paying client — carry yourself accordingly.",
      blocks: [
        {
          type: "say",
          label: "Opening Line",
          color: "#22c55e",
          bg: "#0f2a1a",
          text: `"Hi, my name is [YOUR NAME]. I'm a real estate investor and I'm looking to speak with one of your real estate attorneys about drafting some transaction documents specific to [STATE]. Is there someone I can speak with, or would I need to schedule a consultation?"`,
        },
        {
          type: "tip",
          label: "Who You're Looking For",
          color: "#a78bfa",
          bg: "#1a1030",
          text: "You want an attorney who specifically handles real estate transactions — not general practice. If the firm does multiple areas of law, ask specifically for their real estate transactional attorney, not a litigator.",
        },
      ],
      rebuttals: [
        {
          them: `"What kind of documents are you looking for?"`,
          you: `"I need a land purchase and sale agreement, an assignment of contract, and a double close agreement — all drafted for [STATE] specifically. I wholesale vacant land and I want to make sure my contracts are legally sound in every state I operate in."`,
        },
        {
          them: `"You'll need to schedule a paid consultation first."`,
          you: `"Completely understand — I'm happy to do that. What does that look like, and how long is a typical consultation? I want to make sure we cover everything in one sitting."`,
        },
        {
          them: `"We don't handle that type of work."`,
          you: `"No problem at all — do you happen to know of a firm in [STATE/AREA] that specializes in real estate transactions? I want to make sure I'm working with someone who knows the state-specific requirements."`,
        },
        {
          them: `"Can I take your information?"`,
          you: `"Of course — [YOUR NAME], [PHONE], [EMAIL]. And could I get the attorney's name and a direct line or email so I can follow up if I don't hear back within a day or two?"`,
        },
      ],
      comeback: [
        "Attorney's name confirmed",
        "Direct number or email",
        "Consultation cost and length",
        "Confirmation they handle real estate transactions in that state",
      ],
    },
    {
      id: "opener",
      label: "Opener",
      icon: "🎙",
      intro: "You've reached the attorney directly or been transferred through. Lead with clarity — you know what you need, you're a paying client, and this is a one-time engagement per state with potential for repeat work as you expand.",
      blocks: [
        {
          type: "say",
          label: "Opening Line",
          color: "#22c55e",
          bg: "#0f2a1a",
          text: `"Hi [ATTORNEY NAME], my name is [YOUR NAME]. I'm a land wholesaler — I buy vacant lots off-market and resell them to builders and developers. I'm actively working deals in [STATE] and I need to make sure I have legally sound contracts specific to your state laws before I close my first transaction here. I'm looking to hire an attorney to draft those documents for me, and I want to do it right the first time."`,
        },
        {
          type: "tip",
          label: "Why This Framing Works",
          color: "#a78bfa",
          bg: "#1a1030",
          text: "Attorneys respect clients who know what they want and come prepared. You're not asking vague questions — you're telling them exactly what you need and signaling that you're a serious, paying client. Mention future states casually — it signals recurring business.",
        },
        {
          type: "say",
          label: "Transition",
          color: "#3b82f6",
          bg: "#0f1e30",
          text: `"I have a few questions to make sure you're the right fit — and then I'd like to talk about moving forward. Do you have a few minutes?"`,
        },
      ],
      rebuttals: [
        {
          them: `"What exactly is wholesaling?"`,
          you: `"Sure — I get a vacant lot under contract with the seller, then either assign that contract to my end buyer, or do a double close where I buy and resell on the same day. I need contracts that cover both structures and hold up in [STATE]."`,
        },
        {
          them: `"I'm not familiar with assignment of contract in this context."`,
          you: `"That's actually one of the reasons I want an attorney involved — I want to make sure the language is airtight for this state. It's a fairly straightforward real estate assignment, but state laws vary and I don't want to assume anything."`,
        },
      ],
      comeback: [],
    },
    {
      id: "questions",
      label: "Key Questions",
      icon: "📋",
      intro: "Before you commit to hiring them, qualify the attorney. Not every real estate attorney handles transactional investor work — some only do closings, litigation, or residential. These questions tell you fast if they're the right fit.",
      blocks: [],
      questions: [
        { q: "Do you handle real estate transactional work for investors specifically, or is your practice focused more on closings and litigation?", why: "You need a transactional attorney, not someone who only handles disputes or title issues." },
        { q: "Are you licensed and practicing in [STATE]?", why: "Contracts must be drafted by an attorney licensed in the state where the transaction occurs." },
        { q: "Have you drafted purchase and sale agreements for vacant land transactions before?", why: "Land contracts differ from residential — you want someone with direct experience." },
        { q: "Are you familiar with assignment of contract structures used in wholesaling?", why: "Some attorneys aren't investor-friendly — better to know now than after you've paid a retainer." },
        { q: "Have you handled double close or simultaneous closing agreements?", why: "This is the more complex structure — you need to know if they've done it before." },
        { q: "Are there any legal restrictions in [STATE] that would affect wholesaling, assignments, or double closes I should know about?", why: "Some states have restrictions on contract assignments or require a license — your attorney should know this cold." },
        { q: "Would you be drafting these from scratch or working from templates you've used before?", why: "From scratch takes longer and costs more — templates they've used before are already tested and cheaper to customize." },
        { q: "What's your typical turnaround time once I provide the deal details and we agree to move forward?", why: "You may need contracts fast — you need to know their bandwidth." },
      ],
      rebuttals: [],
      comeback: [],
    },
    {
      id: "scope",
      label: "Scope of Work",
      icon: "📝",
      intro: "Once you've confirmed they're the right fit, clearly define the three documents you need. Be specific — vague asks lead to vague deliverables and scope creep on the bill.",
      blocks: [
        {
          type: "say",
          label: "Define What You Need",
          color: "#e879f9",
          bg: "#1a0a1f",
          text: `"Here's exactly what I'm looking to have drafted. I need three documents, all specific to [STATE] law:\n\nOne — a Vacant Land Purchase and Sale Agreement to use when I'm buying from a seller. It needs to cover purchase price, earnest money, inspection period, closing timeline, contingencies, and an assignability clause.\n\nTwo — an Assignment of Contract agreement so I can assign my buyer position to my end buyer in lieu of a double close when that structure makes more sense.\n\nThree — a Double Close or Back-to-Back Closing agreement that covers both Transaction A and Transaction B — the buy and the resell — and is structured so my profit stays protected.\n\nI want all three to be clean, plain-language, and something I can use repeatedly without having to call an attorney every time I have a deal."`,
        },
        {
          type: "tip",
          label: "Assignability Clause — Make Sure It's In There",
          color: "#ef4444",
          bg: "#2a0f0f",
          text: `Your Purchase & Sale Agreement MUST include language that makes the contract assignable — something like "and/or assigns" after your name as the buyer. Without this, you can't legally assign the contract to your end buyer. Make sure your attorney knows this is non-negotiable.`,
        },
        {
          type: "tip",
          label: "Plain Language Matters",
          color: "#f59e0b",
          bg: "#1f1500",
          text: "Ask for plain language — not legalese. You'll be presenting these to land owners who are regular people, not attorneys. A clean, readable contract builds trust and speeds up the signing process.",
        },
      ],
      rebuttals: [
        {
          them: `"I'd need to review the details before I can draft anything."`,
          you: `"Completely understood — I'm not asking you to start today. I just want to confirm the scope so you can give me a quote and we can agree on the engagement. Once we're aligned on cost and timeline, I'll get you everything you need."`,
        },
        {
          them: `"We don't typically draft assignment agreements for wholesalers."`,
          you: `"I understand that's not always common. To be clear — this isn't an agreement to help me avoid licensing requirements. This is a standard real estate assignment of contract used in a lawful transaction. I'm happy to walk through the specifics if it helps clarify."`,
        },
        {
          them: `"You could probably find templates online."`,
          you: `"I've seen those — and I'd rather pay for something that's been reviewed by an attorney who knows [STATE] law specifically. Generic templates have gaps, and one bad contract could cost me far more than your fee. I want to do this right."`,
        },
      ],
      comeback: [],
    },
    {
      id: "fees",
      label: "Fees & Process",
      icon: "💰",
      intro: "Get a clear picture of what this engagement will cost and how the process works before you commit.",
      blocks: [
        {
          type: "say",
          label: "Ask About Fees",
          color: "#f59e0b",
          bg: "#1f1500",
          text: `"Before we go further — can you give me a sense of what drafting these three documents would typically cost? And do you charge a flat fee for this type of work, or is it billed hourly?"`,
        },
      ],
      questions: [
        { q: "Do you charge a flat fee or hourly for contract drafting?", why: "Flat fee = predictable cost. Hourly = open-ended bill. Always prefer flat fee for defined scope work." },
        { q: "Is there a separate consultation fee, and does it apply toward the drafting cost if I move forward?", why: "Some attorneys credit the consult fee — others don't. Know before you agree to a paid consult." },
        { q: "What information do you need from me to get started once we agree to move forward?", why: "Be ready to provide it fast — delays on your end extend the timeline." },
        { q: "Will I have the opportunity to review and request revisions before the documents are finalized?", why: "You want at least one round of revisions included — don't assume it is." },
        { q: "Once these are drafted, can I use them for multiple transactions, or do they need to be updated per deal?", why: "You want reusable templates — not something you pay to redraft every closing." },
        { q: "If I expand into other states down the road, would you be able to adapt these for those states or refer me to someone who can?", why: "Plants the seed for a long-term relationship and recurring business across your expansion markets." },
      ],
      rebuttals: [
        {
          them: `"Our rates are [HIGH NUMBER] per hour."`,
          you: `"I appreciate the transparency. Is there any flexibility on a flat fee for a defined scope like this — three documents, one round of revisions? I'd rather agree on a number upfront than have an open invoice."`,
        },
        {
          them: `"I'd need a retainer before we begin."`,
          you: `"Understood — what does that retainer look like, and how is it applied toward the total cost?"`,
        },
        {
          them: `"This might take a few weeks."`,
          you: `"I can work with that. Is there anything I can provide upfront to help move it along faster once we agree to engage?"`,
        },
      ],
      comeback: [
        "Attorney name, direct number, and email confirmed",
        "Licensed in target state confirmed",
        "Familiar with assignments and double closes — confirmed",
        "Flat fee or hourly rate noted",
        "Retainer requirement noted",
        "Turnaround timeline noted",
        "Revision policy confirmed",
        "Next step agreed upon — consult scheduled or quote incoming",
      ],
    },
    {
      id: "close",
      label: "Close the Call",
      icon: "🤝",
      intro: "You've qualified them and discussed scope. End the call with a clear next step — either a scheduled consultation or a written quote.",
      blocks: [
        {
          type: "say",
          label: "If You're Ready to Move Forward",
          color: "#22c55e",
          bg: "#0f2a1a",
          text: `"This sounds like a great fit. Here's what I'd like to do — let's schedule a formal consultation so I can walk you through the exact deal structure I use and you can ask any questions before you start drafting. What does your availability look like this week or next?"`,
        },
        {
          type: "say",
          label: "If You Need a Quote First",
          color: "#3b82f6",
          bg: "#0f1e30",
          text: `"Before I commit, would you be able to put together a flat fee quote for the three documents based on what we discussed? I want to move quickly but I'd like to see a number in writing first. Can you email that to me at [EMAIL]?"`,
        },
        {
          type: "say",
          label: "Either Way — Confirm the Relationship",
          color: "#e879f9",
          bg: "#1a0a1f",
          text: `"I'll also say — I plan to expand into additional states as my business grows. If this first engagement goes well, you'd be my first call every time I enter a new market. I'd rather build a long-term relationship with one attorney I trust than shop around every time."`,
        },
        {
          type: "tip",
          label: "After the Call",
          color: "#f59e0b",
          bg: "#1f1500",
          text: "Send a follow-up email the same day summarizing: your name, your business model in 2 sentences, the three documents you need, the state, and your timeline. This gives them everything in writing and makes it easy for them to quote you accurately.",
        },
      ],
      rebuttals: [
        {
          them: `"I'll have my assistant follow up with you."`,
          you: `"Perfect — just to make sure nothing slips through, can you confirm my email is [EMAIL]? And roughly when should I expect to hear back?"`,
        },
        {
          them: `"We're pretty backed up right now."`,
          you: `"Understood. Would you be able to give me a realistic timeline so I can plan around it? And if it's going to be more than two weeks, is there someone else at the firm who might be able to start sooner?"`,
        },
      ],
      comeback: [],
    },
    {
      id: "voicemail",
      label: "Voicemail",
      icon: "📱",
      intro: "Law offices screen calls carefully. Leave something that immediately signals you're a paying client with a specific, defined need.",
      blocks: [
        {
          type: "say",
          label: "Leave This",
          color: "#22c55e",
          bg: "#0f2a1a",
          text: `"Hi, this message is for [ATTORNEY NAME] — my name is [YOUR NAME]. I'm a real estate investor wholesaling vacant land in [STATE] and I'm looking to hire an attorney to draft three transaction documents specific to your state: a purchase and sale agreement, an assignment of contract, and a double close agreement. I'd like to schedule a consultation at your earliest convenience. You can reach me at [PHONE]. Again, [YOUR NAME] at [PHONE]. Thank you."`,
        },
        {
          type: "tip",
          label: "Voicemail Rules",
          color: "#a78bfa",
          bg: "#1a1030",
          text: "Name the three documents specifically — it proves you know what you need and aren't fishing for free legal advice. Say your number twice. Under 30 seconds.",
        },
      ],
      rebuttals: [],
      comeback: [],
    },
  ],
};

/* Script 3 — Title Company Outreach (rebuilt from your original chat) */
const TITLE_SCRIPT = {
  id: "title",
  label: "Script 3",
  title: "Title Company Outreach",
  goal: "Introduce yourself, find your go-to contact, confirm they handle land & double closes, and lock in fees and timelines.",
  accent: "#10b981",
  accentDim: "#0a2a1f",
  badge: "TITLE SIDE",
  badgeColor: "#10b981",
  steps: [
    {
      id: "gatekeeper",
      label: "Gatekeeper",
      icon: "🚪",
      intro: "Most title companies have a receptionist or front desk who answers first. Your goal is to get to a closer, escrow officer, or the branch manager — whoever handles land transactions.",
      blocks: [
        {
          type: "say",
          label: "Opening Line",
          color: "#22c55e",
          bg: "#0f2a1a",
          text: `"Hi, my name is [YOUR NAME]. I'm a land investor and I'm looking to connect with whoever handles your land or vacant lot closings — is that someone I can speak with today?"`,
        },
        {
          type: "tip",
          label: "Who You're Looking For",
          color: "#a78bfa",
          bg: "#1a1030",
          text: "You want: a Closing Officer, Escrow Officer, Title Officer, or the Branch Manager. Any of these can become your go-to contact. Avoid getting routed to a generic 'sales' line.",
        },
      ],
      rebuttals: [
        {
          them: `"What is this regarding?"`,
          you: `"Sure — I'm a land investor closing deals in this area and I want to establish a relationship with a title company I can bring my transactions to consistently. I just want to make sure you're set up to handle vacant land and talk through the process."`,
        },
        {
          them: `"Can I take your information and have someone call you back?"`,
          you: `"Absolutely. [YOUR NAME], [PHONE]. I'd also love to know — who specifically would be reaching out? I'd like to have a name so I know who to expect."`,
        },
        {
          them: `"We're pretty busy right now."`,
          you: `"No problem at all. Is there a better time today or tomorrow to catch someone for just 5 minutes? I close multiple deals and I'm looking for a title company to build a long-term relationship with."`,
        },
      ],
      comeback: [
        "Name of closer or escrow officer",
        "Direct number or extension",
        "Email address",
        "Best time to reach them",
      ],
    },
    {
      id: "opener",
      label: "Opener",
      icon: "🎙",
      intro: "You've reached a closer, escrow officer, or branch manager. Lead with who you are and why consistent business from you is worth 5 minutes of their time.",
      blocks: [
        {
          type: "say",
          label: "Opening Line",
          color: "#22c55e",
          bg: "#0f2a1a",
          text: `"Hi [NAME], my name is [YOUR NAME] — I'm a land investor based in [AREA] and I'm actively buying and selling vacant lots in [MARKET/COUNTY]. I'm reaching out because I want to find one title company I can bring all of my transactions to consistently, and I wanted to have a quick conversation to make sure we're a good fit for each other."`,
        },
        {
          type: "tip",
          label: "Why This Framing Works",
          color: "#a78bfa",
          bg: "#1a1030",
          text: "You're not asking for a favor — you're offering recurring business. Title companies love investors who close multiple deals. Position yourself as a volume client from the start, even if you're just getting going.",
        },
        {
          type: "say",
          label: "Transition Into Questions",
          color: "#3b82f6",
          bg: "#0f1e30",
          text: `"I just have a few quick questions to make sure your office handles the type of deals I do — do you have 5 minutes?"`,
        },
      ],
      rebuttals: [
        {
          them: `"We mostly handle residential — not sure about vacant land."`,
          you: `"That's actually exactly why I'm asking — vacant land closings are a little different and I want to make sure I'm working with someone who's comfortable with them. Do you handle any land transactions currently, or is it mostly improved properties?"`,
        },
        {
          them: `"What kind of volume are you doing?"`,
          you: `"I'm building my pipeline right now — my goal is to close [X] transactions in this market over the next 12 months. I'd rather grow with one reliable title company than shop around every deal."`,
        },
      ],
      comeback: [],
    },
    {
      id: "questions",
      label: "Key Questions",
      icon: "📋",
      intro: "Work through these to qualify the title company and show you know what you're doing. These also double as the information you need to actually run your business.",
      blocks: [],
      questions: [
        { q: "Do you handle vacant land and lot closings regularly?", why: "Some title companies rarely touch land — you need one that's comfortable with it." },
        { q: "Are you able to handle double closings or simultaneous closings?", why: "Critical for your business model — you're buying from the land owner and selling to the builder, sometimes on the same day." },
        { q: "Do you require seasoning on the title, or can you close back-to-back transactions on the same parcel?", why: "Some title companies have seasoning requirements that could block a same-day double close." },
        { q: "What does your title search process look like for vacant land — how far back do you search and how long does it take?", why: "Land titles can have old liens, easements, or heirship issues. You need to know their process and timeline." },
        { q: "Can you run a preliminary title search before I'm fully under contract — and is there a cost for that?", why: "A prelim search helps you spot problems before you're locked in with a seller." },
        { q: "What are your typical closing fees for a vacant land transaction?", why: "You need to factor this into your deal math — both on the buy and sell side." },
        { q: "Do you handle both sides of the transaction, or do the buyer and seller each need their own title company?", why: "In a double close you may need them to handle both sides — not all companies do this." },
        { q: "What's your typical turnaround time from opening escrow to clear-to-close on a land deal?", why: "Builders and sellers both have timelines — you need to know how fast you can move." },
        { q: "Do you work with cash buyers and sellers who don't have an agent involved?", why: "Most of your deals will be agent-free — you want to confirm they're comfortable with that." },
        { q: "Is there a specific closer or escrow officer I should always ask for when I bring a deal in?", why: "Builds your direct relationship — you want one person who knows your name and how you work." },
      ],
      rebuttals: [],
      comeback: [],
    },
    {
      id: "doubleclose",
      label: "Double Close Deep Dive",
      icon: "🔁",
      intro: "If they confirmed they handle double closings, go deeper. This is one of the most important parts of your business model and you need to know exactly how they handle it.",
      blocks: [
        {
          type: "tip",
          label: "What a Double Close Is",
          color: "#a78bfa",
          bg: "#1a1030",
          text: "You buy the land from the seller (Transaction A), then immediately resell it to the builder (Transaction B) — sometimes the same day. Your profit is the spread. Not all title companies allow this or know how to process it cleanly.",
        },
        {
          type: "say",
          label: "Ask This",
          color: "#10b981",
          bg: "#0a1f18",
          text: `"Just to make sure I understand your process on double closes — when I'm buying from the seller and selling to my builder on the same day, can the proceeds from Transaction B be used to fund Transaction A? Or do I need to bring my own funds to the first closing?"`,
        },
        {
          type: "tip",
          label: "Why This Matters",
          color: "#ef4444",
          bg: "#2a0f0f",
          text: "If they require you to fund Transaction A independently, you'll need transactional funding or a gap funder. If they allow B to fund A — it's cleaner and cheaper. Know this before you bring them a deal.",
        },
        {
          type: "say",
          label: "Follow Up With",
          color: "#10b981",
          bg: "#0a1f18",
          text: `"And do you have any issue with the assignment of contract, or do you prefer a double close over an assignment on deals like these?"`,
        },
      ],
      rebuttals: [
        {
          them: `"We don't do double closings."`,
          you: `"I appreciate you being upfront about that. Do you handle assignment of contracts then — where I assign my purchase agreement to my end buyer before closing? That's the other structure I use."`,
        },
        {
          them: `"We'd need you to bring your own funds to the A transaction."`,
          you: `"Understood — I work with transactional lenders for that. As long as both closings can happen the same day, that works on my end. Can you accommodate same-day back-to-back closings?"`,
        },
        {
          them: `"We're not familiar with that structure."`,
          you: `"No problem — it's not uncommon, just more common with investors than retail buyers. Would you be open to talking through it with your title attorney so we know what's possible before I bring a deal in?"`,
        },
      ],
      comeback: [],
    },
    {
      id: "fees",
      label: "Fees & Timeline",
      icon: "💰",
      intro: "Get the numbers you need to build your deal math correctly. Don't be shy about this — knowing their fees makes you look experienced, not cheap.",
      blocks: [
        {
          type: "say",
          label: "Open the Conversation",
          color: "#f59e0b",
          bg: "#1f1500",
          text: `"I want to make sure I'm accounting for title costs accurately when I put deals together. Can you walk me through what a typical closing would cost on a vacant land transaction — both on the buy side when I'm acquiring from a seller, and on the sell side when I'm closing with my builder?"`,
        },
      ],
      questions: [
        { q: "What is your base closing/settlement fee for a land transaction?", why: "Your core cost — usually flat fee per closing side." },
        { q: "Is there a separate fee for the title search and title examination?", why: "Often charged separately from the settlement fee." },
        { q: "Do you charge for title insurance on both sides, and is it required?", why: "Lender's policy vs owner's policy — on a cash deal you may be able to waive lender's policy." },
        { q: "Are there any additional fees for a double close or back-to-back transaction?", why: "Some companies charge extra for the complexity — you need to know upfront." },
        { q: "Who typically pays what — is it negotiable between buyer and seller?", why: "In your deals you'll often be controlling both sides — you want flexibility." },
        { q: "What's your typical timeline from contract to close once escrow is opened?", why: "Plan your deals around their turnaround, not the other way around." },
      ],
      rebuttals: [
        {
          them: `"It depends on the deal — hard to say."`,
          you: `"Totally understand. Could you give me a ballpark on a straightforward cash land deal — say a lot worth $50,000? I just want a rough number to work with when I'm building my offers."`,
        },
        {
          them: `"We charge more for investor transactions."`,
          you: `"That's fair — can you tell me what that looks like so I can plan accordingly? And does that fee go down at all with volume as we close more deals together?"`,
        },
      ],
      comeback: [
        "Base closing/settlement fee confirmed",
        "Title search fee noted",
        "Double close fee (if any) noted",
        "Typical timeline from open to close",
        "Who pays what — buyer vs seller default",
      ],
    },
    {
      id: "close",
      label: "Close the Call",
      icon: "🤝",
      intro: "You've got what you need. Now lock in the relationship and set yourself up to bring them your first deal.",
      blocks: [
        {
          type: "say",
          label: "Closing Line",
          color: "#10b981",
          bg: "#0a1f18",
          text: `"This has been really helpful, [NAME] — I feel good about how your office operates. Here's what I'd like to do: I'll send you a quick email to introduce myself formally and have your contact info on file. When my next deal comes together in [MARKET], I'll reach out to you directly to open escrow. Does that work?"`,
        },
        {
          type: "say",
          label: "Confirm Their Info",
          color: "#10b981",
          bg: "#0a1f18",
          text: `"What's the best email to reach you at directly? And do you have a direct line or extension — I'd rather not go through the front desk every time I bring you a deal."`,
        },
        {
          type: "tip",
          label: "After the Call",
          color: "#f59e0b",
          bg: "#1f1500",
          text: "Send a same-day follow-up email: who you are in 2 sentences, the markets you're buying in, and that you'll be opening escrow with them on your next deal. Now you're a name they recognize, not a cold file.",
        },
      ],
      rebuttals: [],
      comeback: [
        "Go-to closer's name + direct line locked in",
        "Direct email confirmed",
        "Same-day intro email sent",
        "Double close / assignment capability confirmed",
        "Fee ballpark documented for deal math",
      ],
    },
    {
      id: "voicemail",
      label: "Voicemail",
      icon: "📱",
      intro: "If you can't reach a closer, leave a message that sounds like recurring business walking in the door — not a cold inquiry.",
      blocks: [
        {
          type: "say",
          label: "Leave This",
          color: "#22c55e",
          bg: "#0f2a1a",
          text: `"Hi, this message is for whoever handles your land closings — my name is [YOUR NAME]. I'm a land investor actively buying and selling vacant lots in [MARKET/COUNTY], and I'm looking for one title company to bring all of my transactions to on a consistent basis. I'd love 5 minutes to make sure we're a fit. You can reach me at [PHONE] — again, [YOUR NAME] at [PHONE]. Thank you."`,
        },
        {
          type: "tip",
          label: "Voicemail Rules",
          color: "#a78bfa",
          bg: "#1a1030",
          text: "Lead with recurring business — 'all of my transactions' is the phrase that gets callbacks. Say your number twice. Under 25 seconds.",
        },
      ],
      rebuttals: [],
      comeback: [],
    },
  ],
};

const CALL_SCRIPTS = {
  builder: BUYER_SELLER_SCRIPTS.builder,
  seller: BUYER_SELLER_SCRIPTS.seller,
  title: TITLE_SCRIPT,
  attorney: { ...ATTORNEY_SCRIPT, accentDim: "#2a0f33", badgeColor: "#e879f9" },
};

/* ============================================================
   TAB — CALL SCRIPTS (original interactive call console)
   Dark "call mode" theme preserved from your original system.
   [YOUR NAME]/[PHONE]/[EMAIL] auto-fill from your saved info.
   ============================================================ */
function CallScriptsTab({ settings }) {
  const [activeScript, setActiveScript] = useState("builder");
  const [activeStep, setActiveStep] = useState(0);
  const [checked, setChecked] = useState({});

  const script = CALL_SCRIPTS[activeScript];
  const step = script.steps[activeStep];
  const fill = (t) => fillTokens(t, settings);
  const toggle = (key) => setChecked((p) => ({ ...p, [key]: !p[key] }));
  const switchScript = (id) => { setActiveScript(id); setActiveStep(0); setChecked({}); };

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", background: "#0c0e14", borderRadius: 10, overflow: "hidden", color: "#e2e8f0", border: `1px solid ${C.line}` }}>
      {/* Script toggle */}
      <div style={{ background: "#10131c", borderBottom: "1px solid #1a2030", padding: "16px 18px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          <div style={{ fontSize: 11, letterSpacing: 3, color: "#475569", textTransform: "uppercase" }}>Land Acquisition Call Scripts — live call mode</div>
          <div style={{ fontSize: 11, color: settings.myName ? "#22c55e" : "#f59e0b" }}>
            {settings.myName ? `Auto-filling as ${settings.myName}` : "Tip: save your name/phone in any Pipeline lead's Texts & Mailers panel to auto-fill [YOUR NAME]"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, overflowX: "auto" }}>
          {Object.values(CALL_SCRIPTS).map((s) => (
            <button key={s.id} type="button" onClick={() => switchScript(s.id)}
              style={{
                padding: "10px 16px", border: "none", borderRadius: "8px 8px 0 0", cursor: "pointer",
                fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap",
                background: activeScript === s.id ? "#161d2e" : "transparent",
                color: activeScript === s.id ? s.accent : "#475569",
                borderBottom: activeScript === s.id ? `2px solid ${s.accent}` : "2px solid transparent",
              }}>
              <span style={{ background: (s.badgeColor || s.accent) + "22", color: s.badgeColor || s.accent, fontSize: 9, fontWeight: 800, letterSpacing: 1.5, padding: "2px 6px", borderRadius: 3, marginRight: 8 }}>{s.badge}</span>
              {s.label}: {s.title}
            </button>
          ))}
        </div>
      </div>

      {/* Script header */}
      <div style={{ background: "#161d2e", padding: "16px 18px 14px", borderBottom: "1px solid #1a2030" }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>{script.title}</div>
        <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>🎯 Goal: {script.goal}</div>
      </div>

      {/* Step nav */}
      <div style={{ display: "flex", overflowX: "auto", gap: 6, padding: "12px 18px", background: "#10131c", borderBottom: "1px solid #1a2030" }}>
        {script.steps.map((s, i) => (
          <button key={s.id} type="button" onClick={() => setActiveStep(i)}
            style={{
              padding: "7px 15px", borderRadius: 20, cursor: "pointer", whiteSpace: "nowrap",
              fontSize: 12, fontWeight: 600,
              border: `1px solid ${activeStep === i ? script.accent : "#1e2a3a"}`,
              background: activeStep === i ? script.accent + "22" : "transparent",
              color: activeStep === i ? script.accent : "#64748b",
            }}>
            {s.icon} {s.label}
          </button>
        ))}
      </div>

      {/* Step content */}
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 18px 50px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: 24 }}>{step.icon}</span>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>{step.label}</div>
        </div>

        <div style={{ background: "#161d2e", borderLeft: `3px solid ${script.accent}`, borderRadius: "0 8px 8px 0", padding: "12px 16px", fontSize: 13, color: "#94a3b8", marginBottom: 22, lineHeight: 1.65 }}>
          {step.intro}
        </div>

        {step.blocks && step.blocks.length > 0 && (
          <div style={{ marginBottom: 26 }}>
            {step.blocks.map((b, i) => (
              <div key={i} style={{ background: b.bg, border: `1px solid ${b.color}33`, borderRadius: 10, padding: "14px 18px", marginBottom: 12, lineHeight: 1.75 }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 2, color: b.color, marginBottom: 8, textTransform: "uppercase" }}>
                  {b.type === "say" ? "🎙" : b.type === "tip" ? "💡" : "🔵"} {b.label}
                </div>
                <div style={{ fontSize: 14, color: "#e2e8f0", whiteSpace: "pre-wrap" }}>{fill(b.text)}</div>
              </div>
            ))}
          </div>
        )}

        {step.questions && step.questions.length > 0 && (
          <div style={{ marginBottom: 26 }}>
            <div style={{ fontSize: 11, letterSpacing: 2, color: "#475569", textTransform: "uppercase", marginBottom: 12 }}>Questions to Cover</div>
            {step.questions.map((item, i) => {
              const key = `${activeScript}-${step.id}-q${i}`;
              const done = checked[key];
              return (
                <div key={i} onClick={() => toggle(key)}
                  style={{
                    display: "flex", gap: 12, alignItems: "flex-start",
                    background: done ? "#0f2a1a" : "#13181f",
                    border: `1px solid ${done ? "#22c55e44" : "#1e2a3a"}`,
                    borderRadius: 10, padding: "13px 16px", marginBottom: 9, cursor: "pointer",
                  }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: 4, flexShrink: 0, marginTop: 2,
                    border: `2px solid ${done ? "#22c55e" : "#334155"}`,
                    background: done ? "#22c55e" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 700, color: "#000",
                  }}>{done ? "✓" : ""}</div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: done ? "#6ee7b7" : "#e2e8f0", marginBottom: 4 }}>"{fill(item.q)}"</div>
                    <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.5 }}><span style={{ color: script.accent }}>Why: </span>{item.why}</div>
                  </div>
                </div>
              );
            })}
            <div style={{ fontSize: 11, color: "#334155", marginTop: 6 }}>Tap a question to mark it covered.</div>
          </div>
        )}

        {step.rebuttals && step.rebuttals.length > 0 && (
          <div style={{ marginBottom: 26 }}>
            <div style={{ fontSize: 11, letterSpacing: 2, color: "#475569", textTransform: "uppercase", marginBottom: 12 }}>Rebuttals</div>
            {step.rebuttals.map((r, i) => (
              <div key={i} style={{ background: "#13101a", border: "1px solid #2d1f3a", borderRadius: 10, padding: "14px 18px", marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#ef4444", marginBottom: 8 }}>THEM: {r.them}</div>
                <div style={{ fontSize: 14, color: "#fde68a", lineHeight: 1.7 }}><span style={{ color: "#f59e0b", fontWeight: 700, fontSize: 11 }}>YOU: </span>{fill(r.you)}</div>
              </div>
            ))}
          </div>
        )}

        {step.comeback && step.comeback.length > 0 && (
          <div style={{ background: "#1a1500", border: `1px solid ${script.accent}44`, borderLeft: `3px solid ${script.accent}`, borderRadius: "0 10px 10px 0", padding: "16px 20px" }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 2, color: script.accent, marginBottom: 12, textTransform: "uppercase" }}>📋 Before You Hang Up — Capture This</div>
            {step.comeback.map((item, i) => {
              const key = `${activeScript}-${step.id}-c${i}`;
              const done = checked[key];
              return (
                <div key={i} onClick={() => toggle(key)} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, cursor: "pointer" }}>
                  <div style={{
                    width: 16, height: 16, borderRadius: 3, flexShrink: 0,
                    border: `2px solid ${done ? script.accent : "#334155"}`,
                    background: done ? script.accent : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 9, fontWeight: 800, color: "#000",
                  }}>{done ? "✓" : ""}</div>
                  <div style={{ fontSize: 13, color: done ? "#94a3b8" : "#cbd5e1", textDecoration: done ? "line-through" : "none" }}>{item}</div>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
          <button type="button" onClick={() => setActiveStep((p) => Math.max(0, p - 1))} disabled={activeStep === 0}
            style={{ padding: "10px 20px", borderRadius: 8, border: "1px solid #1e2a3a", background: "transparent", color: activeStep === 0 ? "#1e2a3a" : "#94a3b8", fontSize: 13, fontWeight: 600, cursor: activeStep === 0 ? "default" : "pointer" }}>
            ← Previous
          </button>
          <button type="button" onClick={() => setActiveStep((p) => Math.min(script.steps.length - 1, p + 1))} disabled={activeStep === script.steps.length - 1}
            style={{ padding: "10px 20px", borderRadius: 8, border: "none", background: activeStep === script.steps.length - 1 ? "#1e2a3a" : script.accent, color: activeStep === script.steps.length - 1 ? "#334155" : "#000", fontSize: 13, fontWeight: 700, cursor: activeStep === script.steps.length - 1 ? "default" : "pointer" }}>
            Next Step →
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   TAB — MARKET SCOUT (AI growth-signal analyzer)
   Calls Claude with live web search from inside the app.
   ============================================================ */
const SCOUT_SIGNALS = ["Retail Expansion", "Population Growth", "Builder Demand", "Infrastructure Signals", "Land Availability", "Motivated Seller Pool"];

function MarketScoutTab({ onCreateBox, data, update }) {
  const [loc, setLoc] = useState("");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [lotFind, setLotFind] = useState(null); // {q, seq} → RadarMap flies to the lot + owner card
  const scoutHistory = (data && data.scout) ? data.scout : {};

  const findLot = (target) => {
    const q = String(target != null ? target : loc).trim();
    if (!q) return;
    setError("");
    setLotFind({ q, seq: Date.now() });
  };

  const verdictColor = (v) => {
    if (!v) return C.faint;
    if (v.includes("FIRE")) return "#D8430E";
    if (v.includes("HEATING")) return C.orange;
    if (v.includes("WATCH")) return C.amber;
    if (v.includes("EARLY")) return C.blue;
    return C.faint;
  };

  const runScout = async (target) => {
    const market = (target || loc).trim();
    if (!market || loading) return;
    setLoc(market); setLoading(true); setError(""); setReport(null);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `You are a real estate market intelligence analyst for a land wholesaler who sells vacant lots to home builders. Use web search to analyze "${market}" as a builder market. Look for: retail precursor chains (Starbucks, Chick-fil-A, Dollar General, AutoZone, hospitals) arriving ahead of homes; population growth; builder/permit activity; infrastructure projects; remaining raw land; and motivated seller potential (longtime owners, farmers, heirs).

Respond with ONLY a JSON object — no markdown fences, no preamble, no text after. Exact schema:
{"market":"${market}","lat":decimal latitude,"lng":decimal longitude,"score":0-100,"verdict":"ON FIRE"|"HEATING UP"|"WATCH LIST"|"TOO EARLY"|"COLD","summary":"2 sentences on the market","signals":[{"name":"Retail Expansion","score":0-100,"insight":"1 sentence"},{"name":"Population Growth","score":0-100,"insight":"1 sentence"},{"name":"Builder Demand","score":0-100,"insight":"1 sentence"},{"name":"Infrastructure Signals","score":0-100,"insight":"1 sentence"},{"name":"Land Availability","score":0-100,"insight":"1 sentence"},{"name":"Motivated Seller Pool","score":0-100,"insight":"1 sentence"}],"retail":["brands recently arrived or announced"],"actions":["4-5 specific next steps for this wholesaler"],"similar":["3 similar markets to scout"],"risks":"1 sentence on the main risk"}`,
          }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      });
      const resJson = await response.json();
      if (resJson && resJson.type === "error") throw new Error(resJson.error?.message || "API returned an error.");
      if (resJson && resJson.error) throw new Error(resJson.error.message || "API error.");
      const fullText = (resJson.content || []).map(b => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
      if (!fullText.trim()) throw new Error("No response text returned — try again in a moment.");
      const match = fullText.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Analysis came back unstructured — hit Scout again.");
      const parsed = JSON.parse(match[0].replace(/```json|```/g, "").trim());
      setReport(parsed);
      // persist so the recon map remembers every scouted market
      const key = market.trim().toLowerCase();
      if (update && data) update({ ...data, scout: { ...(data.scout || {}), [key]: { ...parsed, market, scoutedAt: new Date().toISOString().slice(0,10) } } });
    } catch (e) {
      setError(`Scout failed: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  const county = report ? String(report.market || loc).split(",")[0].replace(/county/i, "").trim() : "";
  const state = report ? (String(report.market || loc).split(",")[1] || "").trim() : "";

  return (
    <div>
      <div className="lc-display" style={{ fontSize: 22, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em" }}>Market scout</div>
      <div style={{ fontSize: 13, color: C.faint, marginBottom: 14 }}>The radar below ranks FL, TX, NC and TN counties on real building-permit data — click a hotspot for its demand dossier, scan live land sales around it (FL), or deep-scout it with web research. Type a county to scout the market, or paste an APN / FL property address to jump straight to that lot and its owner.</div>

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="lc-input" style={{ flex: 1, minWidth: 220 }} value={loc} onChange={e => setLoc(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { if (looksLikeLotQuery(loc)) findLot(); else runScout(); } }}
            placeholder="County market — or an APN / property address to jump to a lot" />
          <Btn onClick={() => findLot()} kind="ghost">⌖ Find lot</Btn>
          <Btn onClick={() => runScout()}>{loading ? "Scouting…" : "Scout market ↗"}</Btn>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: C.faint }}>Try:</span>
          {["Hays County, TX", "Pasco County, FL", "St. Johns County, FL", "Maury County, TN", "Kaufman County, TX"].map(m => (
            <button key={m} type="button" onClick={() => runScout(m)}
              style={{ fontSize: 12, padding: "4px 10px", borderRadius: 99, border: `1px solid ${C.line}`, background: "#fff", color: C.ink, cursor: "pointer", fontWeight: 600 }}>{m}</button>
          ))}
        </div>
      </div>

      <RadarMap history={scoutHistory} activeMarket={report ? (report.market || loc) : loc} onSelect={(rep) => { setReport(rep); setLoc(rep.market); setError(""); }} onScout={(m) => runScout(m)} onCreateBox={onCreateBox} data={data} update={update} lotFind={lotFind} />

      {loading && (
        <div style={{ marginTop: 14, padding: 24, textAlign: "center", color: C.faint, fontSize: 13.5, border: `2px dashed ${C.line}`, borderRadius: 8 }}>
          Running live web research on {loc} — retail precursors, permits, population, land supply… (15–30 seconds)
        </div>
      )}
      {error && (
        <div style={{ marginTop: 14, padding: 14, background: C.redPale, border: `1px solid ${C.red}`, borderRadius: 8, color: C.red, fontSize: 13.5 }}>{error}</div>
      )}

      {report && (
        <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
          {/* Verdict banner */}
          <div style={{ background: C.panel, border: `1px solid ${verdictColor(report.verdict)}`, borderLeft: `6px solid ${verdictColor(report.verdict)}`, borderRadius: 8, padding: 18, display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div className="lc-mono" style={{ fontSize: 48, fontWeight: 600, color: verdictColor(report.verdict), lineHeight: 1 }}>{report.score}</div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <span className="lc-stamp" style={{ color: verdictColor(report.verdict), fontSize: 13 }}>{report.verdict}</span>
              <div className="lc-display" style={{ fontSize: 19, fontWeight: 800, textTransform: "uppercase", marginTop: 6 }}>{report.market}</div>
              <div style={{ fontSize: 13.5, lineHeight: 1.6, marginTop: 4 }}>{report.summary}</div>
              {report.risks && <div style={{ fontSize: 12.5, color: C.amber, marginTop: 6 }}>⚠ {report.risks}</div>}
            </div>
            <Btn onClick={() => onCreateBox(county, state)}>+ Start a buy box here</Btn>
          </div>

          {/* Signal bars */}
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 16 }}>
            <div className="lc-label" style={{ marginBottom: 10 }}>Signal scores</div>
            {(report.signals || []).map((s, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: 700, marginBottom: 3 }}>
                  <span>{s.name}</span><span className="lc-mono" style={{ color: C.green }}>{s.score}</span>
                </div>
                <div style={{ height: 7, background: "#E8EAE2", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ width: `${Math.min(100, Math.max(0, s.score))}%`, height: "100%", background: s.score >= 75 ? C.orange : s.score >= 50 ? C.amber : C.faint, borderRadius: 99 }} />
                </div>
                <div style={{ fontSize: 12, color: C.faint, marginTop: 3 }}>{s.insight}</div>
              </div>
            ))}
          </div>

          {/* Retail + actions */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
            {report.retail && report.retail.length > 0 && (
              <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 16 }}>
                <div className="lc-label" style={{ marginBottom: 8 }}>Retail precursors spotted</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {report.retail.map((r, i) => <span key={i} style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 99, background: C.greenPale, color: C.green, border: `1px solid ${C.green}` }}>{r}</span>)}
                </div>
              </div>
            )}
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 16 }}>
              <div className="lc-label" style={{ marginBottom: 8 }}>Your action plan</div>
              <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
                {(report.actions || []).map((a, i) => <li key={i} style={{ fontSize: 13, lineHeight: 1.5 }}>{a}</li>)}
              </ol>
            </div>
          </div>

          {/* Similar markets */}
          {report.similar && report.similar.length > 0 && (
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 16 }}>
              <div className="lc-label" style={{ marginBottom: 8 }}>Similar markets to scout next</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {report.similar.map((m, i) => (
                  <button key={i} type="button" onClick={() => runScout(m)}
                    style={{ fontSize: 12.5, fontWeight: 700, padding: "6px 14px", borderRadius: 99, border: `1px solid ${C.orange}`, background: "#fff", color: C.orangeDark, cursor: "pointer" }}>{m} ↗</button>
                ))}
              </div>
            </div>
          )}
          <div style={{ fontSize: 11.5, color: C.faint, textAlign: "center" }}>AI-generated scores from live web research. Verify with county records and MLS before committing capital.</div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   TAB — DELINQUENCY HUB
   Multi-county tax-delinquency recon: live web research finds
   each county's delinquent list, format, and next tax sale.
   Results are cached in your saved data — refresh anytime.
   ============================================================ */
function delinqKey(county, state) { return `${county.trim().toLowerCase()}|${state.trim().toLowerCase()}`; }

async function researchCounty(county, state) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `You are a research assistant for a vacant-land investor. Use web search to find how to obtain the CURRENT delinquent property tax list for ${county} County, ${state}, and details on their tax sales. Find: the official tax collector / treasurer page for delinquent taxes, whether the delinquent list is downloadable (PDF/Excel/web portal) or requires a public records request, any cost, the next tax deed or tax lien sale date if announced, and where sales are held (e.g. RealAuction, Bid4Assets, GovEase, in-person).

Respond with ONLY a JSON object — no markdown fences, no preamble, no trailing text. Exact schema:
{"county":"${county}","state":"${state}","listFormat":"PDF"|"Excel"|"Web portal"|"Records request"|"Unknown","howToGet":"2-3 sentences with exact steps","cost":"free or fee details","requestRequired":true|false,"nextSaleDate":"date or 'not announced'","saleType":"tax deed"|"tax lien"|"both"|"unknown","salePlatform":"platform or location","links":[{"name":"short label","url":"https://..."}],"tip":"1 sentence insider tip for working this county's list"}
Include up to 4 links: the delinquent list page, the tax collector page, the sale/auction page, and the records request page if applicable. Only include URLs you actually found.`,
      }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  const data = await response.json();
  const fullText = (data.content || []).map(b => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
  const match = fullText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no result");
  return JSON.parse(match[0].replace(/```json|```/g, "").trim());
}

function DelinquencyHubTab({ data, update, onGoImport }) {
  const [boxId, setBoxId] = useState(data.buyboxes[0]?.id || "");
  const [manualCounty, setManualCounty] = useState("");
  const [manualState, setManualState] = useState("");
  const [extra, setExtra] = useState([]);              // manually added {county, state}
  const [busy, setBusy] = useState({});                // key -> true while researching
  const [errors, setErrors] = useState({});            // key -> message
  const [runningAll, setRunningAll] = useState(false);

  const box = data.buyboxes.find(b => b.id === boxId);
  const cache = data.delinq || {};
  const counties = [
    ...(box ? splitList(box.counties).map(c => ({ county: c, state: box.state || "" })) : []),
    ...extra,
  ].filter((c, i, arr) => arr.findIndex(x => delinqKey(x.county, x.state) === delinqKey(c.county, c.state)) === i);

  const runOne = async (c) => {
    const key = delinqKey(c.county, c.state);
    setBusy(p => ({ ...p, [key]: true }));
    setErrors(p => ({ ...p, [key]: "" }));
    try {
      const result = await researchCounty(c.county, c.state);
      result.researchedAt = new Date().toISOString().slice(0, 10);
      update({ ...data, delinq: { ...(data.delinq || {}), [key]: result } });
    } catch (e) {
      setErrors(p => ({ ...p, [key]: "Research failed — hit Research again in a few seconds." }));
    } finally {
      setBusy(p => ({ ...p, [key]: false }));
    }
  };

  const runAll = async () => {
    setRunningAll(true);
    for (const c of counties) {
      if (!cache[delinqKey(c.county, c.state)]) await runOne(c);
    }
    setRunningAll(false);
  };

  const addManual = () => {
    if (!manualCounty.trim()) return;
    setExtra([...extra, { county: manualCounty.trim(), state: (manualState || box?.state || "").trim() }]);
    setManualCounty("");
  };

  const fmtChip = (label, color) => (
    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", padding: "3px 9px", borderRadius: 99, background: color + "22", color, border: `1px solid ${color}` }}>{label}</span>
  );

  return (
    <div>
      <div className="lc-display" style={{ fontSize: 22, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em" }}>Delinquency hub</div>
      <div style={{ fontSize: 13, color: C.faint, marginBottom: 14 }}>Multi-county tax-delinquency recon. Live research finds each county's list, how to get it, and the next tax sale — then pull the list, filter to vacant land, and feed your Pipeline.</div>

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 16, marginBottom: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <Field label="Buy box (loads its counties)">
            <select className="lc-input" value={boxId} onChange={e => setBoxId(e.target.value)}>
              <option value="">— none —</option>
              {data.buyboxes.map(b => <option key={b.id} value={b.id}>{b.builder || "Unnamed"} — {splitList(b.counties).join(", ") || "no counties"}</option>)}
            </select>
          </Field>
          <Field label="Add a county manually">
            <div style={{ display: "flex", gap: 6 }}>
              <input className="lc-input" value={manualCounty} onChange={e => setManualCounty(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addManual(); }} placeholder="County" />
              <input className="lc-input" style={{ maxWidth: 70 }} value={manualState} onChange={e => setManualState(e.target.value)} placeholder="ST" />
              <Btn small onClick={addManual}>+</Btn>
            </div>
          </Field>
        </div>
        {counties.length > 0 && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
            <Btn onClick={runAll}>{runningAll ? "Researching all counties…" : `⚡ Research all ${counties.length} counties`}</Btn>
            <span style={{ fontSize: 12, color: C.faint }}>~20–30 sec per county · results are saved, so you only pay that cost once per county</span>
          </div>
        )}
      </div>

      {counties.length === 0 && (
        <div style={{ border: `2px dashed ${C.line}`, borderRadius: 8, padding: 40, textAlign: "center", color: C.faint, fontSize: 14 }}>
          Pick a buy box with counties, or add a county manually to start the recon.
        </div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {counties.map(c => {
          const key = delinqKey(c.county, c.state);
          const r = cache[key];
          const isBusy = !!busy[key];
          const err = errors[key];
          return (
            <div key={key} style={{ background: C.panel, border: `1px solid ${C.line}`, borderLeft: `5px solid ${r ? C.green : C.line}`, borderRadius: 8, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <div className="lc-display" style={{ fontSize: 17, fontWeight: 800, textTransform: "uppercase" }}>{c.county} County{c.state ? `, ${c.state}` : ""}</div>
                  {r && <div className="lc-mono" style={{ fontSize: 11, color: C.faint }}>researched {r.researchedAt}</div>}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {r && fmtChip(r.listFormat || "Unknown", r.requestRequired ? C.amber : C.green)}
                  {r && r.saleType && r.saleType !== "unknown" && fmtChip(r.saleType, C.blue)}
                  <Btn small kind={r ? "ghost" : "primary"} onClick={() => runOne(c)}>{isBusy ? "Researching…" : r ? "↻ Refresh" : "🔎 Research"}</Btn>
                </div>
              </div>

              {isBusy && <div style={{ fontSize: 12.5, color: C.faint, marginTop: 10 }}>Searching the county tax collector, list format, and sale calendar…</div>}
              {err && <div style={{ fontSize: 12.5, color: C.red, marginTop: 10 }}>{err}</div>}

              {!r && !isBusy && (
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
                  <a className="lc-link" href={`https://www.google.com/search?q=${encodeURIComponent(`${c.county} county ${c.state} delinquent tax list real property`)}`} target="_blank" rel="noreferrer">↗ Quick search: delinquent list</a>
                  <a className="lc-link" href={`https://www.google.com/search?q=${encodeURIComponent(`${c.county} county ${c.state} tax deed sale upcoming`)}`} target="_blank" rel="noreferrer">↗ Quick search: tax sales</a>
                </div>
              )}

              {r && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 10 }}>
                    <div><div className="lc-label">How to get the list</div><div style={{ fontSize: 13, lineHeight: 1.55 }}>{r.howToGet}</div></div>
                    <div>
                      <div className="lc-label">Cost</div><div style={{ fontSize: 13 }}>{r.cost || "—"}</div>
                      <div className="lc-label" style={{ marginTop: 8 }}>Next sale</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: r.nextSaleDate && !/not announced|unknown/i.test(r.nextSaleDate) ? C.orangeDark : C.ink }}>{r.nextSaleDate || "—"}{r.salePlatform ? ` · ${r.salePlatform}` : ""}</div>
                    </div>
                  </div>
                  {r.links && r.links.length > 0 && (
                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
                      {r.links.map((l, i) => <a key={i} className="lc-link" href={l.url} target="_blank" rel="noreferrer">↗ {l.name}</a>)}
                    </div>
                  )}
                  {r.tip && <div style={{ fontSize: 12.5, color: C.green, fontWeight: 600, marginBottom: 10 }}>💡 {r.tip}</div>}
                  <div style={{ background: "#FAFBF7", border: `1px dashed ${C.line}`, borderRadius: 6, padding: 10, fontSize: 12.5, lineHeight: 1.6 }}>
                    <strong>Work the list:</strong> download it → in PropStream/Regrid (or the spreadsheet itself) filter to <em>vacant land</em> + out-of-state owners + owned 5–10+ yrs → skip trace → then
                    <button type="button" onClick={onGoImport} style={{ border: "none", background: "none", color: C.blue, fontWeight: 700, cursor: "pointer", fontSize: 12.5, padding: "0 4px", textDecoration: "underline" }}>import the CSV into your Pipeline →</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {counties.length > 0 && (
        <div style={{ fontSize: 11.5, color: C.faint, marginTop: 12, textAlign: "center" }}>
          AI web research — county sites change often, so verify links before relying on a sale date. Owners on these lists are often in hardship; lead with respect and real solutions.
        </div>
      )}
    </div>
  );
}

/* ============================================================
   COMMAND CENTER — home page, automation, radar situation map
   Aesthetic: land-survey mission control. Phosphor HUD on a
   topographic field. Signature element: live radar sweep with
   hot-spot blips drawn from your armed counties + matched leads.
   ============================================================ */
const CC = {
  void: "#0A0F0D", abyss: "#070B0A", moss: "#0E1A14", mossLit: "#12241B",
  edge: "#1E3A2A", edgeLit: "#2A5740",
  phosphor: "#4ADE9E", phosphorDim: "#3C8C68",
  signal: "#FF6B2C", signalDim: "#B8480F",
  cyan: "#46C7F2", amber: "#F5B544",
  stake: "#D6E2D8", stakeDim: "#7E948A",
};

const CC_CSS = `
.cc-header { position: relative; background: linear-gradient(180deg, ${CC.abyss} 0%, ${CC.void} 100%); border-bottom: 1px solid ${CC.edge}; overflow: hidden; }
.cc-contour { position: absolute; inset: 0; opacity: .5; pointer-events: none;
  background-image:
    repeating-radial-gradient(circle at 18% 140%, transparent 0 22px, rgba(74,222,158,.05) 22px 23px),
    repeating-radial-gradient(circle at 85% -40%, transparent 0 26px, rgba(70,199,242,.045) 26px 27px); }
.cc-dot { width: 9px; height: 9px; border-radius: 50%; background: ${CC.phosphor}; box-shadow: 0 0 0 0 ${CC.phosphor}; animation: cc-pulse 2.4s infinite; flex-shrink: 0; }
@keyframes cc-pulse { 0% { box-shadow: 0 0 0 0 rgba(74,222,158,.6);} 70% { box-shadow: 0 0 0 8px rgba(74,222,158,0);} 100% { box-shadow: 0 0 0 0 rgba(74,222,158,0);} }
.cc-chip { font-family:'JetBrains Mono',monospace; font-size:10px; font-weight:700; letter-spacing:.08em; padding:4px 11px; border-radius:3px; border:1px solid; cursor:pointer; }
.cc-tab { padding: 9px 18px; border:1px solid transparent; border-bottom:none; cursor:pointer; font-weight:800; font-size:12.5px; letter-spacing:.1em; text-transform:uppercase;
  background:transparent; color:${CC.stakeDim}; border-radius:6px 6px 0 0; transition: color .15s, background .15s; }
.cc-tab:hover { color:${CC.stake}; background:${CC.moss}; }
.cc-tab-on { background:${CC.void}; color:${CC.phosphor}; border-color:${CC.edge}; box-shadow: inset 0 2px 0 ${CC.phosphor}; }
.cc-wrap { background: radial-gradient(ellipse at 50% -10%, ${CC.mossLit} 0%, ${CC.void} 55%, ${CC.abyss} 100%); border:1px solid ${CC.edge}; border-radius:14px; padding:0; overflow:hidden; color:${CC.stake}; }
.cc-card { background:${CC.moss}; border:1px solid ${CC.edge}; border-radius:10px; padding:16px; }
.cc-card:hover { border-color:${CC.edgeLit}; }
.cc-eyebrow { font-family:'JetBrains Mono',monospace; font-size:10px; font-weight:700; letter-spacing:.2em; text-transform:uppercase; color:${CC.phosphorDim}; }
.cc-kpi { font-family:'Saira Condensed',sans-serif; font-size:38px; font-weight:800; line-height:.9; color:${CC.stake}; }
.cc-launch { display:flex; flex-direction:column; gap:7px; align-items:flex-start; text-align:left; background:${CC.moss}; border:1px solid ${CC.edge}; border-radius:10px; padding:14px; cursor:pointer; transition: transform .12s, border-color .12s, background .12s; width:100%; }
.cc-launch:hover { transform: translateY(-2px); border-color:${CC.phosphor}; background:${CC.mossLit}; }
.cc-radar-sweep { transform-origin: 50% 50%; animation: cc-spin 4s linear infinite; }
@keyframes cc-spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }
.cc-blip { animation: cc-blip 2s ease-out infinite; }
@keyframes cc-blip { 0%,100% { opacity:.35;} 50% { opacity:1;} }
.cc-actionrow { display:flex; align-items:center; gap:12px; padding:11px 13px; border:1px solid ${CC.edge}; border-radius:9px; background:${CC.moss}; transition: border-color .12s; }
.cc-actionrow:hover { border-color:${CC.edgeLit}; }
@media (prefers-reduced-motion: reduce) { .cc-dot,.cc-radar-sweep,.cc-blip { animation: none !important; } }
`;

/* ---- automation helpers ---- */
function daysSinceISO(d) {
  if (!d) return null;
  const then = new Date(d + "T00:00:00"); if (isNaN(then)) return null;
  return Math.floor((Date.now() - then.getTime()) / 86400000);
}
/* Lightweight auto-match: scores a list lead on the data it reliably has
   (location, size, price) against a buy box. No diligence fields needed. */
function quickMatch(lead, b) {
  let applic = 0, hit = 0, locMatch = false;
  const zips = splitList(b.zips), counties = splitList(b.counties).map(x => x.toLowerCase());
  if (zips.length || counties.length) {
    applic++;
    const z = (lead.zip || "").trim(), co = (lead.county || "").trim().toLowerCase();
    if ((zips.length && zips.includes(z)) || (counties.length && counties.includes(co))) { hit++; locMatch = true; }
  }
  const ac = parseFloat(lead.acres);
  if (!isNaN(ac) && (b.lotMin || b.lotMax)) {
    applic++;
    const mn = parseFloat(b.lotMin) || 0, mx = parseFloat(b.lotMax) || Infinity;
    if (ac >= mn && ac <= mx) hit++;
  }
  const price = parseFloat(lead.price);
  if (!isNaN(price) && b.maxPrice) { applic++; if (price <= parseFloat(b.maxPrice)) hit++; }
  const score = applic ? Math.round((hit / applic) * 100) : 0;
  return { score, locMatch, applic };
}
function bestMatch(lead, buyboxes) {
  if (!buyboxes || !buyboxes.length) return null;
  let best = null;
  for (const b of buyboxes) {
    const m = quickMatch(lead, b);
    if (m.applic === 0) continue;
    const rank = m.score + (m.locMatch ? 1000 : 0);
    if (!best || rank > best.rank) best = { rank, score: m.score, locMatch: m.locMatch, builder: b.builder || "Unnamed", boxId: b.id };
  }
  return best;
}
function matchColor(score) { return score >= 80 ? CC.phosphor : score >= 55 ? CC.amber : CC.stakeDim; }

function nextActions(leads) {
  const dead = new Set(["Closed", "Dead", "Assigned"]);
  const rows = [];
  for (const l of leads) {
    if (dead.has(l.status)) continue;
    const touches = [l.texted, l.called, l.mailed].map(daysSinceISO).filter(x => x !== null);
    const last = touches.length ? Math.min(...touches) : null;
    let urgency, action;
    if (last === null) { urgency = 1000; action = "Start outreach — never contacted"; }
    else if (last >= 5) { urgency = last; action = `Follow up — ${last}d since last touch`; }
    else continue;
    rows.push({ lead: l, urgency, action });
  }
  return rows.sort((a, b) => b.urgency - a.urgency).slice(0, 6);
}

function CommandCenterTab({ data, onNavigate, storageOk, onOpenBackup }) {
  const leads = data.leads || [], boxes = data.buyboxes || [];
  const matched = useMemo(() => leads.map(l => ({ l, m: bestMatch(l, boxes) })).filter(x => x.m), [leads, boxes]);
  const hot = matched.filter(x => x.m.locMatch && x.m.score >= 70).sort((a, b) => b.m.score - a.m.score);
  const actions = useMemo(() => nextActions(leads), [leads]);
  const delinq = data.delinq || {};
  const hotCounties = Object.values(delinq).filter(r => r && r.nextSaleDate && !/not announced|unknown/i.test(r.nextSaleDate));

  const funnel = ["New", "Contacted", "Negotiating", "Under contract", "Closed"].map(st => ({
    st, n: leads.filter(l => l.status === st).length,
  }));
  const maxF = Math.max(1, ...funnel.map(f => f.n));

  // radar blips from armed counties (buy boxes) + hot leads
  const armedCounties = [...new Set(boxes.flatMap(b => splitList(b.counties)))];
  const blips = armedCounties.slice(0, 9).map((name, i) => {
    let h = 0; for (let k = 0; k < name.length; k++) h = (h * 31 + name.charCodeAt(k)) % 997;
    const ang = (h % 360) * Math.PI / 180, rad = 26 + (h % 60);
    return { name, x: 100 + Math.cos(ang) * rad, y: 100 + Math.sin(ang) * rad, hot: hot.some(x => (x.l.county || "").toLowerCase() === name.toLowerCase()) };
  });

  const empty = boxes.length === 0 && leads.length === 0;
  const fmtK = (n) => n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + "k" : n;

  const launches = [
    ["scout", "◎", "Market Scout", "Score any county's builder demand, live"],
    ["boxes", "▢", "Buy Boxes", "Define what your builders pay cash for"],
    ["find", "⛏", "Find Deals", "Pre-targeted on/off-market search routes"],
    ["delinq", "⚑", "Delinquency Hub", "Locate distressed lists across counties"],
    ["match", "◈", "Match a Parcel", "Score a lot against every buy box"],
    ["pricing", "$", "Pricing Calc", "CMV → offer → MAO → spread"],
    ["calls", "☎", "Call Scripts", "Live scripts for all 4 sides of a deal"],
    ["pipeline", "≡", "Pipeline", "Owners, outreach, and auto-match scores"],
  ];

  return (
    <div className="cc-wrap">
      {/* Hero: radar situation map */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 0, borderBottom: `1px solid ${CC.edge}` }}>
        <div style={{ padding: "26px 26px 22px" }}>
          <div className="cc-eyebrow">Operation Status · {new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</div>
          <div className="lc-display" style={{ fontSize: 34, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: CC.stake, lineHeight: 1, margin: "8px 0 4px" }}>
            Situation <span style={{ color: CC.phosphor }}>Map</span>
          </div>
          <div style={{ fontSize: 13, color: CC.stakeDim, maxWidth: 440, lineHeight: 1.5 }}>
            {empty ? "No active operations yet. Arm your first buy box and Land Command starts hunting." :
              `${armedCounties.length} counties armed · ${hot.length} hot lead${hot.length === 1 ? "" : "s"} flagged · ${actions.length} action${actions.length === 1 ? "" : "s"} waiting. The system scored everything automatically — your move.`}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            <button className="cc-launch" style={{ width: "auto", flexDirection: "row", alignItems: "center", gap: 8, borderColor: CC.signal }} onClick={() => onNavigate(empty ? "boxes" : "pipeline")}>
              <span style={{ color: CC.signal, fontWeight: 800 }}>{empty ? "▢ Arm a buy box" : "≡ Work the pipeline"}</span>
            </button>
            <button className="cc-launch" style={{ width: "auto", flexDirection: "row", alignItems: "center", gap: 8 }} onClick={() => onNavigate("scout")}>
              <span style={{ color: CC.phosphor, fontWeight: 800 }}>◎ Scout a market</span>
            </button>
          </div>
        </div>
        {/* Radar */}
        <div style={{ width: 230, minWidth: 230, display: "flex", alignItems: "center", justifyContent: "center", background: CC.abyss, borderLeft: `1px solid ${CC.edge}` }}>
          <svg width="200" height="200" viewBox="0 0 200 200">
            <defs>
              <radialGradient id="ccGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor={CC.phosphor} stopOpacity="0.18" />
                <stop offset="100%" stopColor={CC.phosphor} stopOpacity="0" />
              </radialGradient>
              <linearGradient id="ccSweep" x1="50%" y1="50%" x2="100%" y2="50%">
                <stop offset="0%" stopColor={CC.phosphor} stopOpacity="0.55" />
                <stop offset="100%" stopColor={CC.phosphor} stopOpacity="0" />
              </linearGradient>
            </defs>
            <circle cx="100" cy="100" r="92" fill="url(#ccGlow)" />
            {[30, 56, 82].map(r => <circle key={r} cx="100" cy="100" r={r} fill="none" stroke={CC.edge} strokeWidth="1" />)}
            <line x1="8" y1="100" x2="192" y2="100" stroke={CC.edge} strokeWidth="1" />
            <line x1="100" y1="8" x2="100" y2="192" stroke={CC.edge} strokeWidth="1" />
            <g className="cc-radar-sweep">
              <path d="M100 100 L192 100 A92 92 0 0 1 150 180 Z" fill="url(#ccSweep)" />
            </g>
            {blips.map((b, i) => (
              <g key={i} className="cc-blip" style={{ animationDelay: `${i * 0.3}s` }}>
                <circle cx={b.x} cy={b.y} r={b.hot ? 4.5 : 3} fill={b.hot ? CC.signal : CC.phosphor} />
                {b.hot && <circle cx={b.x} cy={b.y} r="8" fill="none" stroke={CC.signal} strokeWidth="1" opacity="0.5" />}
              </g>
            ))}
            <circle cx="100" cy="100" r="3" fill={CC.stake} />
          </svg>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 1, background: CC.edge, borderBottom: `1px solid ${CC.edge}` }}>
        {[
          ["Buy boxes", boxes.length, CC.stake],
          ["Total leads", fmtK(leads.length), CC.stake],
          ["Hot leads", hot.length, CC.signal],
          ["Counties armed", armedCounties.length, CC.phosphor],
          ["In negotiation+", leads.filter(l => ["Negotiating", "Under contract"].includes(l.status)).length, CC.cyan],
          ["Closed", leads.filter(l => l.status === "Closed").length, CC.phosphor],
        ].map(([label, val, color], i) => (
          <div key={i} style={{ background: CC.void, padding: "14px 16px" }}>
            <div className="cc-kpi" style={{ color }}>{val}</div>
            <div className="cc-eyebrow" style={{ marginTop: 4 }}>{label}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 14 }}>
        {/* Today's call list */}
        <div className="cc-card">
          <div className="cc-eyebrow" style={{ color: CC.signal }}>▶ Today's call list — auto-prioritized</div>
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {actions.length === 0 && <div style={{ fontSize: 13, color: CC.stakeDim }}>{leads.length ? "All caught up — no follow-ups due. Add leads or pull a delinquency list." : "No leads yet. The pipeline fills from CSV imports and the Delinquency Hub."}</div>}
            {actions.map(({ lead, action }, i) => {
              const m = bestMatch(lead, boxes);
              return (
                <div key={i} className="cc-actionrow">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: CC.stake, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{lead.owner || "Unknown owner"}{lead.county ? ` · ${lead.county}` : ""}</div>
                    <div style={{ fontSize: 11.5, color: CC.signal }}>{action}</div>
                  </div>
                  {m && <span className="lc-mono" style={{ fontSize: 11, fontWeight: 700, color: matchColor(m.score) }}>{m.score}%</span>}
                </div>
              );
            })}
          </div>
          {actions.length > 0 && <button className="cc-launch" style={{ marginTop: 12, width: "auto", flexDirection: "row" }} onClick={() => onNavigate("pipeline")}><span style={{ color: CC.phosphor, fontWeight: 700, fontSize: 13 }}>Open pipeline →</span></button>}
        </div>

        {/* Pipeline funnel */}
        <div className="cc-card">
          <div className="cc-eyebrow">◢ Pipeline funnel</div>
          <div style={{ display: "grid", gap: 9, marginTop: 12 }}>
            {funnel.map(f => (
              <div key={f.st}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                  <span style={{ color: CC.stakeDim }}>{f.st}</span>
                  <span className="lc-mono" style={{ color: CC.stake, fontWeight: 700 }}>{f.n}</span>
                </div>
                <div style={{ height: 6, background: CC.abyss, borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ width: `${(f.n / maxF) * 100}%`, height: "100%", background: f.st === "Closed" ? CC.phosphor : f.st === "Under contract" ? CC.cyan : CC.signal, borderRadius: 99 }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top matched leads */}
        <div className="cc-card">
          <div className="cc-eyebrow" style={{ color: CC.phosphor }}>◈ Top auto-matched leads</div>
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {hot.length === 0 && <div style={{ fontSize: 13, color: CC.stakeDim }}>No location-matched leads yet. Every lead you add is scored against all buy boxes automatically — strong matches surface here.</div>}
            {hot.slice(0, 6).map(({ l, m }, i) => (
              <div key={i} className="cc-actionrow">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: CC.stake, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.owner || l.apn || "Unknown"}{l.acres ? ` · ${l.acres}ac` : ""}</div>
                  <div style={{ fontSize: 11.5, color: CC.stakeDim }}>fits {m.builder}</div>
                </div>
                <span className="lc-mono" style={{ fontSize: 14, fontWeight: 700, color: matchColor(m.score) }}>{m.score}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* Hot counties / tax sale clock */}
        <div className="cc-card">
          <div className="cc-eyebrow" style={{ color: CC.amber }}>⚑ Tax-sale clock</div>
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {hotCounties.length === 0 && <div style={{ fontSize: 13, color: CC.stakeDim }}>Research counties in the Delinquency Hub and upcoming tax-sale dates appear here — your sharpest outreach windows.</div>}
            {hotCounties.slice(0, 5).map((r, i) => (
              <div key={i} className="cc-actionrow">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: CC.stake }}>{r.county} County{r.state ? `, ${r.state}` : ""}</div>
                  <div style={{ fontSize: 11.5, color: CC.amber }}>{r.saleType !== "unknown" ? r.saleType + " · " : ""}{r.nextSaleDate}</div>
                </div>
              </div>
            ))}
          </div>
          {hotCounties.length > 0 && <button className="cc-launch" style={{ marginTop: 12, width: "auto", flexDirection: "row" }} onClick={() => onNavigate("delinq")}><span style={{ color: CC.amber, fontWeight: 700, fontSize: 13 }}>Open Delinquency Hub →</span></button>}
        </div>
      </div>

      {/* Quick launch grid */}
      <div style={{ padding: "0 18px 8px" }}>
        <div className="cc-eyebrow" style={{ marginBottom: 10 }}>⬡ Launch console</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
          {launches.map(([id, icon, name, desc]) => (
            <button key={id} className="cc-launch" onClick={() => onNavigate(id)}>
              <span style={{ fontSize: 18, color: CC.phosphor }}>{icon}</span>
              <span className="lc-display" style={{ fontSize: 15, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: CC.stake }}>{name}</span>
              <span style={{ fontSize: 11.5, color: CC.stakeDim, lineHeight: 1.4 }}>{desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Save status footer */}
      <div style={{ padding: "14px 18px 18px", borderTop: `1px solid ${CC.edge}`, marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="lc-mono" style={{ fontSize: 11, color: storageOk === false ? CC.amber : CC.phosphorDim }}>
          {storageOk === false ? "⚠ Auto-save unavailable here — back up before you leave." : storageOk ? "● Auto-save active. Your data persists between sessions." : "Checking storage…"}
        </span>
        <button className="cc-chip" style={{ borderColor: CC.edge, color: CC.stakeDim, background: "transparent" }} onClick={onOpenBackup}>⛁ Backup / Restore</button>
      </div>
    </div>
  );
}

/* ============================================================
   MARKET RADAR — Florida builder-demand radar on a live map.
   Hotspots are REAL data: single-family building permits per
   county (US Census Building Permits Survey — 2024 + 2025
   annual, 2026 YTD through May). Score blends volume with
   momentum (2026 pace vs 2025, and 2025 vs 2024).
   Ground truth on demand: live land-sale scan straight from
   the FL statewide cadastral (SALE_PRC1/SALE_YR1), no login.
   If map tiles are blocked (native sandbox) the radar keeps
   working on a dark grid with the embedded FL outline.
   ============================================================ */
const FL_CADASTRAL = "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0";
const FL_VACANT_UC = ["000", "00", "010", "10", "040", "40", "070", "70", "099", "99"];
const PARCEL_ZOOM = 15; // lot lines + owner cards at this zoom and deeper
const SAT_ZOOM = 13;    // auto-switch to satellite at this zoom (ground-level recon)

// FL DOR land-use codes (the ones a land wholesaler actually meets)
const DOR_LABELS = {
  "0": "Vacant residential", "1": "Single family", "2": "Mobile home", "3": "Multi-family",
  "4": "Condo", "8": "Multi-family <10", "10": "Vacant commercial", "40": "Vacant industrial",
  "50": "Cropland", "60": "Grazing land", "66": "Orchard/grove", "70": "Vacant institutional",
  "99": "Acreage — non-agricultural",
};
function dorLabel(uc) {
  const raw = String(uc == null ? "" : uc).trim();
  if (!raw) return "";
  const key = String(parseInt(raw, 10));
  return DOR_LABELS[key] || `Use code ${raw}`;
}

// Point-in-polygon (ray cast) for picking the parcel under a geocoded address
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function featureContains(feat, lng, lat) {
  const g = feat && feat.geometry; if (!g) return false;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return polys.some((rings) => rings.length && pointInRing(lng, lat, rings[0]) && rings.slice(1).every((h) => !pointInRing(lng, lat, h)));
}
function featureRoughCenter(feat) {
  const g = feat && feat.geometry; if (!g) return null;
  const ring = g.type === "Polygon" ? g.coordinates[0] : g.type === "MultiPolygon" ? g.coordinates[0][0] : null;
  if (!ring || !ring.length) return null;
  let sx = 0, sy = 0;
  ring.forEach((pt) => { sx += pt[0]; sy += pt[1]; });
  return [sx / ring.length, sy / ring.length];
}

// Does this search look like a specific lot (APN or street address) vs a market?
function looksLikeLotQuery(s) {
  const t = String(s || "").trim();
  if (!t) return false;
  if (/^\d+\s+[A-Za-z]/.test(t)) return true; // "5421 Kemkerry Rd" — street address
  if (/\b(rd|road|st|street|ave|avenue|dr|drive|ln|lane|blvd|hwy|way|ct|court|cir|circle|ter|terrace|trl|trail|pkwy|loop)\b/i.test(t)) return true;
  const digits = (t.match(/\d/g) || []).length;
  return digits >= 6 && !/county/i.test(t); // APN-ish: lots of digits, not a county name
}

// Nearest county centroid → county tag for leads (approx is fine; leads are editable)
function nearestFLCounty(lat, lng) {
  let best = null, bd = Infinity;
  RADAR_PERMITS.forEach((c) => {
    if (c.st !== "FL") return;
    const d = (c.lat - lat) * (c.lat - lat) + (c.lng - lng) * (c.lng - lng);
    if (d < bd) { bd = d; best = c; }
  });
  return best ? best.n : "";
}

// st = state · f = county FIPS suffix · u24/u25 = SF permits full year · u26 = Jan–May 2026 YTD
const RADAR_PERMITS = [{"st":"TX","f":"201","n":"Harris","lat":29.8573,"lng":-95.393,"u24":20069,"u25":16893,"u26":7479},{"st":"TX","f":"339","n":"Montgomery","lat":30.2988,"lng":-95.5029,"u24":11599,"u25":11585,"u26":4982},{"st":"TX","f":"085","n":"Collin","lat":33.1945,"lng":-96.5794,"u24":15047,"u25":11186,"u26":4216},{"st":"FL","f":"071","n":"Lee","lat":26.5633,"lng":-81.9842,"u24":10554,"u25":9962,"u26":3034},{"st":"TX","f":"157","n":"Fort Bend","lat":29.5266,"lng":-95.771,"u24":11276,"u25":9520,"u26":4040},{"st":"TX","f":"439","n":"Tarrant","lat":32.7721,"lng":-97.2912,"u24":9458,"u25":8725,"u26":4154},{"st":"NC","f":"183","n":"Wake","lat":35.7898,"lng":-78.6506,"u24":9621,"u25":8399,"u26":3570},{"st":"FL","f":"081","n":"Manatee","lat":27.4756,"lng":-82.3931,"u24":5630,"u25":7011,"u26":2899},{"st":"FL","f":"105","n":"Polk","lat":27.9537,"lng":-81.6935,"u24":8514,"u25":6557,"u26":2930},{"st":"FL","f":"101","n":"Pasco","lat":28.3098,"lng":-82.511,"u24":5481,"u25":6313,"u26":2705},{"st":"TX","f":"121","n":"Denton","lat":33.2051,"lng":-97.1211,"u24":7400,"u25":6095,"u26":2921},{"st":"FL","f":"083","n":"Marion","lat":29.2028,"lng":-82.0431,"u24":6409,"u25":5420,"u26":2761},{"st":"FL","f":"097","n":"Osceola","lat":28.059,"lng":-81.1393,"u24":5643,"u25":5085,"u26":1419},{"st":"TX","f":"453","n":"Travis","lat":30.2395,"lng":-97.6913,"u24":4830,"u25":4946,"u26":2333},{"st":"TX","f":"113","n":"Dallas","lat":32.767,"lng":-96.7784,"u24":5516,"u25":4607,"u26":1918},{"st":"TX","f":"029","n":"Bexar","lat":29.4487,"lng":-98.5201,"u24":5774,"u25":4528,"u26":2200},{"st":"TX","f":"215","n":"Hidalgo","lat":26.3964,"lng":-98.181,"u24":4391,"u25":4527,"u26":1953},{"st":"NC","f":"019","n":"Brunswick","lat":34.0388,"lng":-78.2278,"u24":5118,"u25":4454,"u26":2161},{"st":"FL","f":"057","n":"Hillsborough","lat":27.8932,"lng":-82.38,"u24":4402,"u25":4295,"u26":1766},{"st":"FL","f":"115","n":"Sarasota","lat":27.2253,"lng":-82.4237,"u24":5259,"u25":4283,"u26":1684},{"st":"TX","f":"491","n":"Williamson","lat":30.6491,"lng":-97.6051,"u24":5994,"u25":4272,"u26":1890},{"st":"FL","f":"095","n":"Orange","lat":28.5144,"lng":-81.3233,"u24":4811,"u25":4219,"u26":1774},{"st":"FL","f":"069","n":"Lake","lat":28.7641,"lng":-81.7123,"u24":3956,"u25":3925,"u26":1691},{"st":"TX","f":"209","n":"Hays","lat":30.0612,"lng":-98.0293,"u24":3763,"u25":3756,"u26":1773},{"st":"NC","f":"119","n":"Mecklenburg","lat":35.2469,"lng":-80.8338,"u24":6496,"u25":3747,"u26":247},{"st":"FL","f":"031","n":"Duval","lat":30.3352,"lng":-81.6481,"u24":5138,"u25":3728,"u26":1630},{"st":"FL","f":"109","n":"St. Johns","lat":29.8905,"lng":-81.4,"u24":4915,"u25":3554,"u26":1231},{"st":"FL","f":"111","n":"St. Lucie","lat":27.3798,"lng":-80.4435,"u24":4570,"u25":3467,"u26":1320},{"st":"FL","f":"009","n":"Brevard","lat":28.2983,"lng":-80.7003,"u24":3888,"u25":3376,"u26":1411},{"st":"FL","f":"119","n":"Sumter","lat":28.7133,"lng":-82.0695,"u24":3537,"u25":3105,"u26":1635},{"st":"TX","f":"039","n":"Brazoria","lat":29.1678,"lng":-95.4346,"u24":3362,"u25":3007,"u26":1251},{"st":"TX","f":"139","n":"Ellis","lat":32.3469,"lng":-96.7969,"u24":2898,"u25":2980,"u26":1079},{"st":"NC","f":"067","n":"Forsyth","lat":36.1325,"lng":-80.257,"u24":2537,"u25":2863,"u26":1223},{"st":"NC","f":"063","n":"Durham","lat":36.0338,"lng":-78.8781,"u24":1912,"u25":2790,"u26":1403},{"st":"TN","f":"037","n":"Davidson","lat":36.1691,"lng":-86.7848,"u24":2712,"u25":2738,"u26":817},{"st":"NC","f":"101","n":"Johnston","lat":35.5134,"lng":-78.3673,"u24":2775,"u25":2633,"u26":1102},{"st":"FL","f":"015","n":"Charlotte","lat":26.9064,"lng":-82.0037,"u24":3583,"u25":2571,"u26":1374},{"st":"TN","f":"093","n":"Knox","lat":35.9927,"lng":-83.9377,"u24":2544,"u25":2566,"u26":1182},{"st":"FL","f":"099","n":"Palm Beach","lat":26.6491,"lng":-80.4484,"u24":2811,"u25":2549,"u26":1337},{"st":"TN","f":"149","n":"Rutherford","lat":35.8434,"lng":-86.4172,"u24":2997,"u25":2533,"u26":1170},{"st":"TX","f":"167","n":"Galveston","lat":29.2339,"lng":-94.8882,"u24":3258,"u25":2514,"u26":1178},{"st":"NC","f":"179","n":"Union","lat":34.9918,"lng":-80.5304,"u24":2167,"u25":2387,"u26":961},{"st":"FL","f":"086","n":"Miami-Dade","lat":25.616,"lng":-80.5037,"u24":1990,"u25":2167,"u26":960},{"st":"NC","f":"085","n":"Harnett","lat":35.3687,"lng":-78.8717,"u24":2068,"u25":2166,"u26":847},{"st":"NC","f":"071","n":"Gaston","lat":35.2928,"lng":-81.1774,"u24":1923,"u25":2153,"u26":858},{"st":"TX","f":"027","n":"Bell","lat":31.0427,"lng":-97.4813,"u24":2618,"u25":2107,"u26":999},{"st":"FL","f":"017","n":"Citrus","lat":28.8503,"lng":-82.5956,"u24":2415,"u25":2082,"u26":712},{"st":"FL","f":"127","n":"Volusia","lat":29.0578,"lng":-81.1618,"u24":2701,"u25":2073,"u26":779},{"st":"TX","f":"303","n":"Lubbock","lat":33.6115,"lng":-101.8199,"u24":1921,"u25":2036,"u26":901},{"st":"FL","f":"035","n":"Flagler","lat":29.4749,"lng":-81.2863,"u24":2384,"u25":1950,"u26":754},{"st":"FL","f":"021","n":"Collier","lat":26.1188,"lng":-81.401,"u24":2486,"u25":1945,"u26":880},{"st":"TX","f":"251","n":"Johnson","lat":32.3797,"lng":-97.3649,"u24":1948,"u25":1867,"u26":977},{"st":"FL","f":"113","n":"Santa Rosa","lat":30.6753,"lng":-87.0189,"u24":1851,"u25":1864,"u26":907},{"st":"TX","f":"141","n":"El Paso","lat":31.7665,"lng":-106.2415,"u24":1953,"u25":1813,"u26":800},{"st":"TX","f":"061","n":"Cameron","lat":26.1029,"lng":-97.479,"u24":1659,"u25":1797,"u26":761},{"st":"NC","f":"081","n":"Guilford","lat":36.0791,"lng":-79.7887,"u24":1440,"u25":1738,"u26":667},{"st":"FL","f":"053","n":"Hernando","lat":28.556,"lng":-82.526,"u24":2187,"u25":1733,"u26":720},{"st":"TX","f":"091","n":"Comal","lat":29.8124,"lng":-98.2581,"u24":2253,"u25":1726,"u26":812},{"st":"TN","f":"189","n":"Wilson","lat":36.1494,"lng":-86.2912,"u24":1905,"u25":1723,"u26":689},{"st":"TX","f":"041","n":"Brazos","lat":30.6567,"lng":-96.3024,"u24":1378,"u25":1687,"u26":717},{"st":"NC","f":"001","n":"Alamance","lat":36.044,"lng":-79.4006,"u24":1999,"u25":1674,"u26":749},{"st":"FL","f":"005","n":"Bay","lat":30.1591,"lng":-85.5344,"u24":1886,"u25":1667,"u26":703},{"st":"TN","f":"125","n":"Montgomery","lat":36.5004,"lng":-87.3809,"u24":1842,"u25":1635,"u26":783},{"st":"TX","f":"397","n":"Rockwall","lat":32.8999,"lng":-96.412,"u24":1810,"u25":1587,"u26":741},{"st":"TN","f":"165","n":"Sumner","lat":36.4724,"lng":-86.4584,"u24":1608,"u25":1568,"u26":593},{"st":"TX","f":"021","n":"Bastrop","lat":30.1008,"lng":-97.3106,"u24":1419,"u25":1546,"u26":600},{"st":"TX","f":"187","n":"Guadalupe","lat":29.5827,"lng":-97.949,"u24":1907,"u25":1544,"u26":674},{"st":"TX","f":"355","n":"Nueces","lat":27.74,"lng":-97.5162,"u24":1336,"u25":1489,"u26":582},{"st":"NC","f":"097","n":"Iredell","lat":35.8063,"lng":-80.8745,"u24":1827,"u25":1447,"u26":576},{"st":"FL","f":"131","n":"Walton","lat":30.5712,"lng":-86.1628,"u24":1549,"u25":1427,"u26":827},{"st":"TN","f":"065","n":"Hamilton","lat":35.1635,"lng":-85.2018,"u24":1540,"u25":1379,"u26":766},{"st":"FL","f":"033","n":"Escambia","lat":30.53,"lng":-87.3203,"u24":1463,"u25":1366,"u26":879},{"st":"NC","f":"025","n":"Cabarrus","lat":35.3883,"lng":-80.5527,"u24":1768,"u25":1358,"u26":684},{"st":"NC","f":"035","n":"Catawba","lat":35.6619,"lng":-81.2149,"u24":1651,"u25":1353,"u26":922},{"st":"FL","f":"103","n":"Pinellas","lat":27.9053,"lng":-82.7981,"u24":1184,"u25":1327,"u26":603},{"st":"NC","f":"133","n":"Onslow","lat":34.7631,"lng":-77.4995,"u24":1213,"u25":1318,"u26":638},{"st":"TN","f":"119","n":"Maury","lat":35.6157,"lng":-87.0778,"u24":1560,"u25":1318,"u26":635},{"st":"TX","f":"329","n":"Midland","lat":31.8143,"lng":-102.0025,"u24":1504,"u25":1317,"u26":304},{"st":"TN","f":"187","n":"Williamson","lat":35.8948,"lng":-86.8979,"u24":1357,"u25":1286,"u26":494},{"st":"FL","f":"019","n":"Clay","lat":29.9866,"lng":-81.865,"u24":1859,"u25":1240,"u26":594},{"st":"NC","f":"129","n":"New Hanover","lat":34.1834,"lng":-77.8642,"u24":1296,"u25":1208,"u26":502},{"st":"TX","f":"181","n":"Grayson","lat":33.6245,"lng":-96.6758,"u24":1492,"u25":1184,"u26":498},{"st":"NC","f":"147","n":"Pitt","lat":35.5925,"lng":-77.3727,"u24":1059,"u25":1084,"u26":255},{"st":"TX","f":"291","n":"Liberty","lat":30.1585,"lng":-94.8441,"u24":1319,"u25":1084,"u26":395},{"st":"NC","f":"125","n":"Moore","lat":35.3083,"lng":-79.4927,"u24":941,"u25":1043,"u26":415},{"st":"TX","f":"257","n":"Kaufman","lat":32.5989,"lng":-96.2884,"u24":1559,"u25":1029,"u26":475},{"st":"TX","f":"479","n":"Webb","lat":27.7608,"lng":-99.3408,"u24":1154,"u25":1029,"u26":447},{"st":"TN","f":"155","n":"Sevier","lat":35.7878,"lng":-83.5249,"u24":1104,"u25":1011,"u26":323},{"st":"NC","f":"021","n":"Buncombe","lat":35.6094,"lng":-82.5304,"u24":1448,"u25":993,"u26":466},{"st":"FL","f":"091","n":"Okaloosa","lat":30.6143,"lng":-86.5911,"u24":1053,"u25":987,"u26":511},{"st":"NC","f":"159","n":"Rowan","lat":35.6414,"lng":-80.5217,"u24":585,"u25":943,"u26":462},{"st":"NC","f":"057","n":"Davidson","lat":35.7951,"lng":-80.2071,"u24":920,"u25":941,"u26":481},{"st":"TN","f":"157","n":"Shelby","lat":35.1846,"lng":-89.8946,"u24":972,"u25":936,"u26":542},{"st":"TX","f":"135","n":"Ector","lat":31.8653,"lng":-102.5425,"u24":1004,"u25":921,"u26":538},{"st":"FL","f":"117","n":"Seminole","lat":28.6901,"lng":-81.132,"u24":763,"u25":895,"u26":330},{"st":"FL","f":"089","n":"Nassau","lat":30.606,"lng":-81.7651,"u24":927,"u25":887,"u26":360},{"st":"NC","f":"191","n":"Wayne","lat":35.3542,"lng":-78.0087,"u24":583,"u25":879,"u26":363},{"st":"FL","f":"085","n":"Martin","lat":27.0836,"lng":-80.3982,"u24":538,"u25":843,"u26":528},{"st":"NC","f":"051","n":"Cumberland","lat":35.0502,"lng":-78.8287,"u24":1013,"u25":825,"u26":245},{"st":"TN","f":"147","n":"Robertson","lat":36.5244,"lng":-86.8726,"u24":983,"u25":821,"u26":350},{"st":"NC","f":"109","n":"Lincoln","lat":35.4885,"lng":-81.2269,"u24":697,"u25":785,"u26":306},{"st":"TX","f":"309","n":"McLennan","lat":31.5496,"lng":-97.2015,"u24":720,"u25":764,"u26":333},{"st":"TN","f":"009","n":"Blount","lat":35.6882,"lng":-83.923,"u24":834,"u25":763,"u26":348},{"st":"FL","f":"073","n":"Leon","lat":30.4593,"lng":-84.2778,"u24":768,"u25":737,"u26":280},{"st":"NC","f":"069","n":"Franklin","lat":36.0882,"lng":-78.2831,"u24":948,"u25":735,"u26":430},{"st":"FL","f":"011","n":"Broward","lat":26.1935,"lng":-80.4767,"u24":757,"u25":730,"u26":315},{"st":"TX","f":"441","n":"Taylor","lat":32.2971,"lng":-99.8904,"u24":412,"u25":726,"u26":466},{"st":"NC","f":"141","n":"Pender","lat":34.5126,"lng":-77.8881,"u24":867,"u25":716,"u26":291},{"st":"FL","f":"001","n":"Alachua","lat":29.6757,"lng":-82.3572,"u24":784,"u25":711,"u26":279},{"st":"FL","f":"055","n":"Highlands","lat":27.3411,"lng":-81.3424,"u24":846,"u25":706,"u26":269},{"st":"TX","f":"053","n":"Burnet","lat":30.7896,"lng":-98.2012,"u24":815,"u25":695,"u26":279},{"st":"TN","f":"011","n":"Bradley","lat":35.1539,"lng":-84.8594,"u24":714,"u25":694,"u26":315},{"st":"NC","f":"089","n":"Henderson","lat":35.3364,"lng":-82.4796,"u24":976,"u25":686,"u26":224},{"st":"TX","f":"373","n":"Polk","lat":30.7846,"lng":-94.8373,"u24":765,"u25":678,"u26":292},{"st":"NC","f":"105","n":"Lee","lat":35.4763,"lng":-79.1721,"u24":602,"u25":674,"u26":288},{"st":"TN","f":"179","n":"Washington","lat":36.2957,"lng":-82.495,"u24":686,"u25":662,"u26":279},{"st":"TX","f":"071","n":"Chambers","lat":29.6964,"lng":-94.6694,"u24":629,"u25":583,"u26":181},{"st":"TN","f":"141","n":"Putnam","lat":36.1409,"lng":-85.4962,"u24":592,"u25":577,"u26":211},{"st":"NC","f":"093","n":"Hoke","lat":35.0172,"lng":-79.242,"u24":681,"u25":554,"u26":184},{"st":"NC","f":"049","n":"Craven","lat":35.1168,"lng":-77.0813,"u24":466,"u25":553,"u26":220},{"st":"TN","f":"105","n":"Loudon","lat":35.7351,"lng":-84.3141,"u24":599,"u25":551,"u26":197},{"st":"TX","f":"375","n":"Potter","lat":35.3987,"lng":-101.8938,"u24":562,"u25":529,"u26":280},{"st":"TX","f":"423","n":"Smith","lat":32.3751,"lng":-95.2689,"u24":451,"u25":527,"u26":225},{"st":"TX","f":"407","n":"San Jacinto","lat":30.5744,"lng":-95.1631,"u24":575,"u25":519,"u26":224},{"st":"FL","f":"129","n":"Wakulla","lat":30.0913,"lng":-84.3591,"u24":468,"u25":518,"u26":172},{"st":"NC","f":"037","n":"Chatham","lat":35.705,"lng":-79.2515,"u24":458,"u25":517,"u26":219},{"st":"NC","f":"027","n":"Caldwell","lat":35.9664,"lng":-81.5125,"u24":217,"u25":499,"u26":126},{"st":"NC","f":"127","n":"Nash","lat":35.9659,"lng":-77.9876,"u24":500,"u25":483,"u26":187},{"st":"TX","f":"471","n":"Walker","lat":30.7432,"lng":-95.5698,"u24":522,"u25":483,"u26":212},{"st":"NC","f":"151","n":"Randolph","lat":35.7099,"lng":-79.8062,"u24":553,"u25":482,"u26":227},{"st":"NC","f":"023","n":"Burke","lat":35.7462,"lng":-81.7062,"u24":322,"u25":479,"u26":158},{"st":"NC","f":"031","n":"Carteret","lat":34.8583,"lng":-76.5359,"u24":559,"u25":475,"u26":178},{"st":"FL","f":"051","n":"Hendry","lat":26.54,"lng":-81.1521,"u24":508,"u25":464,"u26":158},{"st":"TX","f":"349","n":"Navarro","lat":32.0484,"lng":-96.4769,"u24":511,"u25":459,"u26":202},{"st":"TX","f":"231","n":"Hunt","lat":33.1233,"lng":-96.0842,"u24":758,"u25":451,"u26":131},{"st":"TN","f":"163","n":"Sullivan","lat":36.5097,"lng":-82.3013,"u24":423,"u25":447,"u26":246},{"st":"TX","f":"055","n":"Caldwell","lat":29.8324,"lng":-97.6281,"u24":515,"u25":437,"u26":159},{"st":"TN","f":"031","n":"Coffee","lat":35.4888,"lng":-86.0782,"u24":338,"u25":434,"u26":179},{"st":"TX","f":"409","n":"San Patricio","lat":28.0118,"lng":-97.5172,"u24":344,"u25":427,"u26":207},{"st":"NC","f":"045","n":"Cleveland","lat":35.3346,"lng":-81.5571,"u24":411,"u25":396,"u26":174},{"st":"TN","f":"043","n":"Dickson","lat":36.1455,"lng":-87.3642,"u24":353,"u25":391,"u26":183},{"st":"TX","f":"497","n":"Wise","lat":33.2193,"lng":-97.653,"u24":214,"u25":390,"u26":233},{"st":"TN","f":"145","n":"Roane","lat":35.8473,"lng":-84.5239,"u24":224,"u25":380,"u26":141},{"st":"TN","f":"003","n":"Bedford","lat":35.5137,"lng":-86.4583,"u24":622,"u25":377,"u26":138},{"st":"TX","f":"199","n":"Hardin","lat":30.3296,"lng":-94.3932,"u24":358,"u25":373,"u26":154},{"st":"NC","f":"195","n":"Wilson","lat":35.7004,"lng":-77.9216,"u24":398,"u25":357,"u26":131},{"st":"TX","f":"259","n":"Kendall","lat":29.9435,"lng":-98.7093,"u24":517,"u25":357,"u26":228},{"st":"TN","f":"047","n":"Fayette","lat":35.197,"lng":-89.4138,"u24":222,"u25":356,"u26":213},{"st":"TX","f":"473","n":"Waller","lat":30.0136,"lng":-95.9821,"u24":354,"u25":341,"u26":124},{"st":"NC","f":"167","n":"Stanly","lat":35.3104,"lng":-80.2544,"u24":367,"u25":336,"u26":139},{"st":"NC","f":"053","n":"Currituck","lat":36.3722,"lng":-75.9412,"u24":429,"u25":335,"u26":185},{"st":"TX","f":"451","n":"Tom Green","lat":31.3983,"lng":-100.4638,"u24":231,"u25":333,"u26":141},{"st":"NC","f":"157","n":"Rockingham","lat":36.3818,"lng":-79.7828,"u24":344,"u25":332,"u26":162},{"st":"TN","f":"089","n":"Jefferson","lat":36.0485,"lng":-83.4412,"u24":244,"u25":329,"u26":123},{"st":"NC","f":"055","n":"Dare","lat":35.6063,"lng":-75.7675,"u24":371,"u25":325,"u26":149},{"st":"TX","f":"245","n":"Jefferson","lat":29.854,"lng":-94.1493,"u24":335,"u25":325,"u26":101},{"st":"TN","f":"001","n":"Anderson","lat":36.1167,"lng":-84.1954,"u24":281,"u25":317,"u26":158},{"st":"TN","f":"051","n":"Franklin","lat":35.1559,"lng":-86.0992,"u24":387,"u25":316,"u26":150},{"st":"TX","f":"099","n":"Coryell","lat":31.3912,"lng":-97.798,"u24":292,"u25":313,"u26":122},{"st":"TX","f":"367","n":"Parker","lat":32.7771,"lng":-97.8059,"u24":437,"u25":313,"u26":161},{"st":"NC","f":"087","n":"Haywood","lat":35.5589,"lng":-82.9813,"u24":373,"u25":312,"u26":158},{"st":"FL","f":"045","n":"Gulf","lat":29.8592,"lng":-85.272,"u24":302,"u25":302,"u26":177},{"st":"TN","f":"117","n":"Marshall","lat":35.4683,"lng":-86.7659,"u24":319,"u25":299,"u26":138},{"st":"TX","f":"015","n":"Austin","lat":29.8919,"lng":-96.2702,"u24":410,"u25":297,"u26":140},{"st":"NC","f":"135","n":"Orange","lat":36.0625,"lng":-79.12,"u24":325,"u25":292,"u26":160},{"st":"NC","f":"155","n":"Robeson","lat":34.6392,"lng":-79.1009,"u24":335,"u25":291,"u26":119},{"st":"TN","f":"059","n":"Greene","lat":36.1795,"lng":-82.8475,"u24":261,"u25":283,"u26":97},{"st":"TN","f":"021","n":"Cheatham","lat":36.2552,"lng":-87.1008,"u24":271,"u25":281,"u26":70},{"st":"NC","f":"077","n":"Granville","lat":36.2999,"lng":-78.6576,"u24":308,"u25":253,"u26":118},{"st":"NC","f":"169","n":"Stokes","lat":36.3938,"lng":-80.2699,"u24":230,"u25":251,"u26":103},{"st":"TX","f":"321","n":"Matagorda","lat":28.7748,"lng":-96.0015,"u24":153,"u25":251,"u26":94},{"st":"TX","f":"221","n":"Hood","lat":32.4301,"lng":-97.8317,"u24":125,"u25":247,"u26":133},{"st":"TX","f":"013","n":"Atascosa","lat":28.8915,"lng":-98.5354,"u24":224,"u25":242,"u26":83},{"st":"NC","f":"185","n":"Warren","lat":36.3981,"lng":-78.0999,"u24":255,"u25":240,"u26":87},{"st":"NC","f":"039","n":"Cherokee","lat":35.1371,"lng":-84.0614,"u24":232,"u25":239,"u26":91},{"st":"NC","f":"113","n":"Macon","lat":35.153,"lng":-83.4219,"u24":218,"u25":239,"u26":95},{"st":"FL","f":"075","n":"Levy","lat":29.2719,"lng":-82.8312,"u24":199,"u25":236,"u26":52},{"st":"NC","f":"171","n":"Surry","lat":36.4154,"lng":-80.6865,"u24":241,"u25":236,"u26":108},{"st":"TN","f":"113","n":"Madison","lat":35.6061,"lng":-88.8334,"u24":247,"u25":236,"u26":106},{"st":"TN","f":"177","n":"Warren","lat":35.6782,"lng":-85.7773,"u24":259,"u25":235,"u26":116},{"st":"NC","f":"099","n":"Jackson","lat":35.2855,"lng":-83.124,"u24":254,"u25":232,"u26":113},{"st":"NC","f":"189","n":"Watauga","lat":36.2354,"lng":-81.7099,"u24":268,"u25":231,"u26":113},{"st":"FL","f":"087","n":"Monroe","lat":25.5861,"lng":-81.0226,"u24":265,"u25":228,"u26":93},{"st":"FL","f":"133","n":"Washington","lat":30.6021,"lng":-85.6558,"u24":217,"u25":223,"u26":103},{"st":"TN","f":"063","n":"Hamblen","lat":36.2184,"lng":-83.2661,"u24":215,"u25":216,"u26":78},{"st":"NC","f":"161","n":"Rutherford","lat":35.4027,"lng":-81.9196,"u24":191,"u25":203,"u26":90},{"st":"TN","f":"115","n":"Marion","lat":35.1276,"lng":-85.6074,"u24":225,"u25":199,"u26":125},{"st":"TX","f":"477","n":"Washington","lat":30.2151,"lng":-96.4103,"u24":107,"u25":194,"u26":59},{"st":"NC","f":"009","n":"Ashe","lat":36.4435,"lng":-81.4993,"u24":190,"u25":193,"u26":82},{"st":"TX","f":"007","n":"Aransas","lat":28.1226,"lng":-96.9675,"u24":204,"u25":187,"u26":82},{"st":"FL","f":"061","n":"Indian River","lat":27.7005,"lng":-80.5748,"u24":281,"u25":178,"u26":70},{"st":"NC","f":"123","n":"Montgomery","lat":35.3275,"lng":-79.9108,"u24":138,"u25":176,"u26":62},{"st":"TX","f":"183","n":"Gregg","lat":32.4864,"lng":-94.8163,"u24":167,"u25":176,"u26":79},{"st":"NC","f":"175","n":"Transylvania","lat":35.2101,"lng":-82.8167,"u24":207,"u25":172,"u26":71},{"st":"NC","f":"059","n":"Davie","lat":35.9294,"lng":-80.5426,"u24":185,"u25":171,"u26":69},{"st":"TN","f":"019","n":"Carter","lat":36.2847,"lng":-82.1266,"u24":184,"u25":165,"u26":66},{"st":"TN","f":"111","n":"Macon","lat":36.5378,"lng":-86.001,"u24":171,"u25":165,"u26":75},{"st":"TN","f":"123","n":"Monroe","lat":35.4478,"lng":-84.2497,"u24":151,"u25":165,"u26":89},{"st":"NC","f":"111","n":"McDowell","lat":35.6823,"lng":-82.048,"u24":175,"u25":164,"u26":69},{"st":"FL","f":"023","n":"Columbia","lat":30.2217,"lng":-82.6234,"u24":174,"u25":163,"u26":76},{"st":"TN","f":"185","n":"White","lat":35.927,"lng":-85.4558,"u24":209,"u25":163,"u26":94},{"st":"FL","f":"027","n":"DeSoto","lat":27.1906,"lng":-81.8063,"u24":71,"u25":159,"u26":79},{"st":"TX","f":"049","n":"Brown","lat":31.7641,"lng":-98.9985,"u24":138,"u25":159,"u26":59},{"st":"TX","f":"213","n":"Henderson","lat":32.2116,"lng":-95.8534,"u24":247,"u25":159,"u26":71},{"st":"NC","f":"139","n":"Pasquotank","lat":36.2652,"lng":-76.2607,"u24":153,"u25":156,"u26":128},{"st":"TN","f":"173","n":"Union","lat":36.2841,"lng":-83.8361,"u24":134,"u25":154,"u26":45},{"st":"NC","f":"193","n":"Wilkes","lat":36.2089,"lng":-81.1661,"u24":134,"u25":153,"u26":52},{"st":"TN","f":"013","n":"Campbell","lat":36.4016,"lng":-84.1592,"u24":111,"u25":151,"u26":46},{"st":"TN","f":"103","n":"Lincoln","lat":35.1428,"lng":-86.5934,"u24":169,"u25":150,"u26":68},{"st":"TN","f":"139","n":"Polk","lat":35.1094,"lng":-84.5411,"u24":211,"u25":150,"u26":81},{"st":"TX","f":"361","n":"Orange","lat":30.1223,"lng":-93.8941,"u24":163,"u25":149,"u26":99},{"st":"NC","f":"145","n":"Person","lat":36.3864,"lng":-78.9656,"u24":113,"u25":145,"u26":62},{"st":"NC","f":"029","n":"Camden","lat":36.3423,"lng":-76.1625,"u24":105,"u25":144,"u26":85},{"st":"TN","f":"041","n":"DeKalb","lat":35.9822,"lng":-85.8336,"u24":143,"u25":144,"u26":69},{"st":"TN","f":"073","n":"Hawkins","lat":36.4521,"lng":-82.9315,"u24":151,"u25":144,"u26":64},{"st":"TN","f":"159","n":"Smith","lat":36.2566,"lng":-85.9419,"u24":131,"u25":144,"u26":53},{"st":"NC","f":"149","n":"Polk","lat":35.2779,"lng":-82.1676,"u24":143,"u25":141,"u26":58},{"st":"TN","f":"143","n":"Rhea","lat":35.6006,"lng":-84.9495,"u24":158,"u25":140,"u26":88},{"st":"TX","f":"005","n":"Angelina","lat":31.2519,"lng":-94.6111,"u24":98,"u25":139,"u26":52},{"st":"TN","f":"167","n":"Tipton","lat":35.4988,"lng":-89.7471,"u24":177,"u25":136,"u26":61},{"st":"FL","f":"121","n":"Suwannee","lat":30.1892,"lng":-82.9928,"u24":138,"u25":134,"u26":45},{"st":"TN","f":"053","n":"Gibson","lat":35.9916,"lng":-88.9338,"u24":153,"u25":129,"u26":80},{"st":"NC","f":"107","n":"Lenoir","lat":35.2401,"lng":-77.6355,"u24":148,"u25":127,"u26":59},{"st":"NC","f":"011","n":"Avery","lat":36.0721,"lng":-81.9203,"u24":95,"u25":126,"u26":56},{"st":"TX","f":"485","n":"Wichita","lat":33.9882,"lng":-98.708,"u24":205,"u25":126,"u26":63},{"st":"FL","f":"063","n":"Jackson","lat":30.7892,"lng":-85.2088,"u24":113,"u25":122,"u26":54},{"st":"TX","f":"493","n":"Wilson","lat":29.1739,"lng":-98.0867,"u24":135,"u25":122,"u26":51},{"st":"TX","f":"057","n":"Calhoun","lat":28.4417,"lng":-96.5796,"u24":95,"u25":120,"u26":35},{"st":"NC","f":"013","n":"Beaufort","lat":35.4823,"lng":-76.842,"u24":216,"u25":119,"u26":54},{"st":"NC","f":"061","n":"Duplin","lat":34.9344,"lng":-77.9335,"u24":120,"u25":117,"u26":79},{"st":"NC","f":"115","n":"Madison","lat":35.8642,"lng":-82.7126,"u24":200,"u25":117,"u26":76},{"st":"NC","f":"163","n":"Sampson","lat":34.9893,"lng":-78.3713,"u24":189,"u25":117,"u26":62},{"st":"TN","f":"081","n":"Hickman","lat":35.8023,"lng":-87.4671,"u24":121,"u25":117,"u26":53},{"st":"TX","f":"481","n":"Wharton","lat":29.2785,"lng":-96.2297,"u24":146,"u25":117,"u26":62},{"st":"NC","f":"197","n":"Yadkin","lat":36.1588,"lng":-80.6652,"u24":132,"u25":116,"u26":49},{"st":"NC","f":"181","n":"Vance","lat":36.3655,"lng":-78.4054,"u24":73,"u25":115,"u26":37},{"st":"FL","f":"037","n":"Franklin","lat":29.6778,"lng":-84.8152,"u24":113,"u25":112,"u26":66},{"st":"NC","f":"199","n":"Yancey","lat":35.8893,"lng":-82.304,"u24":100,"u25":109,"u26":79},{"st":"NC","f":"043","n":"Clay","lat":35.053,"lng":-83.7523,"u24":137,"u25":108,"u26":42},{"st":"NC","f":"003","n":"Alexander","lat":35.921,"lng":-81.1775,"u24":113,"u25":103,"u26":44},{"st":"TN","f":"035","n":"Cumberland","lat":35.9524,"lng":-84.9948,"u24":114,"u25":102,"u26":33},{"st":"TX","f":"059","n":"Callahan","lat":32.2931,"lng":-99.3722,"u24":11,"u25":102,"u26":37},{"st":"TX","f":"299","n":"Llano","lat":30.7076,"lng":-98.6847,"u24":117,"u25":102,"u26":41},{"st":"FL","f":"003","n":"Baker","lat":30.3244,"lng":-82.3023,"u24":99,"u25":99,"u26":57},{"st":"FL","f":"043","n":"Glades","lat":26.9548,"lng":-81.1908,"u24":65,"u25":98,"u26":66},{"st":"NC","f":"137","n":"Pamlico","lat":35.1476,"lng":-76.6653,"u24":107,"u25":97,"u26":24},{"st":"TX","f":"265","n":"Kerr","lat":30.06,"lng":-99.3533,"u24":98,"u25":96,"u26":62},{"st":"FL","f":"041","n":"Gilchrist","lat":29.7235,"lng":-82.7958,"u24":94,"u25":94,"u26":21},{"st":"TN","f":"055","n":"Giles","lat":35.2027,"lng":-87.0353,"u24":67,"u25":94,"u26":39},{"st":"NC","f":"017","n":"Bladen","lat":34.5919,"lng":-78.5395,"u24":159,"u25":93,"u26":14},{"st":"TN","f":"015","n":"Cannon","lat":35.8084,"lng":-86.0624,"u24":157,"u25":92,"u26":34},{"st":"TN","f":"121","n":"Meigs","lat":35.5122,"lng":-84.8161,"u24":94,"u25":90,"u26":42},{"st":"TN","f":"169","n":"Trousdale","lat":36.393,"lng":-86.1567,"u24":89,"u25":89,"u26":40},{"st":"FL","f":"107","n":"Putnam","lat":29.5939,"lng":-81.732,"u24":113,"u25":88,"u26":21},{"st":"FL","f":"049","n":"Hardee","lat":27.4928,"lng":-81.8216,"u24":101,"u25":86,"u26":55},{"st":"NC","f":"173","n":"Swain","lat":35.5688,"lng":-83.4656,"u24":73,"u25":84,"u26":31},{"st":"NC","f":"005","n":"Alleghany","lat":36.4894,"lng":-81.1323,"u24":91,"u25":82,"u26":46},{"st":"TN","f":"025","n":"Claiborne","lat":36.5016,"lng":-83.6607,"u24":98,"u25":82,"u26":41},{"st":"TX","f":"381","n":"Randall","lat":34.9625,"lng":-101.8955,"u24":39,"u25":80,"u26":21},{"st":"TN","f":"045","n":"Dyer","lat":36.0542,"lng":-89.3983,"u24":68,"u25":75,"u26":33},{"st":"TX","f":"097","n":"Cooke","lat":33.6392,"lng":-97.2103,"u24":178,"u25":75,"u26":17},{"st":"TX","f":"467","n":"Van Zandt","lat":32.5588,"lng":-95.8369,"u24":45,"u25":74,"u26":29},{"st":"TX","f":"465","n":"Val Verde","lat":29.8753,"lng":-101.1433,"u24":85,"u25":73,"u26":33},{"st":"NC","f":"083","n":"Halifax","lat":36.2514,"lng":-77.6448,"u24":55,"u25":72,"u26":62},{"st":"TX","f":"325","n":"Medina","lat":29.3537,"lng":-99.1111,"u24":102,"u25":71,"u26":36},{"st":"FL","f":"093","n":"Okeechobee","lat":27.3856,"lng":-80.8874,"u24":18,"u25":68,"u26":31},{"st":"FL","f":"007","n":"Bradford","lat":29.9524,"lng":-82.1667,"u24":93,"u25":67,"u26":39},{"st":"TX","f":"003","n":"Andrews","lat":32.3123,"lng":-102.6402,"u24":24,"u25":67,"u26":77},{"st":"TX","f":"185","n":"Grimes","lat":30.5432,"lng":-95.9881,"u24":110,"u25":65,"u26":11},{"st":"TX","f":"037","n":"Bowie","lat":33.4461,"lng":-94.4224,"u24":55,"u25":64,"u26":38},{"st":"TX","f":"255","n":"Karnes","lat":28.909,"lng":-97.8522,"u24":78,"u25":64,"u26":26},{"st":"TX","f":"323","n":"Maverick","lat":28.7298,"lng":-100.3167,"u24":60,"u25":64,"u26":27},{"st":"TX","f":"499","n":"Wood","lat":32.7836,"lng":-95.3822,"u24":35,"u25":63,"u26":1},{"st":"TN","f":"183","n":"Weakley","lat":36.3036,"lng":-88.7212,"u24":69,"u25":62,"u26":26},{"st":"TX","f":"217","n":"Hill","lat":31.9826,"lng":-97.1306,"u24":65,"u25":62,"u26":18},{"st":"TN","f":"057","n":"Grainger","lat":36.2775,"lng":-83.5095,"u24":74,"u25":61,"u26":33},{"st":"TX","f":"223","n":"Hopkins","lat":33.149,"lng":-95.5654,"u24":66,"u25":61,"u26":26},{"st":"NC","f":"079","n":"Greene","lat":35.482,"lng":-77.6817,"u24":52,"u25":59,"u26":18},{"st":"NC","f":"165","n":"Scotland","lat":34.84,"lng":-79.4773,"u24":70,"u25":59,"u26":26},{"st":"FL","f":"039","n":"Gadsden","lat":30.5787,"lng":-84.6126,"u24":71,"u25":57,"u26":25},{"st":"FL","f":"123","n":"Taylor","lat":29.9671,"lng":-83.6396,"u24":48,"u25":57,"u26":52},{"st":"TX","f":"331","n":"Milam","lat":30.7912,"lng":-96.9844,"u24":77,"u25":56,"u26":25},{"st":"FL","f":"065","n":"Jefferson","lat":30.3969,"lng":-83.9218,"u24":64,"u25":55,"u26":25},{"st":"NC","f":"007","n":"Anson","lat":34.975,"lng":-80.1098,"u24":55,"u25":52,"u26":23},{"st":"FL","f":"029","n":"Dixie","lat":29.5527,"lng":-83.2362,"u24":49,"u25":51,"u26":28},{"st":"NC","f":"065","n":"Edgecombe","lat":35.9171,"lng":-77.6027,"u24":45,"u25":51,"u26":15},{"st":"TX","f":"171","n":"Gillespie","lat":30.3251,"lng":-98.9419,"u24":52,"u25":51,"u26":20},{"st":"NC","f":"033","n":"Caswell","lat":36.3943,"lng":-79.3396,"u24":54,"u25":50,"u26":30},{"st":"NC","f":"153","n":"Richmond","lat":35.0046,"lng":-79.7557,"u24":52,"u25":49,"u26":26},{"st":"NC","f":"041","n":"Chowan","lat":36.129,"lng":-76.6028,"u24":48,"u25":48,"u26":34},{"st":"NC","f":"047","n":"Columbus","lat":34.2616,"lng":-78.6393,"u24":24,"u25":48,"u26":21},{"st":"NC","f":"103","n":"Jones","lat":35.0323,"lng":-77.3562,"u24":39,"u25":46,"u26":9},{"st":"FL","f":"125","n":"Union","lat":30.0543,"lng":-82.3669,"u24":45,"u25":45,"u26":26},{"st":"NC","f":"121","n":"Mitchell","lat":36.0131,"lng":-82.1636,"u24":44,"u25":44,"u26":28},{"st":"TX","f":"277","n":"Lamar","lat":33.6673,"lng":-95.5703,"u24":32,"u25":44,"u26":21},{"st":"NC","f":"143","n":"Perquimans","lat":36.1809,"lng":-76.4032,"u24":46,"u25":43,"u26":27},{"st":"TX","f":"489","n":"Willacy","lat":26.4819,"lng":-97.5947,"u24":36,"u25":43,"u26":14},{"st":"TN","f":"085","n":"Humphreys","lat":36.0408,"lng":-87.7905,"u24":39,"u25":42,"u26":19},{"st":"TX","f":"469","n":"Victoria","lat":28.7964,"lng":-96.9712,"u24":33,"u25":42,"u26":34},{"st":"FL","f":"067","n":"Lafayette","lat":29.9901,"lng":-83.1785,"u24":42,"u25":41,"u26":25},{"st":"TX","f":"147","n":"Fannin","lat":33.5912,"lng":-96.105,"u24":64,"u25":41,"u26":63},{"st":"FL","f":"079","n":"Madison","lat":30.4472,"lng":-83.4704,"u24":29,"u25":39,"u26":19},{"st":"NC","f":"015","n":"Bertie","lat":36.059,"lng":-76.9624,"u24":46,"u25":37,"u26":9},{"st":"TX","f":"065","n":"Carson","lat":35.4055,"lng":-101.3554,"u24":39,"u25":37,"u26":14},{"st":"TN","f":"069","n":"Hardeman","lat":35.2188,"lng":-88.9887,"u24":41,"u25":36,"u26":8},{"st":"TX","f":"203","n":"Harrison","lat":32.548,"lng":-94.3744,"u24":56,"u25":36,"u26":32},{"st":"NC","f":"095","n":"Hyde","lat":35.4082,"lng":-76.1537,"u24":11,"u25":35,"u26":3},{"st":"TX","f":"051","n":"Burleson","lat":30.4935,"lng":-96.6221,"u24":42,"u25":35,"u26":41},{"st":"FL","f":"047","n":"Hamilton","lat":30.4984,"lng":-82.9511,"u24":26,"u25":34,"u26":9},{"st":"TN","f":"107","n":"McMinn","lat":35.4245,"lng":-84.6199,"u24":31,"u25":33,"u26":42},{"st":"TX","f":"347","n":"Nacogdoches","lat":31.6206,"lng":-94.6202,"u24":35,"u25":31,"u26":13},{"st":"FL","f":"013","n":"Calhoun","lat":30.3888,"lng":-85.1979,"u24":30,"u25":29,"u26":10},{"st":"NC","f":"075","n":"Graham","lat":35.3484,"lng":-83.8309,"u24":31,"u25":28,"u26":11},{"st":"TN","f":"127","n":"Moore","lat":35.2889,"lng":-86.3587,"u24":31,"u25":28,"u26":13},{"st":"TN","f":"171","n":"Unicoi","lat":36.1001,"lng":-82.4182,"u24":24,"u25":28,"u26":8},{"st":"TN","f":"131","n":"Obion","lat":36.3619,"lng":-89.1481,"u24":21,"u25":27,"u26":8},{"st":"TX","f":"089","n":"Colorado","lat":29.5963,"lng":-96.5089,"u24":29,"u25":27,"u26":12},{"st":"TX","f":"241","n":"Jasper","lat":30.7529,"lng":-94.0223,"u24":30,"u25":27,"u26":9},{"st":"TX","f":"425","n":"Somervell","lat":32.2181,"lng":-97.7692,"u24":21,"u25":27,"u26":19},{"st":"TN","f":"027","n":"Clay","lat":36.5457,"lng":-85.5457,"u24":25,"u25":26,"u26":13},{"st":"TX","f":"389","n":"Reeves","lat":31.3084,"lng":-103.7127,"u24":22,"u25":26,"u26":25},{"st":"TN","f":"033","n":"Crockett","lat":35.8188,"lng":-89.1325,"u24":26,"u25":25,"u26":12},{"st":"TN","f":"097","n":"Lauderdale","lat":35.763,"lng":-89.6277,"u24":24,"u25":24,"u26":14},{"st":"TX","f":"073","n":"Cherokee","lat":31.8439,"lng":-95.1563,"u24":39,"u25":23,"u26":9},{"st":"TX","f":"459","n":"Upshur","lat":32.7353,"lng":-94.9412,"u24":32,"u25":23,"u26":2},{"st":"TX","f":"293","n":"Limestone","lat":31.5475,"lng":-96.5936,"u24":17,"u25":22,"u26":8},{"st":"TN","f":"071","n":"Hardin","lat":35.2019,"lng":-88.1857,"u24":12,"u25":21,"u26":13},{"st":"TN","f":"099","n":"Lawrence","lat":35.2205,"lng":-87.3965,"u24":18,"u25":20,"u26":8},{"st":"TN","f":"101","n":"Lewis","lat":35.5232,"lng":-87.497,"u24":13,"u25":20,"u26":7},{"st":"TN","f":"077","n":"Henderson","lat":35.654,"lng":-88.3877,"u24":19,"u25":19,"u26":10},{"st":"TX","f":"123","n":"DeWitt","lat":29.0823,"lng":-97.3617,"u24":9,"u25":19,"u26":0},{"st":"TX","f":"363","n":"Palo Pinto","lat":32.7522,"lng":-98.318,"u24":27,"u25":19,"u26":7},{"st":"FL","f":"077","n":"Liberty","lat":30.2598,"lng":-84.8686,"u24":11,"u25":18,"u26":10},{"st":"NC","f":"177","n":"Tyrrell","lat":35.8704,"lng":-76.1653,"u24":11,"u25":18,"u26":8},{"st":"TN","f":"079","n":"Henry","lat":36.3253,"lng":-88.3003,"u24":19,"u25":18,"u26":8},{"st":"TX","f":"063","n":"Camp","lat":32.9746,"lng":-94.9791,"u24":3,"u25":18,"u26":8},{"st":"TX","f":"273","n":"Kleberg","lat":27.4387,"lng":-97.6606,"u24":24,"u25":18,"u26":2},{"st":"TX","f":"391","n":"Refugio","lat":28.3221,"lng":-97.1625,"u24":24,"u25":18,"u26":5},{"st":"TX","f":"281","n":"Lampasas","lat":31.1967,"lng":-98.2409,"u24":18,"u25":17,"u26":7},{"st":"TX","f":"341","n":"Moore","lat":35.8357,"lng":-101.8905,"u24":25,"u25":17,"u26":3},{"st":"TX","f":"377","n":"Presidio","lat":30.0059,"lng":-104.2616,"u24":23,"u25":17,"u26":9},{"st":"TN","f":"061","n":"Grundy","lat":35.3934,"lng":-85.7104,"u24":16,"u25":16,"u26":8},{"st":"TX","f":"025","n":"Bee","lat":28.4161,"lng":-97.7426,"u24":15,"u25":16,"u26":7},{"st":"TX","f":"149","n":"Fayette","lat":29.8779,"lng":-96.9212,"u24":19,"u25":16,"u26":3},{"st":"NC","f":"131","n":"Northampton","lat":36.4218,"lng":-77.3984,"u24":17,"u25":15,"u26":5},{"st":"TX","f":"117","n":"Deaf Smith","lat":34.9408,"lng":-102.6076,"u24":17,"u25":15,"u26":6},{"st":"TX","f":"287","n":"Lee","lat":30.3215,"lng":-96.9768,"u24":18,"u25":15,"u26":26},{"st":"TX","f":"421","n":"Sherman","lat":36.2786,"lng":-101.8993,"u24":17,"u25":15,"u26":5},{"st":"TN","f":"153","n":"Sequatchie","lat":35.3723,"lng":-85.4101,"u24":33,"u25":14,"u26":11},{"st":"TN","f":"161","n":"Stewart","lat":36.4585,"lng":-87.8119,"u24":15,"u25":14,"u26":4},{"st":"TX","f":"133","n":"Eastland","lat":32.3246,"lng":-98.8366,"u24":10,"u25":14,"u26":7},{"st":"TX","f":"227","n":"Howard","lat":32.3034,"lng":-101.4387,"u24":62,"u25":14,"u26":17},{"st":"TX","f":"353","n":"Nolan","lat":32.3123,"lng":-100.4181,"u24":15,"u25":14,"u26":7},{"st":"TN","f":"075","n":"Haywood","lat":35.5867,"lng":-89.2827,"u24":22,"u25":13,"u26":2},{"st":"TX","f":"001","n":"Anderson","lat":31.8413,"lng":-95.6617,"u24":20,"u25":13,"u26":15},{"st":"TX","f":"165","n":"Gaines","lat":32.7439,"lng":-102.6316,"u24":19,"u25":13,"u26":7},{"st":"TX","f":"379","n":"Rains","lat":32.8705,"lng":-95.7956,"u24":21,"u25":13,"u26":3},{"st":"TX","f":"449","n":"Titus","lat":33.2146,"lng":-94.9668,"u24":35,"u25":13,"u26":5},{"st":"TX","f":"503","n":"Young","lat":33.1588,"lng":-98.6784,"u24":5,"u25":13,"u26":7},{"st":"FL","f":"059","n":"Holmes","lat":30.862,"lng":-85.8159,"u24":12,"u25":12,"u26":7},{"st":"NC","f":"073","n":"Gates","lat":36.4421,"lng":-76.7024,"u24":14,"u25":12,"u26":5},{"st":"TN","f":"017","n":"Carroll","lat":35.9657,"lng":-88.4524,"u24":8,"u25":12,"u26":6},{"st":"TN","f":"023","n":"Chester","lat":35.4203,"lng":-88.6114,"u24":16,"u25":12,"u26":12},{"st":"TN","f":"135","n":"Perry","lat":35.6638,"lng":-87.8693,"u24":12,"u25":12,"u26":5},{"st":"TX","f":"009","n":"Archer","lat":33.6163,"lng":-98.6873,"u24":23,"u25":12,"u26":5},{"st":"TX","f":"035","n":"Bosque","lat":31.9008,"lng":-97.6376,"u24":15,"u25":12,"u26":3},{"st":"TX","f":"387","n":"Red River","lat":33.6196,"lng":-95.0484,"u24":14,"u25":12,"u26":6},{"st":"TX","f":"177","n":"Gonzales","lat":29.4619,"lng":-97.4919,"u24":11,"u25":11,"u26":8},{"st":"TX","f":"285","n":"Lavaca","lat":29.3826,"lng":-96.9236,"u24":9,"u25":11,"u26":4},{"st":"TX","f":"337","n":"Montague","lat":33.6784,"lng":-97.725,"u24":23,"u25":11,"u26":2},{"st":"TX","f":"463","n":"Uvalde","lat":29.3503,"lng":-99.7684,"u24":15,"u25":11,"u26":17},{"st":"TX","f":"031","n":"Blanco","lat":30.2662,"lng":-98.3993,"u24":10,"u25":10,"u26":3},{"st":"TX","f":"193","n":"Hamilton","lat":31.7073,"lng":-98.1118,"u24":16,"u25":10,"u26":5},{"st":"TN","f":"133","n":"Overton","lat":36.3449,"lng":-85.2831,"u24":17,"u25":9,"u26":3},{"st":"TX","f":"093","n":"Comanche","lat":31.9516,"lng":-98.5496,"u24":4,"u25":9,"u26":3},{"st":"TX","f":"297","n":"Live Oak","lat":28.3515,"lng":-98.127,"u24":12,"u25":9,"u26":4},{"st":"TX","f":"501","n":"Yoakum","lat":33.1623,"lng":-102.8322,"u24":6,"u25":9,"u26":4},{"st":"TX","f":"119","n":"Delta","lat":33.3859,"lng":-95.6733,"u24":7,"u25":8,"u26":11},{"st":"TX","f":"143","n":"Erath","lat":32.2367,"lng":-98.2205,"u24":27,"u25":8,"u26":4},{"st":"TX","f":"163","n":"Frio","lat":28.8694,"lng":-99.109,"u24":12,"u25":8,"u26":4},{"st":"TX","f":"237","n":"Jack","lat":33.2322,"lng":-98.1712,"u24":10,"u25":8,"u26":1},{"st":"TX","f":"365","n":"Panola","lat":32.164,"lng":-94.3052,"u24":6,"u25":8,"u26":2},{"st":"TX","f":"475","n":"Ward","lat":31.5131,"lng":-103.1051,"u24":7,"u25":8,"u26":2},{"st":"TN","f":"039","n":"Decatur","lat":35.6031,"lng":-88.1103,"u24":10,"u25":7,"u26":5},{"st":"TX","f":"169","n":"Garza","lat":33.1838,"lng":-101.3011,"u24":5,"u25":7,"u26":1},{"st":"TX","f":"219","n":"Hockley","lat":33.6059,"lng":-102.3434,"u24":7,"u25":7,"u26":3},{"st":"TX","f":"315","n":"Marion","lat":32.7982,"lng":-94.3569,"u24":6,"u25":7,"u26":3},{"st":"TX","f":"043","n":"Brewster","lat":29.809,"lng":-103.2525,"u24":7,"u25":6,"u26":1},{"st":"TX","f":"145","n":"Falls","lat":31.2519,"lng":-96.9341,"u24":4,"u25":6,"u26":3},{"st":"TX","f":"369","n":"Parmer","lat":34.5322,"lng":-102.7849,"u24":4,"u25":6,"u26":0},{"st":"TX","f":"109","n":"Culberson","lat":31.4459,"lng":-104.5269,"u24":9,"u25":5,"u26":2},{"st":"TX","f":"189","n":"Hale","lat":34.0684,"lng":-101.8229,"u24":13,"u25":5,"u26":0},{"st":"TN","f":"091","n":"Johnson","lat":36.4532,"lng":-81.8612,"u24":6,"u25":4,"u26":4},{"st":"TN","f":"109","n":"McNairy","lat":35.1754,"lng":-88.5637,"u24":7,"u25":4,"u26":6},{"st":"TN","f":"175","n":"Van Buren","lat":35.6992,"lng":-85.4584,"u24":8,"u25":3,"u26":2},{"st":"TX","f":"067","n":"Cass","lat":33.0837,"lng":-94.3576,"u24":12,"u25":3,"u26":9},{"st":"TX","f":"179","n":"Gray","lat":35.4025,"lng":-100.8124,"u24":7,"u25":3,"u26":2},{"st":"TX","f":"111","n":"Dallam","lat":36.2864,"lng":-102.594,"u24":8,"u25":2,"u26":1},{"st":"TX","f":"175","n":"Goliad","lat":28.6607,"lng":-97.4304,"u24":10,"u25":2,"u26":1},{"st":"TX","f":"415","n":"Scurry","lat":32.7444,"lng":-100.9133,"u24":32,"u25":1,"u26":2}];
const FL_U26_MONTHS = 5; // 2026 YTD covers Jan–May

// Simplified state boundaries [lng,lat] — drawn on the radar + tile-outage fallback
const ST_OUTLINES = {"FL":[[[-85.497,30.998],[-85.004,31.003],[-84.867,30.713],[-83.498,30.647],[-82.216,30.57],[-82.167,30.357],[-82.047,30.362],[-82.003,30.565],[-82.041,30.751],[-81.948,30.828],[-81.718,30.746],[-81.444,30.707],[-81.384,30.275],[-81.258,29.787],[-80.968,29.146],[-80.524,28.462],[-80.59,28.412],[-80.568,28.095],[-80.382,27.739],[-80.091,27.021],[-80.031,26.797],[-80.037,26.567],[-80.146,25.74],[-80.239,25.723],[-80.338,25.466],[-80.305,25.384],[-80.497,25.197],[-80.573,25.241],[-80.76,25.165],[-81.077,25.121],[-81.17,25.225],[-81.127,25.378],[-81.351,25.822],[-81.526,25.904],[-81.68,25.844],[-81.8,26.09],[-81.833,26.293],[-82.041,26.517],[-82.09,26.665],[-82.058,26.879],[-82.173,26.917],[-82.145,26.791],[-82.249,26.758],[-82.567,27.301],[-82.693,27.438],[-82.392,27.837],[-82.589,27.815],[-82.72,27.689],[-82.852,27.887],[-82.677,28.434],[-82.644,28.889],[-82.764,28.998],[-82.802,29.146],[-82.994,29.179],[-83.219,29.42],[-83.399,29.519],[-83.41,29.667],[-83.536,29.721],[-83.64,29.886],[-84.024,30.105],[-84.358,30.056],[-84.342,29.902],[-84.451,29.93],[-84.867,29.743],[-85.311,29.7],[-85.3,29.809],[-85.404,29.94],[-85.924,30.236],[-86.297,30.362],[-86.631,30.395],[-86.91,30.373],[-87.518,30.28],[-87.37,30.428],[-87.447,30.51],[-87.409,30.674],[-87.633,30.866],[-87.6,30.998],[-85.497,30.998]]],"NC":[[[-80.979,36.562],[-80.294,36.546],[-79.511,36.54],[-75.869,36.551],[-75.754,36.151],[-76.033,36.19],[-76.071,36.14],[-76.411,36.08],[-76.46,36.025],[-76.685,36.009],[-76.674,35.938],[-76.4,35.987],[-76.362,35.943],[-76.06,35.993],[-75.962,35.899],[-75.781,35.938],[-75.715,35.697],[-75.776,35.582],[-75.896,35.571],[-76.148,35.324],[-76.482,35.313],[-76.537,35.144],[-76.394,34.974],[-76.279,34.941],[-76.493,34.662],[-76.674,34.694],[-76.991,34.667],[-77.211,34.607],[-77.556,34.415],[-77.829,34.163],[-77.972,33.846],[-78.18,33.917],[-78.541,33.851],[-79.675,34.804],[-80.798,34.82],[-80.781,34.935],[-80.935,35.105],[-81.039,35.045],[-81.044,35.149],[-82.277,35.198],[-82.551,35.16],[-82.764,35.067],[-83.109,35.001],[-83.619,34.985],[-84.32,34.99],[-84.292,35.226],[-84.095,35.248],[-84.018,35.412],[-83.772,35.56],[-83.498,35.565],[-83.252,35.719],[-82.994,35.773],[-82.775,35.998],[-82.638,36.064],[-82.611,35.965],[-82.216,36.157],[-82.036,36.118],[-81.91,36.305],[-81.724,36.354],[-81.68,36.589],[-80.979,36.562]]],"TN":[[[-88.055,36.496],[-88.071,36.677],[-87.852,36.633],[-86.593,36.655],[-85.486,36.617],[-85.289,36.628],[-84.544,36.595],[-83.69,36.584],[-83.673,36.6],[-81.68,36.589],[-81.724,36.354],[-81.91,36.305],[-82.036,36.118],[-82.216,36.157],[-82.611,35.965],[-82.638,36.064],[-82.775,35.998],[-82.994,35.773],[-83.252,35.719],[-83.498,35.565],[-83.772,35.56],[-84.018,35.412],[-84.095,35.248],[-84.292,35.226],[-84.32,34.99],[-85.607,34.985],[-87.359,35.001],[-88.203,34.996],[-88.471,34.996],[-90.311,34.996],[-90.213,35.023],[-90.114,35.198],[-90.131,35.439],[-89.944,35.604],[-89.912,35.757],[-89.764,35.812],[-89.731,35.998],[-89.534,36.25],[-89.539,36.496],[-89.484,36.496],[-89.419,36.496],[-89.298,36.507],[-88.055,36.496]]],"TX":[[[-101.813,36.502],[-100.0,36.502],[-100.0,34.563],[-99.923,34.574],[-99.699,34.382],[-99.578,34.415],[-99.261,34.404],[-99.189,34.212],[-98.987,34.223],[-98.768,34.136],[-98.571,34.147],[-98.488,34.065],[-98.362,34.158],[-98.171,34.114],[-98.089,34.004],[-97.946,33.988],[-97.87,33.851],[-97.694,33.982],[-97.459,33.906],[-97.371,33.824],[-97.256,33.862],[-97.174,33.736],[-96.922,33.961],[-96.851,33.846],[-96.632,33.846],[-96.424,33.774],[-96.347,33.687],[-96.15,33.84],[-95.936,33.889],[-95.838,33.835],[-95.602,33.933],[-95.547,33.878],[-95.29,33.873],[-95.224,33.961],[-94.967,33.862],[-94.868,33.747],[-94.485,33.637],[-94.381,33.544],[-94.184,33.594],[-94.041,33.55],[-94.041,33.019],[-94.041,31.994],[-93.822,31.775],[-93.817,31.556],[-93.543,31.151],[-93.526,30.937],[-93.63,30.68],[-93.729,30.576],[-93.696,30.439],[-93.767,30.335],[-93.691,30.143],[-93.926,29.787],[-93.839,29.689],[-94.003,29.683],[-94.523,29.546],[-94.709,29.623],[-94.742,29.787],[-94.874,29.672],[-94.967,29.7],[-95.016,29.557],[-94.912,29.497],[-94.896,29.311],[-95.082,29.113],[-95.383,28.867],[-95.985,28.604],[-96.046,28.648],[-96.226,28.582],[-96.232,28.642],[-96.478,28.599],[-96.593,28.725],[-96.665,28.697],[-96.402,28.44],[-96.593,28.358],[-96.774,28.407],[-96.802,28.226],[-97.026,28.04],[-97.256,27.695],[-97.404,27.333],[-97.514,27.361],[-97.541,27.229],[-97.426,27.262],[-97.481,26.999],[-97.557,26.988],[-97.563,26.841],[-97.47,26.758],[-97.442,26.457],[-97.333,26.353],[-97.305,26.161],[-97.218,25.992],[-97.524,25.888],[-97.65,26.019],[-97.886,26.068],[-98.198,26.057],[-98.467,26.222],[-98.669,26.238],[-98.823,26.37],[-99.031,26.413],[-99.173,26.539],[-99.266,26.841],[-99.447,27.021],[-99.425,27.175],[-99.507,27.339],[-99.48,27.481],[-99.606,27.64],[-99.71,27.657],[-99.88,27.799],[-99.934,27.98],[-100.082,28.144],[-100.296,28.281],[-100.4,28.582],[-100.498,28.664],[-100.63,28.905],[-100.674,29.103],[-100.8,29.245],[-101.013,29.371],[-101.063,29.459],[-101.26,29.535],[-101.413,29.754],[-101.851,29.804],[-102.114,29.793],[-102.339,29.869],[-102.388,29.765],[-102.629,29.732],[-102.81,29.524],[-102.919,29.19],[-102.98,29.185],[-103.116,28.987],[-103.281,28.982],[-103.527,29.135],[-104.146,29.382],[-104.267,29.513],[-104.508,29.639],[-104.677,29.924],[-104.688,30.181],[-104.858,30.39],[-104.896,30.57],[-105.006,30.685],[-105.395,30.855],[-105.603,31.085],[-105.773,31.167],[-105.954,31.364],[-106.205,31.469],[-106.381,31.731],[-106.529,31.786],[-106.644,31.901],[-106.616,32.0],[-103.067,32.0],[-103.067,33.002],[-103.045,34.015],[-103.04,36.502],[-103.001,36.502],[-101.813,36.502]]]};
const RADAR_BOUNDS = { FL: [[24.35,-87.7],[31.1,-79.8]], TX: [[25.6,-106.8],[36.7,-93.3]], NC: [[33.7,-84.5],[36.7,-75.3]], TN: [[34.9,-90.4],[36.8,-81.5]], ALL: [[25.0,-107.0],[37.2,-75.0]] };
const RADAR_STATES = ["FL", "TX", "NC", "TN"];

const RADAR_TIERS = [
  ["ON FIRE",    CC.signal,   76],
  ["HEATING UP", "#FF9F45",   60],
  ["WATCH LIST", CC.amber,    45],
  ["TOO EARLY",  CC.cyan,     30],
  ["COLD",       CC.stakeDim, -1],
];
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/* Demand model — 58% volume (log-scaled: Harris's 17k ≠ 17× hotter than 1k),
   42% momentum (2026 permit pace vs 2025, plus 2025 vs 2024). One scale across
   all states so a TX 80 means the same heat as a FL 80. */
const RADAR_MAXVOL = Math.max.apply(null, RADAR_PERMITS.map((c) => (c.u25 + (c.u26 / FL_U26_MONTHS) * 12) / 2));
const RADAR_HOTSPOTS = RADAR_PERMITS.map((c) => {
  const pace26 = Math.round((c.u26 / FL_U26_MONTHS) * 12);
  const vol = (c.u25 + pace26) / 2;
  const volN = clamp01((Math.log10(Math.max(vol, 1) + 10) - 1) / (Math.log10(RADAR_MAXVOL + 10) - 1));
  const mom = 0.65 * (pace26 / Math.max(c.u25, 1)) + 0.35 * (c.u25 / Math.max(c.u24, 1));
  const momN = clamp01((mom - 0.65) / 0.7);
  const score = Math.round(100 * (0.58 * volN + 0.42 * momN));
  const t = RADAR_TIERS.find((x) => score >= x[2]) || RADAR_TIERS[RADAR_TIERS.length - 1];
  const chg = c.u25 > 0 ? Math.round((pace26 / c.u25 - 1) * 100) : 0;
  return { ...c, pace26, score, tier: t[0], color: t[1], chg, volN };
}).sort((a, b) => b.score - a.score);
const stateRank = (c) => {
  const peers = RADAR_HOTSPOTS.filter((x) => x.st === c.st);
  return { rank: peers.indexOf(c) + 1, of: peers.length };
};
// FL bbox — lot lines / owner cards / sales scans ride the FL cadastral only (for now)
const inFlorida = (lat, lng) => lat >= 24.3 && lat <= 31.2 && lng >= -87.7 && lng <= -79.8;

function hotspotInsight(c) {
  const dir = c.chg >= 8 ? `accelerating — 2026 permit pace is running +${c.chg}% vs 2025`
    : c.chg <= -8 ? `cooling — 2026 pace is ${c.chg}% vs 2025`
    : `holding steady — 2026 pace within ${Math.abs(c.chg)}% of 2025`;
  const play = c.score >= 60 ? "Builders are consuming dirt here — get lots under contract ahead of them."
    : c.score >= 45 ? "Real volume but watch the trend — scan recent land sales before spending on marketing."
    : "Thin builder volume — only chase deep-discount deals with a known exit.";
  return `${c.n} County, ${c.st} pulled ${c.u25.toLocaleString()} single-family permits in 2025 and is ${dir}. ${play}`;
}

function verdictHeat(v) {
  if (!v) return CC.phosphor;
  if (v.includes("FIRE")) return CC.signal;
  if (v.includes("HEATING")) return "#FF9F45";
  if (v.includes("WATCH")) return CC.amber;
  if (v.includes("EARLY")) return CC.cyan;
  return CC.stakeDim;
}

let _leafletP = null;
function loadLeaflet() {
  if (window.L && window.L.map) return Promise.resolve(window.L);
  if (_leafletP) return _leafletP;
  _leafletP = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    js.onload = () => resolve(window.L);
    js.onerror = () => { _leafletP = null; reject(new Error("map library blocked — hotspot list still live below")); };
    document.head.appendChild(js);
  });
  return _leafletP;
}

/* Live land-sale scan: one bbox query on the FL cadastral, NO server-side
   WHERE (times out on 10.8M parcels) — filter recent sales client-side. */
async function scanLandSales(lat, lng) {
  const yr = new Date().getFullYear();
  const mi = 0.75, dlat = mi / 69, dlng = mi / (69 * Math.cos((lat * Math.PI) / 180));
  const params = new URLSearchParams({
    geometry: `${lng - dlng},${lat - dlat},${lng + dlng},${lat + dlat}`,
    geometryType: "esriGeometryEnvelope", spatialRel: "esriSpatialRelIntersects", inSR: "4326", outSR: "4326",
    outFields: "SALE_PRC1,SALE_YR1,SALE_MO1,LND_SQFOOT,DOR_UC,PHY_ADDR1",
    returnCentroid: "true", returnGeometry: "false", resultRecordCount: "1800", f: "json",
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 22000);
  let feats;
  try {
    const r = await fetch(`${FL_CADASTRAL}/query?${params}`, { signal: ctrl.signal });
    const j = await r.json();
    feats = j.features || [];
  } finally { clearTimeout(timer); }
  const sales = feats.map((ft) => {
    const c = ft.centroid, p = ft.attributes || {};
    if (!c) return null;
    const price = parseFloat(p.SALE_PRC1) || 0, y = parseFloat(p.SALE_YR1) || 0;
    const acres = (parseFloat(p.LND_SQFOOT) || 0) / 43560;
    if (!(price > 2000 && acres > 0 && y >= yr - 2)) return null;
    return { lat: c.y, lng: c.x, price, y, m: p.SALE_MO1, acres, ppa: Math.round(price / acres),
      addr: String(p.PHY_ADDR1 || "").trim(), vacant: FL_VACANT_UC.includes(String(p.DOR_UC || "").trim()) };
  }).filter(Boolean);
  const vac = sales.filter((s) => s.vacant).sort((a, b) => a.ppa - b.ppa);
  const medPpa = vac.length ? vac[Math.floor(vac.length / 2)].ppa : 0;
  return { sales, vacCount: vac.length, impCount: sales.length - vac.length, medPpa, parcels: feats.length };
}

const RADAR_CSS = `
.ms-map.leaflet-container { background: ${CC.abyss}; font-family: 'JetBrains Mono', monospace; }
.ms-nogrid.leaflet-container { background-image:
  linear-gradient(rgba(74,222,158,.055) 1px, transparent 1px),
  linear-gradient(90deg, rgba(74,222,158,.055) 1px, transparent 1px);
  background-size: 46px 46px; }
.ms-wrap { background: transparent; border: none; }
.ms-blip { position: relative; width: var(--s); height: var(--s); }
.ms-blip i { position: absolute; inset: 0; border-radius: 50%; background: var(--c); opacity: .16; display: block; }
.ms-blip b { position: absolute; left: 50%; top: 50%; width: 38%; height: 38%; min-width: 7px; min-height: 7px;
  transform: translate(-50%, -50%); border-radius: 50%; background: var(--c); box-shadow: 0 0 9px var(--c); display: block; }
.ms-hot i { animation: ms-ping 2.2s ease-out infinite; }
.ms-on b { outline: 2px solid #fff; outline-offset: 1px; }
@keyframes ms-ping { 0% { transform: scale(.5); opacity: .5; } 75% { transform: scale(1.3); opacity: 0; } 100% { transform: scale(1.3); opacity: 0; } }
.ms-tip { background: ${CC.void} !important; border: 1px solid ${CC.edgeLit} !important; color: ${CC.stake} !important;
  font-family: 'JetBrains Mono', monospace !important; font-size: 11px !important; border-radius: 4px !important;
  box-shadow: 0 4px 14px rgba(0,0,0,.5) !important; }
.ms-tip::before { display: none !important; }
.ms-chip { display: inline-flex; align-items: center; gap: 7px; flex: 0 0 auto; cursor: pointer; padding: 5px 11px;
  border-radius: 4px; border: 1px solid ${CC.edge}; background: ${CC.moss}; color: ${CC.stake};
  font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700; letter-spacing: .04em; transition: border-color .12s; }
.ms-chip:hover { border-color: ${CC.phosphor}; }
.ms-scroll { scrollbar-width: thin; scrollbar-color: ${CC.edge} transparent; }
@media (prefers-reduced-motion: reduce) { .ms-hot i { animation: none !important; } }
`;

function RadarMap({ history, activeMarket, onSelect, onScout, onCreateBox, data, update, lotFind }) {
  const mapEl = React.useRef(null);
  const mapRef = React.useRef(null);
  const refreshLotsRef = React.useRef(() => {});
  const [ready, setReady] = useState(false);
  const [mapErr, setMapErr] = useState("");
  const [tilesDead, setTilesDead] = useState(false);
  const [baseMode, setBaseMode] = useState("auto"); // auto = dark radar wide, satellite at street zoom
  const [zoom, setZoom] = useState(6);
  const [stFilter, setStFilter] = useState("FL"); // ranked-strip state filter
  const [sel, setSel] = useState(RADAR_HOTSPOTS.find((c) => c.st === "FL") || RADAR_HOTSPOTS[0]);
  const [scan, setScan] = useState(null);
  const [lots, setLots] = useState(null);   // lot-lines fetch status
  const [card, setCard] = useState(null);   // selected parcel ownership card
  const [finder, setFinder] = useState(null); // APN/address lot search status
  const [dossOpen, setDossOpen] = useState(true); // county dossier expanded?
  const markets = Object.values(history || {}).filter((r) => r && typeof r.lat === "number" && typeof r.lng === "number");
  const effBase = baseMode === "auto" ? (zoom >= SAT_ZOOM ? "sat" : "dark") : baseMode;

  useEffect(() => {
    let dead = false;
    loadLeaflet().then((L) => {
      if (dead || !mapEl.current || mapRef.current) return;
      const map = L.map(mapEl.current, { attributionControl: false, zoomControl: false, minZoom: 5, maxZoom: 19 });
      L.control.zoom({ position: "bottomright" }).addTo(map);
      map.fitBounds(RADAR_BOUNDS.FL);
      RADAR_STATES.forEach((st2) => {
        const rings = (ST_OUTLINES[st2] || []).map((rg) => rg.map(([x, y]) => [y, x]));
        if (rings.length) L.polygon(rings, { color: CC.phosphorDim, weight: 1.2, fill: false, opacity: 0.75, interactive: false }).addTo(map);
      });
      mapRef.current = { L, map, tiles: null, labels: null, canvas: L.canvas({ padding: 0.3 }),
        lotLayer: L.layerGroup().addTo(map), scanLayer: L.layerGroup().addTo(map),
        hotLayer: L.layerGroup().addTo(map), histLayer: L.layerGroup().addTo(map),
        findLayer: L.layerGroup().addTo(map),
        lotCtrl: null, lotTimer: null, selLot: null };
      map.on("zoomend", () => setZoom(map.getZoom()));
      map.on("moveend", () => { setZoom(map.getZoom()); refreshLotsRef.current(); });
      window.__msMap = map; // debug/test hook
      setZoom(map.getZoom());
      setReady(true);
      setTimeout(() => map.invalidateSize(), 60);
    }).catch((e) => setMapErr(String((e && e.message) || e)));
    return () => { dead = true; if (mapRef.current) { mapRef.current.map.remove(); mapRef.current = null; } };
  }, []);

  // basemap: dark ops view wide, live satellite at street zoom (auto), or forced
  useEffect(() => {
    const m = mapRef.current; if (!ready || !m) return;
    if (m.tiles) m.map.removeLayer(m.tiles);
    if (m.labels) { m.map.removeLayer(m.labels); m.labels = null; }
    const url = effBase === "sat"
      ? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
      : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
    m.tiles = m.L.tileLayer(url, { maxZoom: 19, subdomains: "abcd" });
    m.tiles.on("tileerror", () => setTilesDead(true));
    m.tiles.on("tileload", () => setTilesDead(false));
    m.tiles.addTo(m.map);
    if (effBase === "sat") {
      m.labels = m.L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, opacity: 0.9 });
      m.labels.addTo(m.map);
    }
  }, [ready, effBase]);

  // permit-demand hotspot blips
  useEffect(() => {
    const m = mapRef.current; if (!ready || !m) return;
    m.hotLayer.clearLayers();
    RADAR_HOTSPOTS.forEach((c) => {
      const px = Math.round(12 + c.volN * 26);
      const cls = "ms-blip" + (c.score >= 60 ? " ms-hot" : "") + (sel && sel.st === c.st && sel.f === c.f ? " ms-on" : "");
      const mk = m.L.marker([c.lat, c.lng], {
        icon: m.L.divIcon({ html: `<div class="${cls}" style="--c:${c.color};--s:${px}px"><i></i><b></b></div>`, className: "ms-wrap", iconSize: [px, px] }),
        zIndexOffset: c.score * 10,
      });
      mk.bindTooltip(`${c.n}, ${c.st} — ${c.score} ${c.tier} · ${c.u25.toLocaleString()} permits '25`, { direction: "top", offset: [0, -px / 2], className: "ms-tip" });
      mk.on("click", () => setSel(c));
      m.hotLayer.addLayer(mk);
    });
  }, [ready, sel ? sel.st + sel.f : ""]);

  // markets you already deep-scouted (any state) — diamonds from saved history
  useEffect(() => {
    const m = mapRef.current; if (!ready || !m) return;
    m.histLayer.clearLayers();
    markets.forEach((r) => {
      const col = verdictHeat(r.verdict);
      const mk = m.L.circleMarker([r.lat, r.lng], { radius: 6, color: col, weight: 2, fillColor: col, fillOpacity: 0.3 });
      mk.bindTooltip(`◈ ${r.market} — ${r.score} ${r.verdict || ""} (scouted ${r.scoutedAt || ""})`, { className: "ms-tip", direction: "top" });
      mk.on("click", () => onSelect(r));
      m.histLayer.addLayer(mk);
    });
  }, [ready, markets.length]);

  const focusHotspot = (c) => {
    setSel(c);
    const m = mapRef.current; if (!m) return;
    m.map.flyTo([c.lat, c.lng], Math.max(m.map.getZoom(), 8), { duration: 0.8 });
  };

  const runScan = (lat, lng) => {
    const m = mapRef.current; if (!m) return;
    const at = lat != null ? { lat, lng } : m.map.getCenter();
    if (!inFlorida(at.lat, at.lng)) { setScan({ status: "na" }); return; }
    if (lat == null && m.map.getZoom() < 11) { setScan({ status: "zoom" }); return; }
    setScan({ status: "loading" });
    m.scanLayer.clearLayers();
    scanLandSales(at.lat, at.lng).then((res) => {
      res.sales.forEach((s) => {
        const col = s.vacant ? CC.phosphor : CC.stakeDim;
        const mk = m.L.circleMarker([s.lat, s.lng], { radius: s.vacant ? 6 : 3.5, color: col, weight: 1.5, fillColor: col, fillOpacity: s.vacant ? 0.75 : 0.25 });
        mk.bindTooltip(`${s.vacant ? "LAND" : "IMPROVED"} · $${s.price.toLocaleString()} · ${s.acres.toFixed(2)} ac · $${s.ppa.toLocaleString()}/ac · ${s.m || "?"}/${s.y}${s.addr ? " · " + s.addr : ""}`, { className: "ms-tip" });
        m.scanLayer.addLayer(mk);
      });
      setScan({ status: "done", ...res });
    }).catch(() => setScan({ status: "error" }));
  };

  const scanHotspot = (c) => {
    const m = mapRef.current; if (!m) { setScan({ status: "error" }); return; }
    setSel(c);
    m.map.once("moveend", () => runScan(c.lat, c.lng));
    m.map.flyTo([c.lat, c.lng], 13, { duration: 1.1 });
  };

  const clearScan = () => { const m = mapRef.current; if (m) m.scanLayer.clearLayers(); setScan(null); };

  /* ---- lot lines: live viewport query on the statewide cadastral (owners included) ---- */
  const LOT_STYLE = { color: CC.phosphor, weight: 1, opacity: 0.85, fillColor: CC.phosphor, fillOpacity: 0.04 };
  const LOT_STYLE_SEL = { color: "#FFE14D", weight: 2.5, opacity: 1, fillColor: "#FFE14D", fillOpacity: 0.12 };

  const closeCard = () => {
    const m = mapRef.current;
    if (m && m.selLot) { try { m.selLot.setStyle(LOT_STYLE); } catch (_) {} m.selLot = null; }
    if (m) m.findLayer.clearLayers();
    setCard(null);
  };

  const openLotCard = (ft, latlng, lyr) => {
    const m = mapRef.current; if (!m) return;
    m.findLayer.clearLayers();
    if (m.selLot) { try { m.selLot.setStyle(LOT_STYLE); } catch (_) {} }
    m.selLot = lyr; try { lyr.setStyle(LOT_STYLE_SEL); } catch (_) {}
    const p = ft.properties || {};
    const s = (v) => String(v == null ? "" : v).trim();
    const acres = (parseFloat(p.LND_SQFOOT) || 0) / 43560;
    const price = parseFloat(p.SALE_PRC1) || 0;
    const jv = parseFloat(p.JV) || 0;
    setCard({
      lat: latlng.lat, lng: latlng.lng,
      apn: s(p.PARCEL_ID), owner: s(p.OWN_NAME),
      mail1: s(p.OWN_ADDR1), mail2: [s(p.OWN_CITY), s(p.OWN_STATE), s(p.OWN_ZIPCD)].filter(Boolean).join(", "),
      site: [s(p.PHY_ADDR1), s(p.PHY_CITY)].filter(Boolean).join(", "),
      zip: s(p.PHY_ZIPCD) || s(p.OWN_ZIPCD),
      county: nearestFLCounty(latlng.lat, latlng.lng),
      acres, uc: s(p.DOR_UC), ucLabel: dorLabel(p.DOR_UC),
      vacant: FL_VACANT_UC.includes(s(p.DOR_UC)),
      jv, lndVal: parseFloat(p.LND_VAL) || 0,
      salePrice: price, saleYr: parseFloat(p.SALE_YR1) || 0, saleMo: s(p.SALE_MO1),
      yrBuilt: parseFloat(p.ACT_YR_BLT) || 0,
      sent: "",
    });
  };

  const refreshLots = () => {
    const m = mapRef.current; if (!m) return;
    clearTimeout(m.lotTimer);
    m.lotTimer = setTimeout(async () => {
      const z = m.map.getZoom();
      if (z < PARCEL_ZOOM) {
        if (m.lotCtrl) m.lotCtrl.abort();
        m.lotLayer.clearLayers(); m.selLot = null;
        setLots(null);
        return;
      }
      const ctr2 = m.map.getCenter();
      if (!inFlorida(ctr2.lat, ctr2.lng)) {
        if (m.lotCtrl) m.lotCtrl.abort();
        m.lotLayer.clearLayers(); m.selLot = null;
        setLots({ status: "na" });
        return;
      }
      if (m.lotCtrl) m.lotCtrl.abort();
      const ctrl = new AbortController(); m.lotCtrl = ctrl;
      setLots({ status: "loading" });
      const b = m.map.getBounds();
      const qs = new URLSearchParams({
        geometry: `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`,
        geometryType: "esriGeometryEnvelope", spatialRel: "esriSpatialRelIntersects",
        outFields: "*", returnGeometry: "true", inSR: "4326", outSR: "4326",
        f: "geojson", resultRecordCount: "1500",
      });
      try {
        const r = await fetch(`${FL_CADASTRAL}/query?${qs}`, { signal: ctrl.signal });
        const j = await r.json();
        if (ctrl.signal.aborted) return;
        const feats = j.features || [];
        m.lotLayer.clearLayers(); m.selLot = null;
        m.lotLayer.addLayer(m.L.geoJSON({ type: "FeatureCollection", features: feats }, {
          renderer: m.canvas, style: LOT_STYLE,
          onEachFeature: (f2, lyr) => lyr.on("click", (e) => openLotCard(f2, e.latlng, lyr)),
        }));
        setLots({ status: "done", count: feats.length });
      } catch (e) {
        if (!ctrl.signal.aborted) setLots({ status: "error" });
      }
    }, 350);
  };
  refreshLotsRef.current = refreshLots;

  /* ---- find a specific lot by APN or street address → fly + owner card ---- */
  const findLot = async (qRaw) => {
    const m = mapRef.current; if (!m) return;
    const q = String(qRaw || "").trim();
    if (!q) return;
    setFinder({ status: "loading" });
    try {
      let feat = null;
      const isAddress = /^\d+\s+[A-Za-z]/.test(q) || /\b(rd|road|st|street|ave|avenue|dr|drive|ln|lane|blvd|hwy|way|ct|court|cir|circle|ter|terrace|trl|trail|pkwy|loop)\b/i.test(q);
      if (!isAddress) {
        // APN — exact match on the indexed parcel id; try as-typed and digits-only forms
        const esc = (s) => s.replace(/'/g, "''");
        const cands = [...new Set([q.toUpperCase(), q, q.replace(/[^0-9A-Za-z]/g, "").toUpperCase()])].filter(Boolean);
        for (const c of cands) {
          const qs = new URLSearchParams({ where: `PARCEL_ID='${esc(c)}'`, outFields: "*", returnGeometry: "true", outSR: "4326", f: "geojson", resultRecordCount: "1" });
          const r = await fetch(`${FL_CADASTRAL}/query?${qs}`);
          const j = await r.json();
          if (j.features && j.features.length) { feat = j.features[0]; break; }
        }
        if (!feat) throw new Error("APN not on the FL roll — check the number (use your county's format, dashes included).");
      } else {
        // address → geocode → parcel under that point.
        // ArcGIS World Geocoder first (CORS ✓, exact US street matches; Census geocoder
        // is CORS-blocked in browsers, and Nominatim fuzzy-matches missing roads to the
        // wrong city — so Nominatim is fallback only).
        const nq = /florida|\bfl\b/i.test(q) ? q : q + ", FL";
        let px = null, py = null;
        try {
          const cr = await fetch(`https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?SingleLine=${encodeURIComponent(nq)}&f=json&maxLocations=1&outFields=Match_addr`);
          const cj = await cr.json();
          const hit = cj && cj.candidates && cj.candidates[0];
          if (hit && hit.score >= 80) { px = hit.location.x; py = hit.location.y; }
        } catch (_) { /* fall through to Nominatim */ }
        if (px == null) {
          const gr = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(nq)}`);
          const gj = await gr.json();
          if (!gj || !gj.length) throw new Error("Address not found — check spelling or add the ZIP.");
          px = parseFloat(gj[0].lon); py = parseFloat(gj[0].lat);
        }
        // NOTE: point/tiny-envelope queries hang or 400 on this service — use the proven
        // viewport-shaped query (~200m box, count 1500) and pick the parcel client-side.
        const d = 0.002;
        const qs = new URLSearchParams({ geometry: `${px - d},${py - d},${px + d},${py + d}`, geometryType: "esriGeometryEnvelope", spatialRel: "esriSpatialRelIntersects", inSR: "4326", outFields: "*", returnGeometry: "true", outSR: "4326", f: "geojson", resultRecordCount: "1500" });
        const r = await fetch(`${FL_CADASTRAL}/query?${qs}`);
        const j = await r.json();
        const feats = j.features || [];
        if (!feats.length) throw new Error("No parcels around that address — try its APN instead.");
        // Several polygons can contain the point (HOA tracts overlap house lots) — take the smallest
        const containing = feats.filter((f2) => featureContains(f2, px, py));
        if (containing.length) {
          const areaOf = (f2) => {
            const sq = parseFloat((f2.properties || {}).LND_SQFOOT) || 0;
            if (sq > 0) return sq;
            const g2 = f2.geometry, ring = g2 && (g2.type === "Polygon" ? g2.coordinates[0] : g2.type === "MultiPolygon" ? g2.coordinates[0][0] : null);
            if (!ring) return Infinity;
            let xs = ring.map((p2) => p2[0]), ys = ring.map((p2) => p2[1]);
            return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) * 1e10;
          };
          feat = containing.sort((a, b) => areaOf(a) - areaOf(b))[0];
        }
        if (!feat) { // geocode landed on the road — take the nearest lot
          let bd = Infinity;
          feats.forEach((f2) => {
            const c = featureRoughCenter(f2); if (!c) return;
            const dd = (c[0] - px) * (c[0] - px) + (c[1] - py) * (c[1] - py);
            if (dd < bd) { bd = dd; feat = f2; }
          });
        }
        if (!feat) throw new Error("No parcel under that address — try its APN instead.");
      }
      const gl = m.L.geoJSON(feat, { style: LOT_STYLE_SEL, interactive: false });
      const ctr = gl.getBounds().getCenter();
      openLotCard(feat, ctr, null);       // clears findLayer, fills the owner card
      m.findLayer.addLayer(gl);           // then drop the yellow highlight on the lot
      setFinder(null);
      m.map.setView(ctr, Math.max(m.map.getZoom(), 17), { animate: false }); // teleport — flyTo gets cancelled by any user drag mid-flight
    } catch (e) {
      setFinder({ status: "error", msg: String((e && e.message) || e) });
      setTimeout(() => setFinder((f) => (f && f.status === "error" ? null : f)), 7000);
    }
  };

  useEffect(() => {
    if (ready && lotFind && lotFind.seq && lotFind.q) findLot(lotFind.q);
  }, [ready, lotFind ? lotFind.seq : 0]);

  const cardLeadId = (c) => "gis_" + (c.apn ? c.apn.replace(/\s+/g, "") : `${c.lat.toFixed(6)}_${c.lng.toFixed(6)}`);
  const cardInPipeline = card && data && (data.leads || []).some((l) => l.id === cardLeadId(card));
  const sendToPipeline = () => {
    if (!card || !update || !data || cardInPipeline) return;
    const saleTxt = card.salePrice > 2000 && card.saleYr ? ` Last sale $${Math.round(card.salePrice).toLocaleString()} (${card.saleMo ? card.saleMo + "/" : ""}${card.saleYr}).` : "";
    const lead = {
      ...emptyLead(), id: cardLeadId(card),
      owner: card.owner, apn: card.apn, county: card.county, zip: card.zip,
      acres: card.acres > 0 ? card.acres.toFixed(3) : "",
      price: card.jv > 0 ? String(Math.round(card.jv)) : "",
      address: card.site, mailing: [card.mail1, card.mail2].filter(Boolean).join(", "),
      source: "Market Radar map", lat: card.lat, lng: card.lng, pstate: "FL",
      notes: `${card.ucLabel || ""}${card.vacant ? " (VACANT)" : ""}.${saleTxt} Pulled live from FL cadastral.`.trim(),
    };
    update({ ...data, leads: [lead, ...(data.leads || [])] });
    setCard({ ...card, sent: "ok" });
  };

  const mono = { fontFamily: "'JetBrains Mono', monospace" };
  const btnStyle = (col, solid) => ({
    ...mono, fontSize: 10.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", cursor: "pointer",
    padding: "7px 12px", borderRadius: 4, border: `1px solid ${col}`, background: solid ? col : "transparent",
    color: solid ? CC.abyss : col, whiteSpace: "nowrap",
  });

  return (
    <div style={{ marginTop: 14, background: CC.void, border: `1px solid ${CC.edge}`, borderRadius: 10, overflow: "hidden", color: CC.stake }}>
      <style>{RADAR_CSS}</style>

      {/* header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: `1px solid ${CC.edge}`, flexWrap: "wrap", gap: 8 }}>
        <div>
          <span style={{ ...mono, fontSize: 10, fontWeight: 700, letterSpacing: ".2em", textTransform: "uppercase", color: CC.phosphorDim }}>◎ Market Radar — FL · TX · NC · TN</span>
          <span style={{ ...mono, fontSize: 10, color: CC.stakeDim, marginLeft: 10 }}>{RADAR_HOTSPOTS.length} counties live · real permits · lot lines + owners at street zoom (FL){markets.length ? ` · ◈ ${markets.length} scouted` : ""}</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" onClick={() => runScan()} style={btnStyle(CC.phosphor, false)}>⌖ Scan sales in view</button>
          <button type="button" onClick={() => setBaseMode(baseMode === "auto" ? "dark" : baseMode === "dark" ? "sat" : "auto")} style={btnStyle(CC.cyan, false)}>
            {baseMode === "auto" ? `Auto · ${effBase === "sat" ? "satellite" : "dark"}` : baseMode === "dark" ? "Dark ops" : "Satellite"}
          </button>
        </div>
      </div>

      {/* top hotspots strip — filter by state, ranked within it */}
      <div className="ms-scroll" style={{ display: "flex", gap: 6, overflowX: "auto", padding: "9px 12px", borderBottom: `1px solid ${CC.edge}`, background: CC.abyss, alignItems: "center" }}>
        {["FL", "TX", "NC", "TN", "ALL"].map((s) => (
          <button key={s} type="button" onClick={() => { setStFilter(s); const m = mapRef.current; if (m) m.map.fitBounds(RADAR_BOUNDS[s]); }}
            style={{ ...mono, flex: "0 0 auto", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", cursor: "pointer", padding: "5px 9px", borderRadius: 4,
              border: `1px solid ${stFilter === s ? CC.phosphor : CC.edge}`, background: stFilter === s ? CC.mossLit : "transparent", color: stFilter === s ? CC.phosphor : CC.stakeDim }}>{s}</button>
        ))}
        <span style={{ width: 1, height: 18, background: CC.edge, flex: "0 0 auto" }} />
        {RADAR_HOTSPOTS.filter((c) => stFilter === "ALL" || c.st === stFilter).slice(0, 12).map((c, i) => (
          <button key={c.st + c.f} type="button" className="ms-chip" onClick={() => focusHotspot(c)}
            style={sel && sel.st === c.st && sel.f === c.f ? { borderColor: c.color, background: CC.mossLit } : undefined}>
            <span style={{ color: CC.stakeDim }}>{i + 1}</span>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: c.color, boxShadow: `0 0 6px ${c.color}`, flexShrink: 0 }} />
            {c.n}{stFilter === "ALL" ? `, ${c.st}` : ""}
            <span style={{ color: c.color }}>{c.score}</span>
          </button>
        ))}
      </div>

      {/* map + radar overlay */}
      <div style={{ position: "relative" }}>
        <div ref={mapEl} className={"ms-map" + (tilesDead ? " ms-nogrid" : "")} style={{ height: "min(56vh, 520px)", minHeight: 360, zIndex: 0 }} />
        {mapErr && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: CC.abyss, zIndex: 600 }}>
            <div style={{ ...mono, fontSize: 12, color: CC.amber, textAlign: "center", padding: 20 }}>⚠ Live map unavailable ({mapErr}).<br />Hotspot rankings and dossiers below still run on real permit data.</div>
          </div>
        )}
        {scan && scan.status === "loading" && (
          <div style={{ position: "absolute", top: 10, left: 10, zIndex: 600, ...mono, fontSize: 11, color: CC.phosphor, background: "rgba(7,11,10,.85)", border: `1px solid ${CC.edgeLit}`, borderRadius: 4, padding: "6px 12px" }}>
            ⌖ SCANNING ~1.5 MI OF PARCELS FOR RECENT SALES…
          </div>
        )}

        {/* lot finder status */}
        {finder && (
          <div style={{ position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 660, maxWidth: "calc(100% - 20px)", ...mono, fontSize: 11,
            color: finder.status === "error" ? CC.amber : CC.cyan, background: "rgba(7,11,10,.92)", border: `1px solid ${finder.status === "error" ? CC.amber : CC.edgeLit}`, borderRadius: 4, padding: "6px 12px" }}>
            {finder.status === "loading" ? "⌖ LOCATING LOT ON THE FL ROLL…" : `⚠ ${finder.msg}`}
          </div>
        )}

        {/* lot-lines status */}
        {ready && !mapErr && (zoom >= 11 || lots) && (
          <div style={{ position: "absolute", top: scan && scan.status === "loading" ? 44 : 10, left: 10, zIndex: 600, ...mono, fontSize: 10.5, background: "rgba(7,11,10,.85)", border: `1px solid ${CC.edge}`, borderRadius: 4, padding: "5px 10px",
            color: lots && lots.status === "loading" ? CC.cyan : lots && lots.status === "done" ? CC.phosphor : CC.stakeDim }}>
            {lots && lots.status === "na" ? "◻ LOT LINES & OWNERS: FLORIDA ONLY (MORE STATES NEXT)"
              : zoom < PARCEL_ZOOM ? `◻ ZOOM ${PARCEL_ZOOM - Math.floor(zoom)} MORE FOR LOT LINES + OWNERS`
              : !lots || lots.status === "loading" ? "◻ PULLING LOT LINES…"
              : lots.status === "error" ? "◻ LOT PULL FAILED — PAN TO RETRY"
              : lots.count >= 1500 ? `◻ ${lots.count}+ LOTS (CAP) — TIGHTEN VIEW · TAP A LOT FOR THE OWNER`
              : `◻ ${lots.count} LOTS LIVE · TAP A LOT FOR THE OWNER`}
          </div>
        )}

        {/* ownership card — pulled live from the FL statewide cadastral */}
        {card && (
          <div className="ms-scroll" style={{ position: "absolute", left: 10, bottom: 10, zIndex: 650, width: "min(330px, calc(100% - 20px))", maxHeight: "80%", overflowY: "auto",
            background: "rgba(7,11,10,.95)", border: `1px solid ${CC.edgeLit}`, borderRadius: 8, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <div style={{ ...mono, fontSize: 9.5, fontWeight: 700, letterSpacing: ".2em", color: CC.phosphorDim }}>OWNER · LIVE COUNTY ROLL</div>
              <button type="button" onClick={closeCard} style={{ ...mono, background: "none", border: "none", color: CC.stakeDim, fontSize: 14, cursor: "pointer", lineHeight: 1, padding: 0 }}>✕</button>
            </div>
            <div style={{ fontSize: 15.5, fontWeight: 800, color: CC.stake, marginTop: 6, lineHeight: 1.25 }}>{card.owner || "Owner not listed"}</div>
            {(card.mail1 || card.mail2) && (
              <div style={{ fontSize: 11.5, color: CC.stakeDim, marginTop: 3, lineHeight: 1.45 }}>
                ✉ {card.mail1}{card.mail1 && card.mail2 ? ", " : ""}{card.mail2}
              </div>
            )}
            <div style={{ height: 1, background: CC.edge, margin: "10px 0" }} />
            <div style={{ display: "grid", gap: 5 }}>
              {card.site && <div style={{ fontSize: 12, color: CC.stake }}>◻ {card.site}</div>}
              <div style={{ ...mono, fontSize: 10.5, color: CC.stakeDim }}>APN {card.apn || "—"} · {card.county} Co.</div>
              <div style={{ fontSize: 12, color: CC.stake }}>
                {card.acres > 0 ? `${card.acres.toFixed(2)} ac` : "— ac"} · {card.ucLabel || "use unknown"}
                {card.vacant && <span style={{ ...mono, fontSize: 9, fontWeight: 700, letterSpacing: ".1em", color: CC.abyss, background: CC.phosphor, borderRadius: 3, padding: "2px 6px", marginLeft: 7 }}>VACANT LAND</span>}
                {!card.vacant && card.yrBuilt > 0 && <span style={{ color: CC.stakeDim }}> · built {card.yrBuilt}</span>}
              </div>
              {card.salePrice > 2000 && card.saleYr > 0 && (
                <div style={{ fontSize: 12, color: CC.stake }}>
                  Last sale <b>${Math.round(card.salePrice).toLocaleString()}</b> <span style={{ color: CC.stakeDim }}>({card.saleMo ? card.saleMo + "/" : ""}{card.saleYr})</span>
                  {card.acres > 0 && <span style={{ ...mono, color: CC.phosphor }}> · ${Math.round(card.salePrice / card.acres).toLocaleString()}/ac</span>}
                </div>
              )}
              {card.jv > 0 && <div style={{ fontSize: 12, color: CC.stakeDim }}>County just value ${Math.round(card.jv).toLocaleString()}{card.lndVal > 0 && card.lndVal !== card.jv ? ` · land $${Math.round(card.lndVal).toLocaleString()}` : ""}</div>}
            </div>
            <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
              {card.sent === "ok" || cardInPipeline
                ? <div style={{ ...mono, fontSize: 10.5, color: CC.phosphor, textAlign: "center", border: `1px dashed ${CC.phosphorDim}`, borderRadius: 4, padding: "7px 10px" }}>✓ IN PIPELINE — skip trace &amp; call</div>
                : <button type="button" onClick={sendToPipeline} style={btnStyle(CC.phosphor, true)}>→ Send owner to pipeline</button>}
              <div style={{ display: "flex", gap: 6 }}>
                <a href={g(`${card.owner} ${card.county} County FL`)} target="_blank" rel="noreferrer" style={{ ...btnStyle(CC.cyan, false), flex: 1, textAlign: "center", textDecoration: "none" }}>Google owner ↗</a>
                <a href={g(`${card.apn} ${card.county} County FL property appraiser`)} target="_blank" rel="noreferrer" style={{ ...btnStyle(CC.amber, false), flex: 1, textAlign: "center", textDecoration: "none" }}>Appraiser ↗</a>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* land-sale scan readout */}
      {scan && scan.status !== "loading" && (
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", padding: "10px 14px", borderTop: `1px solid ${CC.edge}`, background: CC.abyss }}>
          {scan.status === "na" && <span style={{ ...mono, fontSize: 11.5, color: CC.amber }}>Land-sale scans cover Florida only right now — TX / NC / TN parcel feeds are next.</span>}
          {scan.status === "zoom" && <span style={{ ...mono, fontSize: 11.5, color: CC.amber }}>Zoom into a spot first (or hit “Scan land sales” on a hotspot) — each scan covers ~1.5 mi.</span>}
          {scan.status === "error" && <span style={{ ...mono, fontSize: 11.5, color: CC.amber }}>Scan timed out — the state parcel server hiccuped. Try again.</span>}
          {scan.status === "done" && (
            <>
              <span style={{ ...mono, fontSize: 11.5, color: CC.phosphor, fontWeight: 700 }}>● {scan.vacCount} vacant-land sale{scan.vacCount === 1 ? "" : "s"}</span>
              {scan.medPpa > 0 && <span style={{ ...mono, fontSize: 11.5, color: CC.stake }}>median ${scan.medPpa.toLocaleString()}/ac</span>}
              <span style={{ ...mono, fontSize: 11.5, color: CC.stakeDim }}>○ {scan.impCount} improved · {scan.parcels.toLocaleString()} parcels swept · last 2 yrs, ~1.5 mi window</span>
              {scan.vacCount === 0 && <span style={{ ...mono, fontSize: 11.5, color: CC.amber }}>No recent land sales in window — tight supply or slow corner. Pan and rescan.</span>}
            </>
          )}
          <button type="button" onClick={clearScan} style={{ ...btnStyle(CC.stakeDim, false), marginLeft: "auto" }}>Clear</button>
        </div>
      )}

      {/* hotspot dossier — collapsible */}
      {sel && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderTop: `1px solid ${CC.edge}`, background: CC.abyss, flexWrap: "wrap" }}>
          {dossOpen ? (
            <span style={{ ...mono, fontSize: 10, fontWeight: 700, letterSpacing: ".2em", textTransform: "uppercase", color: CC.phosphorDim }}>▙ County dossier</span>
          ) : (
            <>
              <span style={{ width: 9, height: 9, borderRadius: 99, background: sel.color, boxShadow: `0 0 6px ${sel.color}`, flexShrink: 0 }} />
              <span style={{ ...mono, fontSize: 11.5, fontWeight: 700, color: CC.stake }}>{sel.n} County, {sel.st}</span>
              <span style={{ ...mono, fontSize: 11.5, fontWeight: 700, color: sel.color }}>{sel.score} · {sel.tier}</span>
              <span style={{ ...mono, fontSize: 10.5, color: CC.stakeDim }}>{sel.u25.toLocaleString()} permits '25 · {sel.chg >= 0 ? "+" : ""}{sel.chg}% pace</span>
            </>
          )}
          <button type="button" onClick={() => setDossOpen(!dossOpen)} style={{ ...btnStyle(CC.stakeDim, false), marginLeft: "auto", padding: "4px 10px" }}>
            {dossOpen ? "▾ Minimize" : "▸ Details"}
          </button>
        </div>
      )}
      {sel && dossOpen && (
        <div style={{ borderTop: `1px solid ${CC.edge}`, padding: 14, display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", alignItems: "start" }}>
          <div>
            <span style={{ ...mono, fontSize: 10, fontWeight: 700, letterSpacing: ".14em", color: sel.color, border: `1px solid ${sel.color}`, borderRadius: 3, padding: "2px 8px" }}>{sel.tier}</span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 8 }}>
              <span style={{ ...mono, fontSize: 42, fontWeight: 600, color: sel.color, lineHeight: 1 }}>{sel.score}</span>
              <span className="lc-display" style={{ fontSize: 19, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".03em" }}>{sel.n} County, {sel.st}</span>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, color: CC.stake, marginTop: 8 }}>{hotspotInsight(sel)}</div>
          </div>
          <div>
            <div style={{ ...mono, fontSize: 10, fontWeight: 700, letterSpacing: ".16em", textTransform: "uppercase", color: CC.phosphorDim, marginBottom: 8 }}>SF permits — builder demand</div>
            {[["2024", sel.u24], ["2025", sel.u25], ["2026 pace", sel.pace26]].map(([lab, v], i) => {
              const max = Math.max(sel.u24, sel.u25, sel.pace26, 1);
              return (
                <div key={lab} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ ...mono, fontSize: 10.5, color: CC.stakeDim, width: 68, flexShrink: 0 }}>{lab}</span>
                  <div style={{ flex: 1, height: 12, background: CC.moss, borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ width: `${Math.max(2, (v / max) * 100)}%`, height: "100%", background: i === 2 ? sel.color : CC.phosphorDim, opacity: i === 2 ? 1 : 0.7 }} />
                  </div>
                  <span style={{ ...mono, fontSize: 11, color: i === 2 ? sel.color : CC.stake, width: 52, textAlign: "right", flexShrink: 0 }}>{v.toLocaleString()}</span>
                </div>
              );
            })}
            <div style={{ ...mono, fontSize: 10, color: CC.stakeDim, marginTop: 6 }}>momentum {sel.chg >= 0 ? "+" : ""}{sel.chg}% vs '25 · #{stateRank(sel).rank} of {stateRank(sel).of} {sel.st} counties</div>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            <button type="button" onClick={() => onScout(`${sel.n} County, ${sel.st}`)} style={btnStyle(CC.phosphor, true)}>Deep scout ↗ live web recon</button>
            {sel.st === "FL"
              ? <button type="button" onClick={() => scanHotspot(sel)} style={btnStyle(CC.cyan, false)}>⌖ Scan land sales here</button>
              : <div style={{ ...mono, fontSize: 9.5, color: CC.stakeDim, textAlign: "center", border: `1px dashed ${CC.edge}`, borderRadius: 4, padding: "7px 10px" }}>SALES SCAN + LOT LINES: FL ONLY (NEXT: {sel.st})</div>}
            <button type="button" onClick={() => onCreateBox(sel.n, sel.st)} style={btnStyle(CC.amber, false)}>+ Start a buy box</button>
          </div>
        </div>
      )}

      {/* legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: "9px 14px", borderTop: `1px solid ${CC.edge}`, alignItems: "center" }}>
        <span style={{ ...mono, fontSize: 9.5, color: CC.stakeDim, letterSpacing: ".1em" }}>HEAT:</span>
        {RADAR_TIERS.map(([lab, col]) => (
          <span key={lab} style={{ ...mono, display: "flex", alignItems: "center", gap: 5, fontSize: 9.5, color: CC.stakeDim }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: col }} />{lab}
          </span>
        ))}
        <span style={{ ...mono, fontSize: 9.5, color: CC.stakeDim, marginLeft: "auto" }}>US Census permits '24 · '25 · '26 YTD (May), FL·TX·NC·TN — lots, owners &amp; sales: FL cadastral, live</span>
      </div>
    </div>
  );
}
