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
  try { await window.storage.set(STORE_KEY, JSON.stringify(data)); } catch (e) { /* in-memory only */ }
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
  if (hard.length) { verdict = "NO GO — DEAL BREAKER"; color = C.red; bg = C.redPale; }
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

function BuyBoxesTab({ data, update }) {
  const [editing, setEditing] = useState(null); // box object or null
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
  if (!box || !links) return (
    <div style={{ border: `2px dashed ${C.line}`, borderRadius: 8, padding: 40, textAlign: "center", color: C.faint }}>
      Select a buy box above to load sourcing links.
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

function PipelineTab({ data, update, onResumeDeal }) {
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

  const buildCSV = () => leadsToCSV(data.leads);

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
        price: pick(row, ["price","targetprice","askingprice","listprice","assessedvalue","marketvalue"]),
        offer: pick(row, ["myoffer","offer","youroffer"]),
        status: pick(row, ["status"]) || "New",
        buybox: pick(row, ["buybox","matchedbuybox"]),
        notes: pick(row, ["notes","note","comments"]),
        source: pick(row, ["source","leadsource"]) || "CSV import",
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
                  {onResumeDeal && <Btn small onClick={() => onResumeDeal(l)}>▶ {l.stage ? "Resume" : "Work"} Deal</Btn>}
                  <Btn small kind="ghost" onClick={() => setScriptsFor(scriptsFor === l.id ? null : l.id)}>{scriptsFor === l.id ? "▾ Hide" : "✍ Scripts"}</Btn>
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
  ["gis", "Map"],
  ["boxes", "Buy Boxes"],
  ["find", "Find Deals"],
  ["match", "Match a Parcel"],
  ["calc", "Deal Calc"],
  ["pipeline", "Pipeline"],
];

/* ============================================================
   GUIDED ACQUISITION FUNNEL — first touch → call → diligence →
   agreement → assign → title/escrow → close. Auto-saved per lead.
   ============================================================ */
const SCRIPTS = {
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

function titleScript(lead, settings, box) {
  const me = settings.myName || "Deivan";
  const co = settings.myCompany || "our company";
  const closeDays = (box && box.closeDays) || "30";
  return { title: "Title & Escrow — opening call", body:
`"Hi, this is ${me} with ${co}. I have a signed purchase agreement on a vacant lot — parcel ${lead.apn || "(APN)"} in ${lead.county || "(county)"} County — and I'd like to open title and escrow.\n\n• It's a cash purchase, closing in about ${closeDays} days; buyer pays all closing costs.\n• Please run a title search / commitment and flag any liens, easements, back taxes, or access issues.\n• Send the commitment to me and both parties, and let me know earnest-money wiring instructions.\n\nWhat do you need from me to get started today?"` };
}

function FunnelScript({ title, body }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span className="lc-display" style={{ fontWeight: 800, fontSize: 14, textTransform: "uppercase", letterSpacing: ".04em" }}>{title}</span>
        <button onClick={async () => { await copyText(body); setCopied(true); setTimeout(() => setCopied(false), 1600); }}
          style={{ padding: "5px 12px", borderRadius: 6, border: `1px solid ${C.line}`, background: copied ? C.green : "#fff", color: copied ? "#fff" : C.ink, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{copied ? "Copied ✓" : "Copy"}</button>
      </div>
      <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13, lineHeight: 1.55, color: C.ink, fontFamily: "'Inter',system-ui,sans-serif" }}>{body}</pre>
    </div>
  );
}

function FunnelComps({ lead }) {
  const [res, setRes] = useState(null);
  useEffect(() => {
    let live = true;
    if (lead.lat == null || lead.lng == null) { setRes({ unsupported: true }); return; }
    fetchComps(lead.lat, lead.lng, parseFloat(lead.acres) || 0, lead.pstate, "").then(r => { if (live) setRes(r); });
    return () => { live = false; };
  }, [lead.id]);
  const box = { background: "#161d2e", border: "1px solid #1e2a3a", borderRadius: 10, padding: 16, marginBottom: 14 };
  if (!res) return <div style={box}><span style={{ color: "#64748b", fontSize: 13 }}>◌ Pulling live comps for this lot…</span></div>;
  if (res.unsupported) return <div style={box}><span style={{ color: "#64748b", fontSize: 13 }}>Live comps run on Florida parcels today (its data carries sale price + date). Other states need a sales feed.</span></div>;
  if (res.timeout) return <div style={box}><span style={{ color: "#64748b", fontSize: 13 }}>Comp service was slow — reopen this lead to retry.</span></div>;
  return (
    <div style={box}>
      <div style={{ fontSize: 11, letterSpacing: 2, color: "#475569", textTransform: "uppercase", marginBottom: 12 }}>📊 Live Comps — back up your number</div>
      <CompsColumns res={res} pal={{ accent: "#f59e0b", dim: "#64748b", text: "#e2e8f0", line: "#1e2a3a", panel: "#13181f", hot: "#1f1500" }} />
    </div>
  );
}

function ContractSend({ lead, data, update }) {
  const st = lead.pstate || "";
  const contracts = (data.settings && data.settings.contracts) || {};
  const url = contracts[st] || "";
  const setUrl = (v) => update({ ...data, settings: { ...(data.settings || {}), contracts: { ...contracts, [st]: v } } });
  const subject = `Cash Purchase Agreement — your ${lead.acres ? lead.acres + "-acre " : ""}lot${lead.apn ? " (APN " + lead.apn + ")" : ""}`;
  const bodyTxt = `Hi ${(lead.owner || "").split(" ")[0] || "there"}, as promised here's the cash purchase agreement for your lot${lead.address ? " at " + lead.address : ""}. I cover all closing costs and we close through a licensed title company.${url ? "\n\nAgreement: " + url : ""}\n\nReply or text me with any questions.`;
  const mailto = `mailto:${lead.email || ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyTxt)}`;
  const sms = `sms:${(lead.phone || "").replace(/[^0-9+]/g, "")}?&body=${encodeURIComponent(bodyTxt)}`;
  return (
    <div style={{ background: "#161d2e", border: "1px solid #1e2a3a", borderRadius: 10, padding: 16, marginBottom: 14 }}>
      <div style={{ fontSize: 11, letterSpacing: 2, color: "#475569", textTransform: "uppercase", marginBottom: 10 }}>✍ Send the {st || "state"} purchase agreement</div>
      <input value={url} onChange={e => setUrl(e.target.value)} placeholder={`Paste your ${st || "state"} contract link (Drive / DocuSign / PDF URL)`}
        style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #1e2a3a", background: "#0c0e14", color: "#e2e8f0", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 10 }} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <a href={mailto} style={{ padding: "10px 16px", borderRadius: 8, background: "#f59e0b", color: "#000", fontWeight: 700, fontSize: 13, textDecoration: "none" }}>✉ Email contract</a>
        <a href={sms} style={{ padding: "10px 16px", borderRadius: 8, background: "transparent", color: "#e2e8f0", border: "1px solid #1e2a3a", fontWeight: 700, fontSize: 13, textDecoration: "none" }}>✆ Text contract</a>
        {url && <a href={url} target="_blank" rel="noreferrer" style={{ alignSelf: "center", color: "#3b82f6", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>↗ Preview</a>}
      </div>
      <div style={{ fontSize: 11, color: "#475569", marginTop: 10, lineHeight: 1.5 }}>Paste your firm's state agreement once — saved for every {st || "state"} deal. Opens your email/messages pre-filled to the seller.</div>
    </div>
  );
}

function BuyerMatch({ lead, data }) {
  const boxes = data.buyboxes || [];
  const pkg = `LAND PACKAGE\nParcel: ${lead.apn || "—"} · ${lead.county || ""} County, ${lead.pstate || ""}\nSize: ${lead.acres || "?"} ac\nAddress: ${lead.address || "—"}\nMy price to you: $______\nClose: cash, ~30 days, clean title.`;
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, marginBottom: 12 }}>
      <div className="lc-label">Match to a builder / end buyer</div>
      {!boxes.length && <div style={{ fontSize: 12.5, color: C.faint }}>No buy boxes yet — add builders in the Buy Boxes tab to match against.</div>}
      <div style={{ display: "grid", gap: 6 }}>
        {boxes.map(b => (
          <div key={b.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: `1px solid ${C.line}`, borderRadius: 6, padding: "8px 10px" }}>
            <span style={{ fontSize: 13 }}><strong>{b.builder || "Unnamed"}</strong> <span style={{ color: C.faint }}>{splitList(b.counties).join(", ")}</span></span>
            <a href={`sms:?&body=${encodeURIComponent(pkg)}`} style={{ fontSize: 12, fontWeight: 700, color: C.blue, textDecoration: "none" }}>Send package →</a>
          </div>
        ))}
      </div>
      <button onClick={() => copyText(pkg)} style={{ marginTop: 8, padding: "7px 12px", borderRadius: 6, border: `1px solid ${C.line}`, background: "#fff", color: C.ink, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Copy buyer package</button>
    </div>
  );
}

// Renders ONE call script exactly as the attached file — steps, say/tip blocks, questions,
// rebuttals, and the "before you hang up" capture list. Step + checkboxes persist on the lead.
// Auto-fill the script's [PLACEHOLDERS] with live lead data + the caller's name (Deivan by default).
function fillScript(text, lead, settings, side) {
  if (!text || typeof text !== "string") return text;
  const me = (settings && settings.myName) || "Deivan";
  const phone = (settings && settings.myPhone) || "[PHONE]";
  const owner = side === "builder" ? (lead.buybox || "[OWNER NAME]") : (lead.owner || "[OWNER NAME]");
  const nm = side === "builder" ? (lead.buybox || "[NAME]") : (lead.owner || "[NAME]");
  const area = lead.address || (lead.county ? `${lead.county} County` : null);
  const county = lead.county ? `${lead.county} County` : null;
  let t = text.replace(/\[YOUR NAME\]/g, me).replace(/\[PHONE\]/g, phone).replace(/\[OWNER NAME\]/g, owner).replace(/\[NAME\]/g, nm);
  if (area) t = t.replace(/\[ROAD \/ PARCEL AREA\]/g, area).replace(/\[ROAD \/ GENERAL AREA\]/g, area).replace(/\[ROAD \/ AREA\]/g, area);
  if (county) t = t.replace(/\[GENERAL AREA\]/g, county).replace(/\[AREA\/MARKET\]/g, county).replace(/\[MARKET\]/g, county);
  return t;
}

function ScriptRunner({ script, step, onStep, checks, onToggle, fill }) {
  const F = fill || ((x) => x);
  const i = Math.max(0, Math.min(script.steps.length - 1, step));
  const s = script.steps[i];
  return (
    <div>
      <div style={{ background: "#161d2e", padding: "14px 16px", borderRadius: 10, border: "1px solid #1a2030", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ background: script.badgeColor + "22", color: script.badgeColor, fontSize: 9, fontWeight: 800, letterSpacing: 1.5, padding: "2px 6px", borderRadius: 3 }}>{script.badge}</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>{script.title}</span>
        </div>
        <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 5 }}>🎯 Goal: {script.goal}</div>
      </div>
      <div style={{ display: "flex", overflowX: "auto", gap: 6, paddingBottom: 4, marginBottom: 18 }}>
        {script.steps.map((st, idx) => (
          <button key={st.id} onClick={() => onStep(idx)} style={{ padding: "7px 15px", borderRadius: 20, border: `1px solid ${i === idx ? script.accent : "#1e2a3a"}`, cursor: "pointer", whiteSpace: "nowrap", fontSize: 12, fontWeight: 600, background: i === idx ? script.accent + "22" : "transparent", color: i === idx ? script.accent : "#64748b" }}>{st.icon} {st.label}</button>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 24 }}>{s.icon}</span>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#f1f5f9" }}>{s.label}</div>
      </div>
      <div style={{ background: "#161d2e", borderLeft: `3px solid ${script.accent}`, borderRadius: "0 8px 8px 0", padding: "12px 16px", fontSize: 13, color: "#94a3b8", marginBottom: 24, lineHeight: 1.65 }}>{F(s.intro)}</div>
      {s.blocks && s.blocks.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          {s.blocks.map((b, bi) => (
            <div key={bi} style={{ background: b.bg, border: `1px solid ${b.color}33`, borderRadius: 10, padding: "14px 18px", marginBottom: 12, lineHeight: 1.75 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 2, color: b.color, marginBottom: 8, textTransform: "uppercase" }}>{b.type === "say" ? "🎙" : b.type === "tip" ? "💡" : "🔵"} {b.label}</div>
              <div style={{ fontSize: 14, color: "#e2e8f0" }}>{F(b.text)}</div>
            </div>
          ))}
        </div>
      )}
      {s.questions && s.questions.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 11, letterSpacing: 2, color: "#475569", textTransform: "uppercase", marginBottom: 14 }}>Questions to Cover</div>
          {s.questions.map((item, qi) => {
            const key = `${script.id}-${s.id}-q${qi}`, done = checks[key];
            return (
              <div key={qi} onClick={() => onToggle(key)} style={{ display: "flex", gap: 12, alignItems: "flex-start", background: done ? "#0f2a1a" : "#13181f", border: `1px solid ${done ? "#22c55e44" : "#1e2a3a"}`, borderRadius: 10, padding: "13px 16px", marginBottom: 9, cursor: "pointer" }}>
                <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${done ? "#22c55e" : "#334155"}`, background: done ? "#22c55e" : "transparent", flexShrink: 0, marginTop: 2, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#000" }}>{done ? "✓" : ""}</div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: done ? "#6ee7b7" : "#e2e8f0", marginBottom: 4 }}>"{item.q}"</div>
                  <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.5 }}><span style={{ color: script.accent }}>Why: </span>{item.why}</div>
                </div>
              </div>
            );
          })}
          <div style={{ fontSize: 11, color: "#1e2a3a", marginTop: 6 }}>Tap a question to mark it covered.</div>
        </div>
      )}
      {s.rebuttals && s.rebuttals.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 11, letterSpacing: 2, color: "#475569", textTransform: "uppercase", marginBottom: 14 }}>Rebuttals</div>
          {s.rebuttals.map((r, ri) => (
            <div key={ri} style={{ background: "#13101a", border: "1px solid #2d1f3a", borderRadius: 10, padding: "14px 18px", marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#ef4444", marginBottom: 8 }}>THEM: {F(r.them)}</div>
              <div style={{ fontSize: 14, color: "#fde68a", lineHeight: 1.7 }}><span style={{ color: "#f59e0b", fontWeight: 700, fontSize: 11 }}>YOU: </span>{F(r.you)}</div>
            </div>
          ))}
        </div>
      )}
      {s.comeback && s.comeback.length > 0 && (
        <div style={{ background: "#1a1500", border: `1px solid ${script.accent}44`, borderLeft: `3px solid ${script.accent}`, borderRadius: "0 10px 10px 0", padding: "16px 20px" }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 2, color: script.accent, marginBottom: 12, textTransform: "uppercase" }}>📋 Before You Hang Up — Capture This</div>
          {s.comeback.map((item, ci) => {
            const key = `${script.id}-${s.id}-c${ci}`, done = checks[key];
            return (
              <div key={ci} onClick={() => onToggle(key)} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, cursor: "pointer" }}>
                <div style={{ width: 16, height: 16, borderRadius: 3, border: `2px solid ${done ? script.accent : "#334155"}`, background: done ? script.accent : "transparent", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: "#000" }}>{done ? "✓" : ""}</div>
                <div style={{ fontSize: 13, color: done ? "#94a3b8" : "#cbd5e1", textDecoration: done ? "line-through" : "none" }}>{item}</div>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
        <button onClick={() => onStep(Math.max(0, i - 1))} disabled={i === 0} style={{ padding: "10px 20px", borderRadius: 8, border: "1px solid #1e2a3a", background: "transparent", color: i === 0 ? "#1e2a3a" : "#94a3b8", fontSize: 13, fontWeight: 600, cursor: i === 0 ? "default" : "pointer" }}>← Previous</button>
        <button onClick={() => onStep(Math.min(script.steps.length - 1, i + 1))} disabled={i === script.steps.length - 1} style={{ padding: "10px 20px", borderRadius: 8, border: "none", background: i === script.steps.length - 1 ? "#1e2a3a" : script.accent, color: i === script.steps.length - 1 ? "#334155" : "#000", fontSize: 13, fontWeight: 700, cursor: i === script.steps.length - 1 ? "default" : "pointer" }}>Next Step →</button>
      </div>
    </div>
  );
}

function PhaseChecklist({ phase, checks, toggle }) {
  if (!phase.checklist) return null;
  return (
    <div style={{ background: "#161d2e", border: "1px solid #1e2a3a", borderRadius: 10, padding: 16, marginBottom: 14 }}>
      <div style={{ fontSize: 11, letterSpacing: 2, color: "#475569", textTransform: "uppercase", marginBottom: 12 }}>Checklist</div>
      <div style={{ display: "grid", gap: 8 }}>
        {phase.checklist.map((item, j) => {
          const k = `${phase.key}.${j}`, done = checks[k];
          return (
            <div key={k} onClick={() => toggle(k)} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
              <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${done ? "#22c55e" : "#334155"}`, background: done ? "#22c55e" : "transparent", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, color: "#000" }}>{done ? "✓" : ""}</div>
              <div style={{ fontSize: 13.5, color: done ? "#94a3b8" : "#cbd5e1", textDecoration: done ? "line-through" : "none" }}>{item}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FunnelScriptDark({ title, body }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ background: "#0f2a1a", border: "1px solid #22c55e33", borderRadius: 10, padding: "14px 18px", marginBottom: 14, lineHeight: 1.75 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 2, color: "#22c55e", textTransform: "uppercase" }}>🎙 {title}</span>
        <button onClick={async () => { await copyText(body); setCopied(true); setTimeout(() => setCopied(false), 1600); }}
          style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid #1e2a3a", background: copied ? "#22c55e" : "transparent", color: copied ? "#000" : "#94a3b8", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{copied ? "Copied ✓" : "Copy"}</button>
      </div>
      <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 14, color: "#e2e8f0", fontFamily: "'Inter',system-ui,sans-serif" }}>{body}</pre>
    </div>
  );
}

const DEAL_PHASES = [
  { key: "seller", label: "📞 Seller Call", script: "seller" },
  { key: "comps", label: "📊 Comps", tool: "comps" },
  { key: "agreement", label: "✍ Agreement", tool: "contract", checklist: ["Agreed on price", "Purchase agreement sent", "Purchase agreement SIGNED", "Earnest-money terms set", "Title company chosen", "Owner mailing address confirmed"] },
  { key: "buyer", label: "🤝 Buyer Call", script: "builder" },
  { key: "close", label: "🏁 Title & Close", tool: "close", checklist: ["Title ordered", "Title commitment reviewed / clear", "Escrow opened", "Closing date scheduled", "Assignment fee collected", "Deed recorded — mark Closed"] },
];

function DealFlow({ lead, data, update, onClose }) {
  const settings = data.settings || {};
  const box = data.buyboxes.find(b => b.builder === lead.buybox) || data.buyboxes[0] || {};
  const phaseIdx = Math.max(0, Math.min(DEAL_PHASES.length - 1, lead.phase || 0));
  const P = DEAL_PHASES[phaseIdx];
  const checks = lead.checks || {};
  const steps = lead.scriptSteps || {};
  const saveLead = (patch) => update({ ...data, leads: data.leads.map(l => l.id === lead.id ? { ...l, ...patch } : l) });
  const goPhase = (i) => saveLead({ phase: Math.max(0, Math.min(DEAL_PHASES.length - 1, i)) });
  const toggle = (k) => saveLead({ checks: { ...checks, [k]: !checks[k] } });
  const setStep = (id, i) => saveLead({ scriptSteps: { ...steps, [id]: i } });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 3000, background: "#0c0e14", display: "flex", flexDirection: "column", fontFamily: "'Inter',system-ui,sans-serif", color: "#e2e8f0" }}>
      <style>{FONTS}</style>
      <div style={{ background: "#10131c", borderBottom: "1px solid #1a2030", padding: "11px 16px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <button onClick={onClose} style={{ padding: "7px 13px", borderRadius: 8, border: "1px solid #1e2a3a", background: "transparent", color: "#94a3b8", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>← Map</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: "#f1f5f9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{lead.owner || "New Lead"}</div>
          <div className="lc-mono" style={{ fontSize: 11, color: "#475569", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{lead.address || (lead.acres ? lead.acres + " ac" : "")}{lead.county ? ` · ${lead.county} Co, ${lead.pstate || ""}` : ""} · auto-saved ✓</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 5, padding: "9px 12px", overflowX: "auto", background: "#10131c", borderBottom: "1px solid #1a2030", flexShrink: 0 }}>
        {DEAL_PHASES.map((p, i) => (
          <button key={p.key} onClick={() => goPhase(i)} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 20, border: `1px solid ${i === phaseIdx ? "#f59e0b" : "#1e2a3a"}`, background: i === phaseIdx ? "#f59e0b22" : "transparent", color: i === phaseIdx ? "#f59e0b" : "#64748b", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>{p.label}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "18px 20px 56px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          {P.script && <ScriptRunner script={SCRIPTS[P.script]} step={steps[P.script] || 0} onStep={(i) => setStep(P.script, i)} checks={checks} onToggle={toggle} fill={(t) => fillScript(t, lead, settings, P.script)} />}
          {P.tool === "comps" && <FunnelComps lead={lead} />}
          {P.tool === "contract" && (<><ContractSend lead={lead} data={data} update={update} /><PhaseChecklist phase={P} checks={checks} toggle={toggle} /></>)}
          {P.tool === "close" && (<><FunnelScriptDark {...titleScript(lead, settings, box)} /><PhaseChecklist phase={P} checks={checks} toggle={toggle} /></>)}
          <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
            <button onClick={() => goPhase(phaseIdx - 1)} disabled={phaseIdx === 0} style={{ padding: "11px 18px", borderRadius: 8, border: "1px solid #1e2a3a", background: "transparent", color: phaseIdx === 0 ? "#1e2a3a" : "#94a3b8", fontWeight: 700, fontSize: 13.5, cursor: phaseIdx === 0 ? "default" : "pointer" }}>← Back</button>
            <button onClick={() => phaseIdx === DEAL_PHASES.length - 1 ? onClose() : goPhase(phaseIdx + 1)} style={{ flex: 1, padding: "11px 18px", borderRadius: 8, border: "none", background: "#f59e0b", color: "#000", fontWeight: 800, fontSize: 13.5, cursor: "pointer" }}>{phaseIdx === DEAL_PHASES.length - 1 ? "Finish — back to Map" : `Next: ${DEAL_PHASES[phaseIdx + 1].label} →`}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function useIsMobile() {
  const [m, setM] = useState(typeof window !== "undefined" && window.innerWidth < 640);
  useEffect(() => {
    const f = () => setM(window.innerWidth < 640);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return m;
}

export default function LandCommand() {
  const [tab, setTab] = useState("gis");
  const [menuOpen, setMenuOpen] = useState(false);
  const [data, setData] = useState({ buyboxes: [], leads: [] });
  const [loaded, setLoaded] = useState(false);
  const [activeDeal, setActiveDeal] = useState(null);

  useEffect(() => {
    let live = true;
    loadData().then(d => { if (live) { setData(d); setLoaded(true); } });
    return () => { live = false; };
  }, []);

  const update = (next) => { setData(next); saveData(next); };
  const startDealFromParcel = (parcel) => {
    const base = { ...parcelToLead(parcel), stage: 0, checks: {} };
    if (!data.leads.some(l => l.id === base.id)) update({ ...data, leads: [base, ...data.leads] });
    setActiveDeal(base.id);
  };
  const activeLead = activeDeal && data.leads.find(l => l.id === activeDeal);
  const isMobile = useIsMobile();

  return (
    <div className="lc-body" style={{ minHeight: "100vh", background: C.paper, color: C.ink }}>
      <style>{FONTS}</style>
      {/* Header */}
      <div style={{ background: C.ink, padding: isMobile ? "9px 12px 0" : "16px 20px 0" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: isMobile ? 9 : 16 }}>
            <span className="lc-display" style={{ fontSize: isMobile ? 20 : 30, fontWeight: 800, color: "#fff", letterSpacing: ".06em", textTransform: "uppercase" }}>
              Land<span style={{ color: C.orange }}>Command</span>
            </span>
            {!isMobile && <span className="lc-mono" style={{ fontSize: 11.5, color: "#9DAB9F" }}>buy box → sourcing → score → outreach</span>}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: isMobile ? 8 : 14 }}>
              {!isMobile && <span className="lc-mono" style={{ fontSize: 11, color: "#9DAB9F", whiteSpace: "nowrap" }}>
                {data.buyboxes.length} buy box{data.buyboxes.length === 1 ? "" : "es"} · {data.leads.length} lead{data.leads.length === 1 ? "" : "s"}
              </span>}
              {/* Navigation — single dropdown (top-right) replaces the old tab strip */}
              <div style={{ position: "relative" }}>
                <button type="button" onClick={() => setMenuOpen(o => !o)} className="lc-display"
                  style={{
                    display: "flex", alignItems: "center", gap: isMobile ? 6 : 9, cursor: "pointer",
                    padding: isMobile ? "7px 12px" : "9px 16px", border: `1px solid ${C.orange}`, borderRadius: 9,
                    background: menuOpen ? C.orange : "#26352C", color: menuOpen ? C.ink : "#fff",
                    fontWeight: 800, fontSize: isMobile ? 12 : 14, letterSpacing: ".05em", textTransform: "uppercase", whiteSpace: "nowrap",
                  }}>
                  <span style={{ fontSize: isMobile ? 13 : 15, lineHeight: 1 }}>☰</span>
                  {(TABS.find(([id]) => id === tab) || [, "Menu"])[1]}
                  <span style={{ fontSize: 10, opacity: 0.8, transform: menuOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▼</span>
                </button>
                {menuOpen && (
                  <>
                    <div onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 5000 }} />
                    <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 5001, minWidth: 210,
                      background: C.ink, border: `1px solid ${C.orange}`, borderRadius: 10, padding: 6,
                      boxShadow: "0 12px 32px rgba(0,0,0,0.45)", display: "flex", flexDirection: "column", gap: 2 }}>
                      {TABS.map(([id, label]) => (
                        <button key={id} type="button" onClick={() => { setTab(id); setMenuOpen(false); }} className="lc-display"
                          style={{
                            textAlign: "left", padding: "10px 14px", border: "none", borderRadius: 7, cursor: "pointer",
                            fontWeight: 800, fontSize: 13.5, letterSpacing: ".05em", textTransform: "uppercase",
                            background: tab === id ? C.orange : "transparent", color: tab === id ? C.ink : "#D4DDD6",
                          }}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Body */}
      <div style={{ maxWidth: tab === "gis" ? "100%" : 1100, margin: "0 auto", padding: tab === "gis" ? "0" : (isMobile ? "12px 10px 36px" : "22px 20px 60px") }}>
        {!loaded ? <div style={{ color: C.faint, fontSize: 14 }}>Loading your saved buy boxes and leads…</div> : (
          <>
            {tab === "boxes" && <BuyBoxesTab data={data} update={update} />}
            {tab === "find" && <FindDealsTab data={data} />}
            {tab === "match" && <MatchTab data={data} update={update} />}
            {tab === "calc" && <CalcTab data={data} update={update} />}
            {tab === "pipeline" && <PipelineTab data={data} update={update} onResumeDeal={(lead) => setActiveDeal(lead.id)} />}
            {tab === "gis" && <GISTab data={data} update={update} onStartDeal={startDealFromParcel} />}
          </>
        )}
      </div>
      {activeLead && <DealFlow lead={activeLead} data={data} update={update} onClose={() => setActiveDeal(null)} />}
    </div>
  );
}

/* ============================================================
   Scripts engine — personalized outreach per lead
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

function buildScripts(lead, settings, box) {
  const first = (lead.owner || "").trim().split(/\s+/)[0] || "there";
  const me = settings.myName || "[your name]";
  const myPhone = settings.myPhone || "[your phone]";
  const co = settings.myCompany || "a local land buying company";
  const acres = lead.acres ? `${lead.acres}-acre ` : "";
  const where = lead.address || (lead.county ? `in ${lead.county} County` : "in the area");
  const apn = lead.apn ? ` (parcel ${lead.apn})` : "";
  const offerT = parseFloat(lead.offer || lead.price);
  const hasOffer = !isNaN(offerT) && offerT > 0;
  const anchor = hasOffer ? Math.round(offerT * 0.85 / 500) * 500 : null;
  const fmt = (n) => "$" + Number(n).toLocaleString();
  const closeDays = box?.closeDays || "30";

  return [
    {
      title: "Text #1 — Opener (Day 1)",
      body: `Hi ${first}, this is ${me}. Are you the owner of the ${acres}vacant lot ${where}${apn}? I'm a local cash buyer interested in purchasing it. No agents, no fees. Is it something you'd consider selling?`,
    },
    {
      title: "Text #2 — Follow-up (Day 4–5)",
      body: `Hi ${first}, ${me} again — just floating my message back up. I buy land for cash and can close in about ${closeDays} days, and I cover all the closing costs. Even a "no thanks" helps me close the file. Any interest in the ${acres}lot ${where}?`,
    },
    {
      title: "Cold call script (Day 2)",
      body: `OPENER:\n"Hi, is this ${first}? ... Hey ${first}, my name's ${me} — I know this is out of the blue, so I'll be quick. I buy vacant land here in ${lead.county || "the"} County for cash, and your ${acres}lot ${where} came up in county records. Have you ever thought about selling it?"\n\nIF MAYBE — QUALIFY:\n1. "How long have you owned it?" (let them talk — listen for taxes, distance, inheritance)\n2. "Are you using it for anything right now?"\n3. "Is there anything about the lot I should know — access, wetness, liens?"\n4. "If we agreed on a fair cash number, is there anything stopping you from selling?"\n\nPRICE — NEVER THROW THE FIRST NUMBER IF AVOIDABLE:\n"What number would make this a no-brainer for you?"\n${hasOffer ? `If pushed, anchor low: "Based on recent lot sales I'm around ${fmt(anchor)} — but walk me through the property, there may be room."` : `If pushed: "Let me verify access and utilities and I'll text you a real number within 24 hours — fair?"`}\n\nOBJECTIONS:\n• "It's worth more than that" → "You might be right — what are you basing that on? I'm using actual sold lots nearby, happy to send them to you."\n• "Let me think about it" → "Of course. What part do you want to think over — the price, or selling at all?"\n• "Send me something in writing" → "Will do. Best email or mailing address?" (CONFIRM MAILING ADDRESS — gold.)\n\nCLOSE:\n"Here's my promise: cash, I pay every closing cost, no commissions, and we close in ~${closeDays} days through a licensed title company. I'll send the agreement today."`,
    },
    {
      title: "Voicemail (leave once, max)",
      body: `Hi ${first}, this is ${me} at ${myPhone}. I'm a local cash buyer reaching out about your ${acres}vacant lot ${where}. I'd like to make you a no-obligation cash offer — I cover all costs and there are no agent fees. Again, ${me}, ${myPhone}. Thanks!`,
    },
    {
      title: "Mailer #1 — Postcard (Day 5)",
      body: `${first ? first.toUpperCase() : "PROPERTY OWNER"} — I WANT TO BUY YOUR LAND${apn ? ` ${apn.trim()}` : ""}\n\nI'm a local buyer paying CASH for vacant land ${lead.county ? `in ${lead.county} County` : "in your area"}.\n\n✓ No realtor commissions\n✓ I pay ALL closing costs\n✓ Close in ~${closeDays} days — or on your timeline\n✓ Sell as-is: back taxes, liens, overgrowth — I handle it\n\nCall or text me directly: ${myPhone}\n${me}${settings.myCompany ? ` · ${settings.myCompany}` : ""}\n\n(If you're not interested, toss this card — no hard feelings. But if that lot is just costing you taxes every year, let's talk.)`,
    },
    {
      title: `Mailer #2 — Offer letter (Day 21)${hasOffer ? "" : " — set 'Your offer' on the lead to auto-fill numbers"}`,
      body: `Dear ${lead.owner || "Property Owner"},\n\nMy name is ${me} with ${co}. I'm writing about your ${acres}vacant land ${where}${apn}.\n\nI'd like to buy your property for cash. ${hasOffer ? `Based on recent sales of similar lots in the area, I'm prepared to offer in the range of ${fmt(anchor)} to ${fmt(offerT)}, depending on a quick review of access and utilities.` : `After a quick review of access and utilities, I can present you a firm cash number within 48 hours of hearing from you.`}\n\nWhat that means for you:\n• CASH — no financing contingencies, no waiting on a bank\n• I pay 100% of closing costs and there are zero commissions\n• We close through a licensed local title company in about ${closeDays} days\n• Completely as-is — overgrown, landlocked questions, back taxes, liens — I deal with all of it\n\nIf the timing isn't right, no problem — keep this letter. But if that land has become a line item you pay taxes on and never visit, call or text me at ${myPhone} and let's turn it into cash.\n\nRespectfully,\n${me}\n${settings.myCompany || ""}\n${myPhone}`,
    },
  ];
}

function ScriptsPanel({ lead, data, update }) {
  const settings = data.settings || { myName: "", myPhone: "", myCompany: "" };
  const [copied, setCopied] = useState(-1);
  const box = data.buyboxes.find(b => b.builder === lead.buybox);
  const scripts = buildScripts(lead, settings, box);
  const setS = (k) => (e) => update({ ...data, settings: { ...settings, [k]: e.target.value } });
  return (
    <div style={{ marginTop: 12, borderTop: `2px solid ${C.line}`, paddingTop: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 12, background: C.amberPale, border: `1px solid ${C.amber}`, borderRadius: 6, padding: 10 }}>
        <Field label="Your name (saved for all scripts)"><input className="lc-input" value={settings.myName} onChange={setS("myName")} placeholder="Mike" /></Field>
        <Field label="Your phone"><input className="lc-input" value={settings.myPhone} onChange={setS("myPhone")} placeholder="(727) 555-0100" /></Field>
        <Field label="Company (optional)"><input className="lc-input" value={settings.myCompany} onChange={setS("myCompany")} placeholder="Gulf Coast Land Buyers" /></Field>
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {scripts.map((s, i) => (
          <div key={i} style={{ background: "#FAFBF7", border: `1px solid ${C.line}`, borderRadius: 6, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <span className="lc-display" style={{ fontWeight: 800, fontSize: 13.5, textTransform: "uppercase", letterSpacing: ".05em" }}>{s.title}</span>
              <Btn small kind={copied === i ? "primary" : "ghost"} onClick={async () => { await copyText(s.body); setCopied(i); setTimeout(() => setCopied(-1), 1800); }}>
                {copied === i ? "Copied ✓" : "Copy"}
              </Btn>
            </div>
            <pre className="lc-body" style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13, lineHeight: 1.55, color: C.ink, fontFamily: "'Inter', system-ui, sans-serif" }}>{s.body}</pre>
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
   TAB — Deal Calc (comps → market value → max allowable offer)
   ============================================================ */
function CalcTab({ data, update }) {
  const [boxId, setBoxId] = useState("");
  const [acres, setAcres] = useState("");
  const [comps, setComps] = useState([{ price: "", acres: "" }, { price: "", acres: "" }, { price: "", acres: "" }, { price: "", acres: "" }, { price: "", acres: "" }]);
  const [mvOverride, setMvOverride] = useState("");
  const [discount, setDiscount] = useState("60");      // offer as % of market value
  const [clearing, setClearing] = useState("");
  const [survey, setSurvey] = useState("1500");
  const [closing, setClosing] = useState("1500");
  const [misc, setMisc] = useState("0");
  const [fee, setFee] = useState("10000");
  const [savedMsg, setSavedMsg] = useState("");
  const box = data.buyboxes.find(b => b.id === boxId);

  const setComp = (i, k, v) => setComps(comps.map((c, j) => j === i ? { ...c, [k]: v } : c));
  const n = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };

  const validComps = comps.filter(c => n(c.price) > 0 && n(c.acres) > 0);
  const avgPPA = validComps.length ? validComps.reduce((s, c) => s + n(c.price) / n(c.acres), 0) / validComps.length : 0;
  const compMV = avgPPA * n(acres);
  const marketValue = n(mvOverride) > 0 ? n(mvOverride) : compMV;
  const builderMax = box && n(box.maxPrice) > 0 ? n(box.maxPrice) : Infinity;
  // What you can realistically sell it for: lesser of market value and the builder's ceiling
  const exitPrice = Math.min(marketValue || Infinity, builderMax);
  const costs = n(clearing) + n(survey) + n(closing) + n(misc);
  const rawMAO = (isFinite(exitPrice) ? exitPrice : 0) * (n(discount) / 100) - costs - n(fee) > 0
    ? (isFinite(exitPrice) ? exitPrice : 0) * (n(discount) / 100) - costs - n(fee)
    : 0;
  const mao = Math.floor(rawMAO / 100) * 100;
  const anchorOffer = Math.floor(mao * 0.85 / 100) * 100;
  const profitAtMAO = (isFinite(exitPrice) ? exitPrice : 0) - mao - costs;
  const ready = (marketValue > 0 || builderMax !== Infinity) && n(acres) >= 0;
  const fmt = (v) => isFinite(v) ? "$" + Math.round(v).toLocaleString() : "—";

  const sendToPipeline = () => {
    const lead = { ...emptyLead(), acres, price: isFinite(exitPrice) ? String(Math.round(exitPrice)) : "", offer: String(mao), buybox: box?.builder || "", source: "Deal Calc", notes: `MAO ${fmt(mao)} · anchor ${fmt(anchorOffer)} · exit ${fmt(exitPrice)} · costs ${fmt(costs)} · fee target ${fmt(n(fee))}` };
    update({ ...data, leads: [lead, ...data.leads] });
    setSavedMsg("Saved to Pipeline ✓ — open the lead and add the owner/APN");
    setTimeout(() => setSavedMsg(""), 5000);
  };

  return (
    <div>
      <div className="lc-display" style={{ fontSize: 22, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em" }}>Deal calculator</div>
      <div style={{ fontSize: 13, color: C.faint, marginBottom: 14 }}>Comp the lot, set your costs and assignment fee, and it spits out your max allowable offer and your opening anchor.</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 18 }}>
          <SectionHead>Step 1 — The lot & the buyer</SectionHead>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
            <Field label="Subject lot size (acres)"><input className="lc-input" type="number" value={acres} onChange={e => setAcres(e.target.value)} placeholder="0.25" /></Field>
            <Field label="Builder buy box (sets price ceiling)">
              <select className="lc-input" value={boxId} onChange={e => setBoxId(e.target.value)}>
                <option value="">— none / open market —</option>
                {data.buyboxes.map(b => <option key={b.id} value={b.id}>{b.builder || "Unnamed"}{b.maxPrice ? ` (max $${Number(b.maxPrice).toLocaleString()})` : ""}</option>)}
              </select>
            </Field>
          </div>

          <SectionHead>Step 2 — Comps (sold vacant lots, same zip, last 12 mo)</SectionHead>
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginTop: 12 }}>
            <Field label="Avg $/acre from comps">
              <div className="lc-mono lc-input" style={{ background: "#F4F6F0", fontWeight: 600 }}>{avgPPA ? `$${Math.round(avgPPA).toLocaleString()}/ac` : "enter comps"}</div>
            </Field>
            <Field label="Comp-based market value">
              <div className="lc-mono lc-input" style={{ background: "#F4F6F0", fontWeight: 600 }}>{compMV ? fmt(compMV) : "—"}</div>
            </Field>
            <Field label="Or override market value ($)"><input className="lc-input" type="number" value={mvOverride} onChange={e => setMvOverride(e.target.value)} placeholder="55000" /></Field>
          </div>

          <SectionHead>Step 3 — Your numbers</SectionHead>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            <Field label="Offer as % of exit price"><input className="lc-input" type="number" value={discount} onChange={e => setDiscount(e.target.value)} placeholder="60" /></Field>
            <Field label="Clearing estimate ($)"><input className="lc-input" type="number" value={clearing} onChange={e => setClearing(e.target.value)} placeholder="0 if cleared" /></Field>
            <Field label="Survey / perc ($)"><input className="lc-input" type="number" value={survey} onChange={e => setSurvey(e.target.value)} /></Field>
            <Field label="Closing / title ($)"><input className="lc-input" type="number" value={closing} onChange={e => setClosing(e.target.value)} /></Field>
            <Field label="Misc / back taxes ($)"><input className="lc-input" type="number" value={misc} onChange={e => setMisc(e.target.value)} /></Field>
            <Field label="Your assignment fee ($)"><input className="lc-input" type="number" value={fee} onChange={e => setFee(e.target.value)} /></Field>
          </div>
          <div style={{ fontSize: 11.5, color: C.faint, marginTop: 8 }}>
            Rule of thumb: 50–70% of exit price for infill lots with utilities; 30–50% for rural/raw acreage. The hotter the buy box demand, the higher you can go.
          </div>
        </div>

        {ready && (
          <div style={{ background: C.ink, borderRadius: 8, padding: 20, color: "#fff" }}>
            <div className="lc-display" style={{ fontSize: 16, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: C.orange, marginBottom: 12 }}>Offer ladder</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14 }}>
              <div>
                <div className="lc-label" style={{ color: "#9DAB9F" }}>Opening anchor (85%)</div>
                <div className="lc-mono" style={{ fontSize: 26, fontWeight: 600 }}>{fmt(anchorOffer)}</div>
              </div>
              <div>
                <div className="lc-label" style={{ color: "#9DAB9F" }}>Max allowable offer</div>
                <div className="lc-mono" style={{ fontSize: 26, fontWeight: 600, color: C.orange }}>{fmt(mao)}</div>
                <div style={{ fontSize: 11, color: "#9DAB9F" }}>never go past this</div>
              </div>
              <div>
                <div className="lc-label" style={{ color: "#9DAB9F" }}>Exit price (sell to builder)</div>
                <div className="lc-mono" style={{ fontSize: 26, fontWeight: 600 }}>{fmt(exitPrice)}</div>
                <div style={{ fontSize: 11, color: "#9DAB9F" }}>{box && builderMax !== Infinity && builderMax <= (marketValue || Infinity) ? `capped by ${box.builder}'s max` : "market value"}</div>
              </div>
              <div>
                <div className="lc-label" style={{ color: "#9DAB9F" }}>Spread at MAO</div>
                <div className="lc-mono" style={{ fontSize: 26, fontWeight: 600, color: profitAtMAO >= n(fee) ? "#7FD8A4" : "#E8A6A0" }}>{fmt(profitAtMAO)}</div>
                <div style={{ fontSize: 11, color: "#9DAB9F" }}>after {fmt(costs)} costs</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
              <Btn onClick={sendToPipeline}>+ Save deal to Pipeline</Btn>
              <Btn kind="ghost" onClick={async () => { await copyText(`Lot: ${acres} ac\nExit price: ${fmt(exitPrice)}\nOpening offer: ${fmt(anchorOffer)}\nMax offer: ${fmt(mao)}\nCosts: ${fmt(costs)}\nTarget fee: ${fmt(n(fee))}`); setSavedMsg("Breakdown copied ✓"); setTimeout(() => setSavedMsg(""), 2500); }}>Copy breakdown</Btn>
              {savedMsg && <span style={{ fontSize: 13, fontWeight: 700, color: "#7FD8A4" }}>{savedMsg}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   GIS MAP TAB — Parcel Explorer
   Satellite + lot lines + ownership + tax delinquency
   Coverage: FL · TX · TN · NC (all counties)
   ============================================================ */

// County data: [name, lat, lng, slug]
const _GIS_RAW = {
  FL: [
    ["Alachua",29.74,-82.49,"alachua"],["Baker",30.33,-82.28,"baker"],["Bay",30.25,-85.65,"bay"],
    ["Bradford",29.95,-82.17,"bradford"],["Brevard",28.26,-80.73,"brevard"],["Broward",26.12,-80.45,"broward"],
    ["Calhoun",30.41,-85.19,"calhoun"],["Charlotte",26.96,-82.01,"charlotte"],["Citrus",28.87,-82.55,"citrus"],
    ["Clay",29.99,-81.86,"clay"],["Collier",26.11,-81.30,"collier"],["Columbia",30.22,-82.62,"columbia"],
    ["DeSoto",27.17,-81.83,"desoto"],["Dixie",29.59,-83.19,"dixie"],["Duval",30.33,-81.65,"duval"],
    ["Escambia",30.65,-87.34,"escambia"],["Flagler",29.47,-81.35,"flagler"],["Franklin",29.84,-84.88,"franklin"],
    ["Gadsden",30.57,-84.60,"gadsden"],["Gilchrist",29.72,-82.80,"gilchrist"],["Glades",26.94,-81.24,"glades"],
    ["Gulf",29.92,-85.22,"gulf"],["Hamilton",30.49,-83.00,"hamilton"],["Hardee",27.50,-81.82,"hardee"],
    ["Hendry",26.62,-81.05,"hendry"],["Hernando",28.56,-82.47,"hernando"],["Highlands",27.34,-81.35,"highlands"],
    ["Hillsborough",27.90,-82.35,"hillsborough"],["Holmes",30.87,-85.82,"holmes"],["Indian River",27.70,-80.62,"indian-river"],
    ["Jackson",30.79,-85.23,"jackson"],["Jefferson",30.43,-83.90,"jefferson"],["Lafayette",29.99,-83.19,"lafayette"],
    ["Lake",28.76,-81.72,"lake"],["Lee",26.58,-81.80,"lee"],["Leon",30.46,-84.28,"leon"],
    ["Levy",29.28,-82.78,"levy"],["Liberty",30.25,-84.90,"liberty"],["Madison",30.40,-83.47,"madison"],
    ["Manatee",27.48,-82.38,"manatee"],["Marion",29.21,-82.14,"marion"],["Martin",27.09,-80.39,"martin"],
    ["Miami-Dade",25.55,-80.63,"miami-dade"],["Monroe",24.64,-81.37,"monroe"],["Nassau",30.62,-81.77,"nassau"],
    ["Okaloosa",30.72,-86.55,"okaloosa"],["Okeechobee",27.39,-80.90,"okeechobee"],["Orange",28.51,-81.27,"orange"],
    ["Osceola",28.06,-81.00,"osceola"],["Palm Beach",26.64,-80.37,"palm-beach"],["Pasco",28.31,-82.43,"pasco"],
    ["Pinellas",27.88,-82.73,"pinellas"],["Polk",27.95,-81.69,"polk"],["Putnam",29.63,-81.74,"putnam"],
    ["Santa Rosa",30.73,-87.01,"santa-rosa"],["Sarasota",27.19,-82.33,"sarasota"],["Seminole",28.71,-81.26,"seminole"],
    ["St. Johns",29.96,-81.48,"st-johns"],["St. Lucie",27.38,-80.44,"st-lucie"],["Sumter",28.70,-82.08,"sumter"],
    ["Suwannee",30.18,-83.04,"suwannee"],["Taylor",30.05,-83.60,"taylor"],["Union",30.05,-82.36,"union"],
    ["Volusia",29.05,-81.24,"volusia"],["Wakulla",30.13,-84.39,"wakulla"],["Walton",30.63,-86.15,"walton"],
    ["Washington",30.62,-85.67,"washington"],
  ],
  TX: [
    ["Anderson",31.82,-95.65,"anderson"],["Andrews",32.30,-102.64,"andrews"],["Angelina",31.25,-94.70,"angelina"],
    ["Aransas",28.07,-96.97,"aransas"],["Archer",33.62,-98.70,"archer"],["Armstrong",34.96,-101.36,"armstrong"],
    ["Atascosa",28.89,-98.53,"atascosa"],["Austin",29.89,-96.27,"austin"],["Bailey",34.07,-102.83,"bailey"],
    ["Bandera",29.75,-99.25,"bandera"],["Bastrop",30.10,-97.31,"bastrop"],["Baylor",33.62,-99.22,"baylor"],
    ["Bee",28.42,-97.74,"bee"],["Bell",31.05,-97.48,"bell"],["Bexar",29.45,-98.52,"bexar"],
    ["Blanco",30.26,-98.40,"blanco"],["Borden",32.74,-101.43,"borden"],["Bosque",31.90,-97.65,"bosque"],
    ["Bowie",33.44,-94.19,"bowie"],["Brazoria",29.17,-95.44,"brazoria"],["Brazos",30.66,-96.32,"brazos"],
    ["Brewster",29.83,-103.25,"brewster"],["Briscoe",34.53,-100.56,"briscoe"],["Brooks",27.03,-98.22,"brooks"],
    ["Brown",31.77,-99.01,"brown"],["Burleson",30.50,-96.61,"burleson"],["Burnet",30.79,-98.23,"burnet"],
    ["Caldwell",29.83,-97.62,"caldwell"],["Calhoun",28.44,-96.63,"calhoun"],["Callahan",32.30,-99.37,"callahan"],
    ["Cameron",26.14,-97.52,"cameron"],["Camp",32.97,-94.98,"camp"],["Carson",35.40,-101.36,"carson"],
    ["Cass",33.08,-94.34,"cass"],["Castro",34.53,-102.26,"castro"],["Chambers",29.70,-94.65,"chambers"],
    ["Cherokee",31.85,-95.15,"cherokee"],["Childress",34.53,-100.21,"childress"],["Clay",33.79,-98.22,"clay"],
    ["Cochran",33.60,-102.83,"cochran"],["Coke",31.88,-100.53,"coke"],["Coleman",31.77,-99.45,"coleman"],
    ["Collin",33.19,-96.58,"collin"],["Collingsworth",34.96,-100.27,"collingsworth"],["Colorado",29.62,-96.52,"colorado"],
    ["Comal",29.81,-98.27,"comal"],["Comanche",31.95,-98.56,"comanche"],["Concho",31.32,-99.85,"concho"],
    ["Cooke",33.66,-97.21,"cooke"],["Coryell",31.39,-97.75,"coryell"],["Cottle",34.08,-100.28,"cottle"],
    ["Crane",31.43,-102.35,"crane"],["Crockett",30.72,-101.20,"crockett"],["Crosby",33.61,-101.30,"crosby"],
    ["Culberson",30.22,-104.51,"culberson"],["Dallam",36.28,-102.60,"dallam"],["Dallas",32.77,-96.78,"dallas"],
    ["Dawson",32.74,-101.95,"dawson"],["Deaf Smith",34.96,-102.60,"deaf-smith"],["Delta",33.39,-95.67,"delta"],
    ["Denton",33.21,-97.13,"denton"],["DeWitt",29.09,-97.35,"dewitt"],["Dickens",33.62,-100.79,"dickens"],
    ["Dimmit",28.43,-99.76,"dimmit"],["Donley",34.96,-100.81,"donley"],["Duval",27.68,-98.53,"duval"],
    ["Eastland",32.31,-98.82,"eastland"],["Ector",31.85,-102.55,"ector"],["Edwards",29.98,-100.30,"edwards"],
    ["El Paso",31.78,-106.45,"el-paso"],["Ellis",32.35,-96.81,"ellis"],["Erath",32.22,-98.20,"erath"],
    ["Falls",31.25,-96.88,"falls"],["Fannin",33.59,-96.10,"fannin"],["Fayette",29.88,-96.91,"fayette"],
    ["Fisher",32.74,-100.40,"fisher"],["Floyd",34.07,-101.30,"floyd"],["Foard",33.98,-99.78,"foard"],
    ["Fort Bend",29.53,-95.77,"fort-bend"],["Franklin",33.17,-95.22,"franklin"],["Freestone",31.70,-96.15,"freestone"],
    ["Frio",28.87,-99.11,"frio"],["Gaines",32.74,-102.64,"gaines"],["Galveston",29.26,-94.82,"galveston"],
    ["Garza",33.18,-101.30,"garza"],["Gillespie",30.32,-98.94,"gillespie"],["Glasscock",31.87,-101.52,"glasscock"],
    ["Goliad",28.66,-97.38,"goliad"],["Gonzales",29.45,-97.50,"gonzales"],["Gray",35.40,-100.81,"gray"],
    ["Grayson",33.65,-96.68,"grayson"],["Gregg",32.48,-94.82,"gregg"],["Grimes",30.51,-95.98,"grimes"],
    ["Guadalupe",29.61,-97.94,"guadalupe"],["Hale",34.07,-101.82,"hale"],["Hall",34.53,-100.68,"hall"],
    ["Hamilton",31.71,-98.11,"hamilton"],["Hansford",36.28,-101.36,"hansford"],["Hardeman",34.30,-99.75,"hardeman"],
    ["Hardin",30.34,-94.38,"hardin"],["Harris",29.85,-95.40,"harris"],["Harrison",32.55,-94.38,"harrison"],
    ["Hartley",35.84,-102.60,"hartley"],["Haskell",33.17,-99.73,"haskell"],["Hays",29.99,-98.04,"hays"],
    ["Hemphill",35.84,-100.27,"hemphill"],["Henderson",32.21,-95.85,"henderson"],["Hidalgo",26.30,-98.23,"hidalgo"],
    ["Hill",31.99,-97.14,"hill"],["Hockley",33.61,-102.34,"hockley"],["Hood",32.43,-97.82,"hood"],
    ["Hopkins",33.15,-95.55,"hopkins"],["Houston",31.33,-95.43,"houston"],["Howard",32.30,-101.44,"howard"],
    ["Hudspeth",31.45,-105.37,"hudspeth"],["Hunt",33.13,-96.08,"hunt"],["Hutchinson",35.84,-101.36,"hutchinson"],
    ["Irion",31.30,-100.98,"irion"],["Jack",33.23,-98.16,"jack"],["Jackson",28.96,-96.58,"jackson"],
    ["Jasper",30.89,-94.03,"jasper"],["Jeff Davis",30.60,-104.13,"jeff-davis"],["Jefferson",30.03,-94.15,"jefferson"],
    ["Jim Hogg",27.03,-98.70,"jim-hogg"],["Jim Wells",27.73,-98.09,"jim-wells"],["Johnson",32.38,-97.36,"johnson"],
    ["Jones",32.74,-99.87,"jones"],["Karnes",28.89,-97.86,"karnes"],["Kaufman",32.60,-96.31,"kaufman"],
    ["Kendall",29.94,-98.71,"kendall"],["Kenedy",26.93,-97.64,"kenedy"],["Kent",33.18,-100.79,"kent"],
    ["Kerr",30.06,-99.35,"kerr"],["Kimble",30.49,-99.74,"kimble"],["King",33.62,-100.26,"king"],
    ["Kinney",29.35,-100.42,"kinney"],["Kleberg",27.43,-97.80,"kleberg"],["Knox",33.60,-99.75,"knox"],
    ["Lamar",33.67,-95.55,"lamar"],["Lamb",34.07,-102.35,"lamb"],["Lampasas",31.20,-98.25,"lampasas"],
    ["La Salle",28.35,-99.10,"la-salle"],["Lavaca",29.38,-96.92,"lavaca"],["Lee",30.32,-96.97,"lee"],
    ["Leon",31.29,-96.01,"leon"],["Liberty",30.07,-94.79,"liberty"],["Limestone",31.54,-96.63,"limestone"],
    ["Lipscomb",36.28,-100.27,"lipscomb"],["Live Oak",28.35,-98.13,"live-oak"],["Llano",30.71,-98.66,"llano"],
    ["Loving",31.84,-103.59,"loving"],["Lubbock",33.57,-101.85,"lubbock"],["Lynn",33.18,-101.82,"lynn"],
    ["McCulloch",31.19,-99.35,"mcculloch"],["McLennan",31.55,-97.20,"mclennan"],["McMullen",28.35,-98.57,"mcmullen"],
    ["Madison",30.94,-95.91,"madison"],["Marion",32.79,-94.36,"marion"],["Martin",32.30,-101.95,"martin"],
    ["Mason",30.75,-99.23,"mason"],["Matagorda",28.83,-96.01,"matagorda"],["Maverick",28.74,-100.31,"maverick"],
    ["Medina",29.35,-99.11,"medina"],["Menard",30.89,-99.79,"menard"],["Midland",31.87,-102.03,"midland"],
    ["Milam",30.78,-96.99,"milam"],["Mills",31.49,-98.59,"mills"],["Mitchell",32.30,-100.92,"mitchell"],
    ["Montague",33.68,-97.73,"montague"],["Montgomery",30.25,-95.50,"montgomery"],["Moore",35.84,-101.89,"moore"],
    ["Morris",33.11,-94.73,"morris"],["Motley",34.07,-100.79,"motley"],["Nacogdoches",31.64,-94.66,"nacogdoches"],
    ["Navarro",32.04,-96.46,"navarro"],["Newton",30.78,-93.72,"newton"],["Nolan",32.30,-100.41,"nolan"],
    ["Nueces",27.73,-97.58,"nueces"],["Ochiltree",36.28,-100.81,"ochiltree"],["Oldham",35.40,-102.60,"oldham"],
    ["Orange",30.12,-93.90,"orange"],["Palo Pinto",32.74,-98.29,"palo-pinto"],["Panola",31.99,-94.31,"panola"],
    ["Parker",32.78,-97.80,"parker"],["Parmer",34.53,-102.78,"parmer"],["Pecos",30.79,-102.73,"pecos"],
    ["Polk",30.79,-94.83,"polk"],["Potter",35.22,-101.85,"potter"],["Presidio",29.66,-104.22,"presidio"],
    ["Rains",32.87,-95.79,"rains"],["Randall",34.96,-101.89,"randall"],["Reagan",31.38,-101.52,"reagan"],
    ["Real",29.83,-99.82,"real"],["Red River",33.62,-95.04,"red-river"],["Reeves",31.32,-103.70,"reeves"],
    ["Refugio",28.44,-97.16,"refugio"],["Roberts",35.84,-100.81,"roberts"],["Robertson",31.03,-96.59,"robertson"],
    ["Rockwall",32.91,-96.39,"rockwall"],["Runnels",31.83,-99.98,"runnels"],["Rusk",32.12,-94.77,"rusk"],
    ["Sabine",31.34,-93.90,"sabine"],["San Augustine",31.39,-94.19,"san-augustine"],["San Jacinto",30.57,-95.17,"san-jacinto"],
    ["San Patricio",28.01,-97.52,"san-patricio"],["San Saba",31.16,-98.73,"san-saba"],["Schleicher",30.90,-100.53,"schleicher"],
    ["Scurry",32.74,-100.92,"scurry"],["Shackelford",32.74,-99.35,"shackelford"],["Shelby",31.79,-94.15,"shelby"],
    ["Sherman",36.28,-101.89,"sherman"],["Smith",32.37,-95.27,"smith"],["Somervell",32.22,-97.77,"somervell"],
    ["Starr",26.56,-98.75,"starr"],["Stephens",32.74,-99.16,"stephens"],["Sterling",31.83,-101.00,"sterling"],
    ["Stonewall",33.18,-100.26,"stonewall"],["Sutton",30.49,-100.54,"sutton"],["Swisher",34.53,-101.74,"swisher"],
    ["Tarrant",32.74,-97.29,"tarrant"],["Taylor",32.30,-99.87,"taylor"],["Terrell",30.22,-102.07,"terrell"],
    ["Terry",33.18,-102.34,"terry"],["Throckmorton",33.18,-99.22,"throckmorton"],["Titus",33.17,-94.97,"titus"],
    ["Tom Green",31.38,-100.46,"tom-green"],["Travis",30.34,-97.78,"travis"],["Trinity",31.09,-95.13,"trinity"],
    ["Tyler",30.78,-94.37,"tyler"],["Upshur",32.73,-94.93,"upshur"],["Upton",31.37,-102.04,"upton"],
    ["Uvalde",29.35,-99.76,"uvalde"],["Val Verde",29.89,-101.15,"val-verde"],["Van Zandt",32.56,-95.87,"van-zandt"],
    ["Victoria",28.82,-97.01,"victoria"],["Walker",30.73,-95.55,"walker"],["Waller",29.99,-95.99,"waller"],
    ["Ward",31.51,-103.10,"ward"],["Washington",30.19,-96.39,"washington"],["Webb",27.76,-99.45,"webb"],
    ["Wharton",29.31,-96.10,"wharton"],["Wheeler",35.40,-100.27,"wheeler"],["Wichita",33.90,-98.70,"wichita"],
    ["Wilbarger",34.08,-99.23,"wilbarger"],["Willacy",26.47,-97.60,"willacy"],["Williamson",30.65,-97.60,"williamson"],
    ["Wilson",29.18,-98.07,"wilson"],["Winkler",31.84,-103.06,"winkler"],["Wise",33.22,-97.66,"wise"],
    ["Wood",32.78,-95.38,"wood"],["Yoakum",33.17,-102.83,"yoakum"],["Young",33.17,-98.70,"young"],
    ["Zapata",27.03,-99.16,"zapata"],["Zavala",28.87,-99.76,"zavala"],
  ],
  TN: [
    ["Anderson",36.11,-84.16,"anderson"],["Bedford",35.49,-86.46,"bedford"],["Benton",36.06,-88.01,"benton"],
    ["Bledsoe",35.56,-85.18,"bledsoe"],["Blount",35.68,-83.94,"blount"],["Bradley",35.16,-84.87,"bradley"],
    ["Campbell",36.39,-84.16,"campbell"],["Cannon",35.81,-86.07,"cannon"],["Carroll",35.97,-88.46,"carroll"],
    ["Carter",36.30,-82.05,"carter"],["Cheatham",36.28,-87.08,"cheatham"],["Chester",35.44,-88.60,"chester"],
    ["Claiborne",36.47,-83.66,"claiborne"],["Clay",36.55,-85.53,"clay"],["Cocke",35.94,-83.01,"cocke"],
    ["Coffee",35.49,-86.08,"coffee"],["Crockett",35.98,-89.15,"crockett"],["Cumberland",35.95,-85.02,"cumberland"],
    ["Davidson",36.17,-86.78,"davidson"],["Decatur",35.58,-88.11,"decatur"],["DeKalb",35.97,-85.80,"dekalb"],
    ["Dickson",36.16,-87.37,"dickson"],["Dyer",36.04,-89.37,"dyer"],["Fayette",35.19,-89.38,"fayette"],
    ["Fentress",36.39,-84.93,"fentress"],["Franklin",35.13,-86.11,"franklin"],["Gibson",35.91,-88.93,"gibson"],
    ["Giles",35.19,-87.02,"giles"],["Grainger",36.26,-83.51,"grainger"],["Greene",36.17,-82.83,"greene"],
    ["Grundy",35.35,-85.75,"grundy"],["Hamblen",36.21,-83.25,"hamblen"],["Hamilton",35.19,-85.17,"hamilton"],
    ["Hancock",36.53,-83.24,"hancock"],["Hardeman",35.21,-88.99,"hardeman"],["Hardin",35.23,-88.25,"hardin"],
    ["Hawkins",36.43,-82.97,"hawkins"],["Haywood",35.64,-89.25,"haywood"],["Henderson",35.65,-88.39,"henderson"],
    ["Henry",36.31,-88.31,"henry"],["Hickman",35.78,-87.47,"hickman"],["Houston",36.36,-87.67,"houston"],
    ["Humphreys",36.08,-87.76,"humphreys"],["Jackson",36.35,-85.66,"jackson"],["Jefferson",36.03,-83.43,"jefferson"],
    ["Johnson",36.43,-81.81,"johnson"],["Knox",35.99,-83.94,"knox"],["Lake",36.47,-89.41,"lake"],
    ["Lauderdale",35.77,-89.62,"lauderdale"],["Lawrence",35.24,-87.34,"lawrence"],["Lewis",35.55,-87.52,"lewis"],
    ["Lincoln",35.15,-86.58,"lincoln"],["Loudon",35.73,-84.34,"loudon"],["McMinn",35.44,-84.59,"mcminn"],
    ["McNairy",35.07,-88.57,"mcnairy"],["Macon",36.53,-86.00,"macon"],["Madison",35.61,-88.83,"madison"],
    ["Marion",35.08,-85.61,"marion"],["Marshall",35.45,-86.81,"marshall"],["Maury",35.61,-87.08,"maury"],
    ["Meigs",35.52,-84.82,"meigs"],["Monroe",35.45,-84.27,"monroe"],["Montgomery",36.53,-87.36,"montgomery"],
    ["Moore",35.29,-86.37,"moore"],["Morgan",36.08,-84.59,"morgan"],["Obion",36.42,-89.07,"obion"],
    ["Overton",36.39,-85.32,"overton"],["Perry",35.62,-87.87,"perry"],["Pickett",36.57,-85.01,"pickett"],
    ["Polk",35.13,-84.53,"polk"],["Putnam",36.16,-85.50,"putnam"],["Rhea",35.51,-84.93,"rhea"],
    ["Roane",35.87,-84.52,"roane"],["Robertson",36.53,-86.88,"robertson"],["Rutherford",35.84,-86.42,"rutherford"],
    ["Scott",36.43,-84.51,"scott"],["Sequatchie",35.38,-85.38,"sequatchie"],["Sevier",35.79,-83.55,"sevier"],
    ["Shelby",35.15,-89.97,"shelby"],["Smith",36.25,-85.95,"smith"],["Stewart",36.50,-87.83,"stewart"],
    ["Sullivan",36.51,-82.37,"sullivan"],["Sumner",36.47,-86.46,"sumner"],["Tipton",35.51,-89.75,"tipton"],
    ["Trousdale",36.39,-86.16,"trousdale"],["Unicoi",36.13,-82.47,"unicoi"],["Union",36.29,-83.82,"union"],
    ["Van Buren",35.70,-85.44,"van-buren"],["Warren",35.68,-85.77,"warren"],["Washington",36.30,-82.47,"washington"],
    ["Wayne",35.21,-87.76,"wayne"],["Weakley",36.52,-88.71,"weakley"],["White",35.90,-85.48,"white"],
    ["Williamson",35.89,-86.89,"williamson"],["Wilson",36.15,-86.25,"wilson"],
  ],
  NC: [
    ["Alamance",36.04,-79.40,"alamance"],["Alexander",35.92,-81.18,"alexander"],["Alleghany",36.49,-81.13,"alleghany"],
    ["Anson",35.01,-80.10,"anson"],["Ashe",36.43,-81.50,"ashe"],["Avery",36.08,-81.93,"avery"],
    ["Beaufort",35.47,-76.82,"beaufort"],["Bertie",36.07,-76.99,"bertie"],["Bladen",34.61,-78.56,"bladen"],
    ["Brunswick",34.06,-78.25,"brunswick"],["Buncombe",35.57,-82.53,"buncombe"],["Burke",35.75,-81.71,"burke"],
    ["Cabarrus",35.39,-80.58,"cabarrus"],["Caldwell",35.95,-81.55,"caldwell"],["Camden",36.34,-76.17,"camden"],
    ["Carteret",34.84,-76.85,"carteret"],["Caswell",36.39,-79.33,"caswell"],["Catawba",35.66,-81.21,"catawba"],
    ["Chatham",35.70,-79.25,"chatham"],["Cherokee",35.14,-84.02,"cherokee"],["Chowan",36.10,-76.59,"chowan"],
    ["Clay",35.06,-83.76,"clay"],["Cleveland",35.35,-81.57,"cleveland"],["Columbus",34.27,-78.67,"columbus"],
    ["Craven",35.11,-77.08,"craven"],["Cumberland",35.05,-78.88,"cumberland"],["Currituck",36.47,-76.01,"currituck"],
    ["Dare",35.74,-75.83,"dare"],["Davidson",35.79,-80.21,"davidson"],["Davie",35.93,-80.55,"davie"],
    ["Duplin",34.93,-77.93,"duplin"],["Durham",35.99,-78.90,"durham"],["Edgecombe",35.91,-77.60,"edgecombe"],
    ["Forsyth",36.10,-80.25,"forsyth"],["Franklin",36.09,-78.28,"franklin"],["Gaston",35.29,-81.18,"gaston"],
    ["Gates",36.44,-76.69,"gates"],["Graham",35.36,-83.84,"graham"],["Granville",36.31,-78.67,"granville"],
    ["Greene",35.47,-77.68,"greene"],["Guilford",36.07,-79.79,"guilford"],["Halifax",36.25,-77.69,"halifax"],
    ["Harnett",35.35,-78.88,"harnett"],["Haywood",35.56,-83.00,"haywood"],["Henderson",35.34,-82.48,"henderson"],
    ["Hertford",36.35,-77.04,"hertford"],["Hoke",35.02,-79.24,"hoke"],["Hyde",35.40,-76.23,"hyde"],
    ["Iredell",35.80,-80.87,"iredell"],["Jackson",35.28,-83.13,"jackson"],["Johnston",35.51,-78.38,"johnston"],
    ["Jones",34.92,-77.38,"jones"],["Lee",35.47,-79.18,"lee"],["Lenoir",35.23,-77.64,"lenoir"],
    ["Lincoln",35.49,-81.22,"lincoln"],["McDowell",35.68,-82.00,"mcdowell"],["Macon",35.15,-83.43,"macon"],
    ["Madison",35.85,-82.73,"madison"],["Martin",35.84,-77.10,"martin"],["Mecklenburg",35.26,-80.84,"mecklenburg"],
    ["Mitchell",36.00,-82.16,"mitchell"],["Montgomery",35.33,-79.89,"montgomery"],["Moore",35.31,-79.49,"moore"],
    ["Nash",35.97,-77.98,"nash"],["New Hanover",34.19,-77.88,"new-hanover"],["Northampton",36.41,-77.38,"northampton"],
    ["Onslow",34.75,-77.45,"onslow"],["Orange",35.93,-79.13,"orange"],["Pamlico",35.15,-76.67,"pamlico"],
    ["Pasquotank",36.28,-76.22,"pasquotank"],["Pender",34.53,-77.91,"pender"],["Perquimans",36.19,-76.44,"perquimans"],
    ["Person",36.39,-78.97,"person"],["Pitt",35.59,-77.36,"pitt"],["Polk",35.30,-82.17,"polk"],
    ["Randolph",35.71,-79.81,"randolph"],["Richmond",34.96,-79.86,"richmond"],["Robeson",34.64,-79.10,"robeson"],
    ["Rockingham",36.39,-79.78,"rockingham"],["Rowan",35.64,-80.54,"rowan"],["Rutherford",35.40,-81.92,"rutherford"],
    ["Sampson",34.99,-78.37,"sampson"],["Scotland",34.83,-79.49,"scotland"],["Stanly",35.31,-80.25,"stanly"],
    ["Stokes",36.40,-80.24,"stokes"],["Surry",36.41,-80.68,"surry"],["Swain",35.49,-83.49,"swain"],
    ["Transylvania",35.20,-82.79,"transylvania"],["Tyrrell",35.87,-76.19,"tyrrell"],["Union",35.00,-80.53,"union"],
    ["Vance",36.36,-78.41,"vance"],["Wake",35.79,-78.65,"wake"],["Warren",36.39,-78.12,"warren"],
    ["Washington",35.84,-76.67,"washington"],["Watauga",36.23,-81.70,"watauga"],["Wayne",35.37,-77.98,"wayne"],
    ["Wilkes",36.16,-81.17,"wilkes"],["Wilson",35.72,-77.95,"wilson"],["Yadkin",36.16,-80.67,"yadkin"],
    ["Yancey",35.89,-82.30,"yancey"],
  ],
};

// Build county lookup map
const GIS_COUNTIES = {};

/* Expansion-state counties (centroids from US Census Gazetteer) — merged into GIS_COUNTIES */
const GIS_COUNTIES_MORE = {
  OH: {"Adams":{lat:38.8345,lng:-83.4781,slug:"adams"},"Allen":{lat:40.7716,lng:-84.1061,slug:"allen"},"Ashland":{lat:40.8433,lng:-82.2701,slug:"ashland"},"Ashtabula":{lat:41.9066,lng:-80.7456,slug:"ashtabula"},"Athens":{lat:39.3328,lng:-82.0459,slug:"athens"},"Auglaize":{lat:40.5613,lng:-84.224,slug:"auglaize"},"Belmont":{lat:40.0177,lng:-80.9677,slug:"belmont"},"Brown":{lat:38.9314,lng:-83.8668,slug:"brown"},"Butler":{lat:39.4397,lng:-84.5657,slug:"butler"},"Carroll":{lat:40.5799,lng:-81.0908,slug:"carroll"},"Champaign":{lat:40.1328,lng:-83.7676,slug:"champaign"},"Clark":{lat:39.917,lng:-83.7837,slug:"clark"},"Clermont":{lat:39.0521,lng:-84.1495,slug:"clermont"},"Clinton":{lat:39.4167,lng:-83.8046,slug:"clinton"},"Columbiana":{lat:40.7701,lng:-80.7785,slug:"columbiana"},"Coshocton":{lat:40.2967,lng:-81.9301,slug:"coshocton"},"Crawford":{lat:40.8485,lng:-82.9248,slug:"crawford"},"Cuyahoga":{lat:41.555,lng:-81.605,slug:"cuyahoga"},"Darke":{lat:40.1315,lng:-84.6212,slug:"darke"},"Defiance":{lat:41.3217,lng:-84.4864,slug:"defiance"},"Delaware":{lat:40.2789,lng:-83.0075,slug:"delaware"},"Erie":{lat:41.3941,lng:-82.5868,slug:"erie"},"Fairfield":{lat:39.7477,lng:-82.6267,slug:"fairfield"},"Fayette":{lat:39.5552,lng:-83.4619,slug:"fayette"},"Franklin":{lat:39.9699,lng:-83.0091,slug:"franklin"},"Fulton":{lat:41.5973,lng:-84.1243,slug:"fulton"},"Gallia":{lat:38.817,lng:-82.3017,slug:"gallia"},"Geauga":{lat:41.4993,lng:-81.1735,slug:"geauga"},"Greene":{lat:39.6875,lng:-83.8949,slug:"greene"},"Guernsey":{lat:40.0567,lng:-81.4979,slug:"guernsey"},"Hamilton":{lat:39.1969,lng:-84.5442,slug:"hamilton"},"Hancock":{lat:41.0002,lng:-83.6659,slug:"hancock"},"Hardin":{lat:40.6604,lng:-83.6641,slug:"hardin"},"Harrison":{lat:40.2923,lng:-81.0916,slug:"harrison"},"Henry":{lat:41.3316,lng:-84.0689,slug:"henry"},"Highland":{lat:39.1844,lng:-83.6014,slug:"highland"},"Hocking":{lat:39.4903,lng:-82.4834,slug:"hocking"},"Holmes":{lat:40.5656,lng:-81.93,slug:"holmes"},"Huron":{lat:41.1451,lng:-82.5946,slug:"huron"},"Jackson":{lat:39.0135,lng:-82.6141,slug:"jackson"},"Jefferson":{lat:40.3994,lng:-80.7635,slug:"jefferson"},"Knox":{lat:40.4036,lng:-82.4224,slug:"knox"},"Lake":{lat:41.7781,lng:-81.1973,slug:"lake"},"Lawrence":{lat:38.6039,lng:-82.5172,slug:"lawrence"},"Licking":{lat:40.0915,lng:-82.4834,slug:"licking"},"Logan":{lat:40.3876,lng:-83.7663,slug:"logan"},"Lorain":{lat:41.4388,lng:-82.1797,slug:"lorain"},"Lucas":{lat:41.6823,lng:-83.4689,slug:"lucas"},"Madison":{lat:39.8966,lng:-83.4009,slug:"madison"},"Mahoning":{lat:41.0109,lng:-80.7704,slug:"mahoning"},"Marion":{lat:40.588,lng:-83.1688,slug:"marion"},"Medina":{lat:41.1162,lng:-81.8998,slug:"medina"},"Meigs":{lat:39.0898,lng:-82.0284,slug:"meigs"},"Mercer":{lat:40.5353,lng:-84.6321,slug:"mercer"},"Miami":{lat:40.0533,lng:-84.2284,slug:"miami"},"Monroe":{lat:39.7263,lng:-81.091,slug:"monroe"},"Montgomery":{lat:39.7537,lng:-84.2906,slug:"montgomery"},"Morgan":{lat:39.6249,lng:-81.8617,slug:"morgan"},"Morrow":{lat:40.5253,lng:-82.7977,slug:"morrow"},"Muskingum":{lat:39.966,lng:-81.9435,slug:"muskingum"},"Noble":{lat:39.7672,lng:-81.4525,slug:"noble"},"Ottawa":{lat:41.5455,lng:-83.0126,slug:"ottawa"},"Paulding":{lat:41.1189,lng:-84.5821,slug:"paulding"},"Perry":{lat:39.7432,lng:-82.238,slug:"perry"},"Pickaway":{lat:39.6489,lng:-83.0528,slug:"pickaway"},"Pike":{lat:39.0713,lng:-83.0529,slug:"pike"},"Portage":{lat:41.169,lng:-81.197,slug:"portage"},"Preble":{lat:39.7388,lng:-84.6448,slug:"preble"},"Putnam":{lat:41.0245,lng:-84.1299,slug:"putnam"},"Richland":{lat:40.7742,lng:-82.5428,slug:"richland"},"Ross":{lat:39.3239,lng:-83.0595,slug:"ross"},"Sandusky":{lat:41.3553,lng:-83.1428,slug:"sandusky"},"Scioto":{lat:38.8149,lng:-82.9987,slug:"scioto"},"Seneca":{lat:41.12,lng:-83.1275,slug:"seneca"},"Shelby":{lat:40.3367,lng:-84.2041,slug:"shelby"},"Stark":{lat:40.8141,lng:-81.3657,slug:"stark"},"Summit":{lat:41.1218,lng:-81.5349,slug:"summit"},"Trumbull":{lat:41.3064,lng:-80.7704,slug:"trumbull"},"Tuscarawas":{lat:40.4474,lng:-81.4712,slug:"tuscarawas"},"Union":{lat:40.2959,lng:-83.367,slug:"union"},"Van Wert":{lat:40.8555,lng:-84.5858,slug:"vanwert"},"Vinton":{lat:39.252,lng:-82.486,slug:"vinton"},"Warren":{lat:39.4257,lng:-84.1699,slug:"warren"},"Washington":{lat:39.4507,lng:-81.4906,slug:"washington"},"Wayne":{lat:40.8297,lng:-81.8872,slug:"wayne"},"Williams":{lat:41.565,lng:-84.5843,slug:"williams"},"Wood":{lat:41.3602,lng:-83.6227,slug:"wood"},"Wyandot":{lat:40.8398,lng:-83.3137,slug:"wyandot"}},
  IN: {"Adams":{lat:40.7457,lng:-84.9361,slug:"adams"},"Allen":{lat:41.0919,lng:-85.0718,slug:"allen"},"Bartholomew":{lat:39.2058,lng:-85.898,slug:"bartholomew"},"Benton":{lat:40.6009,lng:-87.3148,slug:"benton"},"Blackford":{lat:40.4727,lng:-85.3237,slug:"blackford"},"Boone":{lat:40.0509,lng:-86.469,slug:"boone"},"Brown":{lat:39.1951,lng:-86.2301,slug:"brown"},"Carroll":{lat:40.585,lng:-86.5651,slug:"carroll"},"Cass":{lat:40.7538,lng:-86.3552,slug:"cass"},"Clark":{lat:38.4762,lng:-85.7111,slug:"clark"},"Clay":{lat:39.3939,lng:-87.1159,slug:"clay"},"Clinton":{lat:40.3059,lng:-86.4776,slug:"clinton"},"Crawford":{lat:38.2894,lng:-86.4409,slug:"crawford"},"Daviess":{lat:38.6961,lng:-87.0769,slug:"daviess"},"DeKalb":{lat:41.3968,lng:-85.0027,slug:"dekalb"},"Dearborn":{lat:39.1409,lng:-84.9759,slug:"dearborn"},"Decatur":{lat:39.306,lng:-85.4998,slug:"decatur"},"Delaware":{lat:40.2275,lng:-85.3993,slug:"delaware"},"Dubois":{lat:38.3733,lng:-86.8734,slug:"dubois"},"Elkhart":{lat:41.6007,lng:-85.864,slug:"elkhart"},"Fayette":{lat:39.6397,lng:-85.185,slug:"fayette"},"Floyd":{lat:38.3181,lng:-85.9118,slug:"floyd"},"Fountain":{lat:40.1212,lng:-87.2349,slug:"fountain"},"Franklin":{lat:39.4098,lng:-85.067,slug:"franklin"},"Fulton":{lat:41.0504,lng:-86.265,slug:"fulton"},"Gibson":{lat:38.3174,lng:-87.5805,slug:"gibson"},"Grant":{lat:40.5158,lng:-85.6549,slug:"grant"},"Greene":{lat:39.0471,lng:-87.0048,slug:"greene"},"Hamilton":{lat:40.0535,lng:-86.0217,slug:"hamilton"},"Hancock":{lat:39.8225,lng:-85.7732,slug:"hancock"},"Harrison":{lat:38.1865,lng:-86.1038,slug:"harrison"},"Hendricks":{lat:39.769,lng:-86.5099,slug:"hendricks"},"Henry":{lat:39.9296,lng:-85.3974,slug:"henry"},"Howard":{lat:40.4835,lng:-86.1141,slug:"howard"},"Huntington":{lat:40.8264,lng:-85.4786,slug:"huntington"},"Jackson":{lat:38.912,lng:-86.0425,slug:"jackson"},"Jasper":{lat:41.0177,lng:-87.1188,slug:"jasper"},"Jay":{lat:40.435,lng:-85.0023,slug:"jay"},"Jefferson":{lat:38.7836,lng:-85.4401,slug:"jefferson"},"Jennings":{lat:38.9962,lng:-85.6281,slug:"jennings"},"Johnson":{lat:39.4961,lng:-86.0943,slug:"johnson"},"Knox":{lat:38.6884,lng:-87.4204,slug:"knox"},"Kosciusko":{lat:41.2443,lng:-85.8616,slug:"kosciusko"},"LaGrange":{lat:41.6425,lng:-85.4278,slug:"lagrange"},"LaPorte":{lat:41.549,lng:-86.7447,slug:"laporte"},"Lake":{lat:41.4722,lng:-87.3743,slug:"lake"},"Lawrence":{lat:38.8398,lng:-86.4878,slug:"lawrence"},"Madison":{lat:40.1662,lng:-85.7225,slug:"madison"},"Marion":{lat:39.783,lng:-86.1358,slug:"marion"},"Marshall":{lat:41.325,lng:-86.269,slug:"marshall"},"Martin":{lat:38.7053,lng:-86.8018,slug:"martin"},"Miami":{lat:40.7729,lng:-86.0443,slug:"miami"},"Monroe":{lat:39.1607,lng:-86.5233,slug:"monroe"},"Montgomery":{lat:40.0403,lng:-86.8927,slug:"montgomery"},"Morgan":{lat:39.4826,lng:-86.4475,slug:"morgan"},"Newton":{lat:40.9624,lng:-87.4022,slug:"newton"},"Noble":{lat:41.4047,lng:-85.4173,slug:"noble"},"Ohio":{lat:38.9405,lng:-84.9643,slug:"ohio"},"Orange":{lat:38.5474,lng:-86.4893,slug:"orange"},"Owen":{lat:39.3173,lng:-86.8388,slug:"owen"},"Parke":{lat:39.7743,lng:-87.197,slug:"parke"},"Perry":{lat:38.0814,lng:-86.6265,slug:"perry"},"Pike":{lat:38.398,lng:-87.2325,slug:"pike"},"Porter":{lat:41.5099,lng:-87.0713,slug:"porter"},"Posey":{lat:38.0276,lng:-87.8687,slug:"posey"},"Pulaski":{lat:41.0453,lng:-86.6925,slug:"pulaski"},"Putnam":{lat:39.6655,lng:-86.8534,slug:"putnam"},"Randolph":{lat:40.1641,lng:-85.0058,slug:"randolph"},"Ripley":{lat:39.1002,lng:-85.2605,slug:"ripley"},"Rush":{lat:39.6224,lng:-85.4665,slug:"rush"},"Scott":{lat:38.6794,lng:-85.7519,slug:"scott"},"Shelby":{lat:39.5241,lng:-85.7922,slug:"shelby"},"Spencer":{lat:38.0097,lng:-87.0104,slug:"spencer"},"St. Joseph":{lat:41.6177,lng:-86.288,slug:"stjoseph"},"Starke":{lat:41.2845,lng:-86.6446,slug:"starke"},"Steuben":{lat:41.6435,lng:-85.0024,slug:"steuben"},"Sullivan":{lat:39.0892,lng:-87.4158,slug:"sullivan"},"Switzerland":{lat:38.8259,lng:-85.0297,slug:"switzerland"},"Tippecanoe":{lat:40.3891,lng:-86.8936,slug:"tippecanoe"},"Tipton":{lat:40.3102,lng:-86.0562,slug:"tipton"},"Union":{lat:39.6231,lng:-84.9251,slug:"union"},"Vanderburgh":{lat:38.0201,lng:-87.5862,slug:"vanderburgh"},"Vermillion":{lat:39.854,lng:-87.4621,slug:"vermillion"},"Vigo":{lat:39.4309,lng:-87.391,slug:"vigo"},"Wabash":{lat:40.8437,lng:-85.7952,slug:"wabash"},"Warren":{lat:40.3525,lng:-87.3752,slug:"warren"},"Warrick":{lat:38.0977,lng:-87.272,slug:"warrick"},"Washington":{lat:38.6006,lng:-86.1048,slug:"washington"},"Wayne":{lat:39.8631,lng:-85.0067,slug:"wayne"},"Wells":{lat:40.7355,lng:-85.2133,slug:"wells"},"White":{lat:40.751,lng:-86.8643,slug:"white"},"Whitley":{lat:41.1364,lng:-85.5019,slug:"whitley"}},
  WI: {"Adams":{lat:43.9738,lng:-89.7672,slug:"adams"},"Ashland":{lat:46.5444,lng:-90.6797,slug:"ashland"},"Barron":{lat:45.4372,lng:-91.8529,slug:"barron"},"Bayfield":{lat:46.6342,lng:-91.1773,slug:"bayfield"},"Brown":{lat:44.474,lng:-87.9961,slug:"brown"},"Buffalo":{lat:44.3856,lng:-91.7613,slug:"buffalo"},"Burnett":{lat:45.8669,lng:-92.3757,slug:"burnett"},"Calumet":{lat:44.0784,lng:-88.2121,slug:"calumet"},"Chippewa":{lat:45.0691,lng:-91.2835,slug:"chippewa"},"Clark":{lat:44.7393,lng:-90.61,slug:"clark"},"Columbia":{lat:43.4719,lng:-89.3305,slug:"columbia"},"Crawford":{lat:43.2428,lng:-90.9352,slug:"crawford"},"Dane":{lat:43.0675,lng:-89.4179,slug:"dane"},"Dodge":{lat:43.4296,lng:-88.7019,slug:"dodge"},"Door":{lat:45.0934,lng:-87.0487,slug:"door"},"Douglas":{lat:46.4632,lng:-91.8925,slug:"douglas"},"Dunn":{lat:44.9478,lng:-91.8976,slug:"dunn"},"Eau Claire":{lat:44.7264,lng:-91.2864,slug:"eauclaire"},"Florence":{lat:45.8718,lng:-88.407,slug:"florence"},"Fond du Lac":{lat:43.7547,lng:-88.4933,slug:"fonddulac"},"Forest":{lat:45.6669,lng:-88.7733,slug:"forest"},"Grant":{lat:42.87,lng:-90.6942,slug:"grant"},"Green":{lat:42.6755,lng:-89.6051,slug:"green"},"Green Lake":{lat:43.7802,lng:-88.9704,slug:"greenlake"},"Iowa":{lat:43.001,lng:-90.1337,slug:"iowa"},"Iron":{lat:46.3265,lng:-90.2613,slug:"iron"},"Jackson":{lat:44.3246,lng:-90.7995,slug:"jackson"},"Jefferson":{lat:43.0138,lng:-88.774,slug:"jefferson"},"Juneau":{lat:43.9328,lng:-90.114,slug:"juneau"},"Kenosha":{lat:42.5875,lng:-87.88,slug:"kenosha"},"Kewaunee":{lat:44.6057,lng:-87.448,slug:"kewaunee"},"La Crosse":{lat:43.9082,lng:-91.1118,slug:"lacrosse"},"Lafayette":{lat:42.6556,lng:-90.1303,slug:"lafayette"},"Langlade":{lat:45.2549,lng:-89.0671,slug:"langlade"},"Lincoln":{lat:45.3331,lng:-89.7322,slug:"lincoln"},"Manitowoc":{lat:44.1561,lng:-87.5774,slug:"manitowoc"},"Marathon":{lat:44.898,lng:-89.7578,slug:"marathon"},"Marinette":{lat:45.3469,lng:-87.9912,slug:"marinette"},"Marquette":{lat:43.8261,lng:-89.4091,slug:"marquette"},"Menominee":{lat:44.9913,lng:-88.6693,slug:"menominee"},"Milwaukee":{lat:42.9126,lng:-87.8623,slug:"milwaukee"},"Monroe":{lat:43.9452,lng:-90.62,slug:"monroe"},"Oconto":{lat:44.9966,lng:-88.2065,slug:"oconto"},"Oneida":{lat:45.7162,lng:-89.5345,slug:"oneida"},"Outagamie":{lat:44.4182,lng:-88.465,slug:"outagamie"},"Ozaukee":{lat:43.5018,lng:-87.8476,slug:"ozaukee"},"Pepin":{lat:44.6274,lng:-91.8349,slug:"pepin"},"Pierce":{lat:44.7253,lng:-92.4263,slug:"pierce"},"Polk":{lat:45.462,lng:-92.4471,slug:"polk"},"Portage":{lat:44.4762,lng:-89.4981,slug:"portage"},"Price":{lat:45.6791,lng:-90.3597,slug:"price"},"Racine":{lat:42.7804,lng:-87.7716,slug:"racine"},"Richland":{lat:43.3762,lng:-90.4357,slug:"richland"},"Rock":{lat:42.6699,lng:-89.0753,slug:"rock"},"Rusk":{lat:45.4727,lng:-91.1367,slug:"rusk"},"Sauk":{lat:43.428,lng:-89.9433,slug:"sauk"},"Sawyer":{lat:45.865,lng:-91.1471,slug:"sawyer"},"Shawano":{lat:44.7896,lng:-88.7558,slug:"shawano"},"Sheboygan":{lat:43.7387,lng:-87.7315,slug:"sheboygan"},"St. Croix":{lat:45.029,lng:-92.4473,slug:"stcroix"},"Taylor":{lat:45.2117,lng:-90.5049,slug:"taylor"},"Trempealeau":{lat:44.303,lng:-91.3589,slug:"trempealeau"},"Vernon":{lat:43.5994,lng:-90.822,slug:"vernon"},"Vilas":{lat:46.0498,lng:-89.5013,slug:"vilas"},"Walworth":{lat:42.6681,lng:-88.5417,slug:"walworth"},"Washburn":{lat:45.8925,lng:-91.7964,slug:"washburn"},"Washington":{lat:43.3912,lng:-88.2329,slug:"washington"},"Waukesha":{lat:43.0184,lng:-88.3042,slug:"waukesha"},"Waupaca":{lat:44.478,lng:-88.967,slug:"waupaca"},"Waushara":{lat:44.1128,lng:-89.2398,slug:"waushara"},"Winnebago":{lat:44.0857,lng:-88.6681,slug:"winnebago"},"Wood":{lat:44.4614,lng:-90.0388,slug:"wood"}},
  MN: {"Aitkin":{lat:46.6024,lng:-93.4197,slug:"aitkin"},"Anoka":{lat:45.2741,lng:-93.2427,slug:"anoka"},"Becker":{lat:46.9376,lng:-95.7418,slug:"becker"},"Beltrami":{lat:47.8795,lng:-95.005,slug:"beltrami"},"Benton":{lat:45.7012,lng:-94.0014,slug:"benton"},"Big Stone":{lat:45.4199,lng:-96.4022,slug:"bigstone"},"Blue Earth":{lat:44.0337,lng:-94.064,slug:"blueearth"},"Brown":{lat:44.2465,lng:-94.7336,slug:"brown"},"Carlton":{lat:46.6038,lng:-92.671,slug:"carlton"},"Carver":{lat:44.8213,lng:-93.8001,slug:"carver"},"Cass":{lat:46.9517,lng:-94.3337,slug:"cass"},"Chippewa":{lat:45.0286,lng:-95.5641,slug:"chippewa"},"Chisago":{lat:45.5054,lng:-92.9038,slug:"chisago"},"Clay":{lat:46.8984,lng:-96.4949,slug:"clay"},"Clearwater":{lat:47.5759,lng:-95.3711,slug:"clearwater"},"Cook":{lat:47.7586,lng:-90.3443,slug:"cook"},"Cottonwood":{lat:44.0106,lng:-95.1832,slug:"cottonwood"},"Crow Wing":{lat:46.4917,lng:-94.0707,slug:"crowwing"},"Dakota":{lat:44.6709,lng:-93.0625,slug:"dakota"},"Dodge":{lat:44.0207,lng:-92.8694,slug:"dodge"},"Douglas":{lat:45.9368,lng:-95.4622,slug:"douglas"},"Faribault":{lat:43.6765,lng:-93.9472,slug:"faribault"},"Fillmore":{lat:43.6792,lng:-92.0939,slug:"fillmore"},"Freeborn":{lat:43.6742,lng:-93.3503,slug:"freeborn"},"Goodhue":{lat:44.4062,lng:-92.716,slug:"goodhue"},"Grant":{lat:45.9307,lng:-96.0107,slug:"grant"},"Hennepin":{lat:45.0061,lng:-93.4752,slug:"hennepin"},"Houston":{lat:43.667,lng:-91.5016,slug:"houston"},"Hubbard":{lat:47.0956,lng:-94.9133,slug:"hubbard"},"Isanti":{lat:45.5624,lng:-93.2963,slug:"isanti"},"Itasca":{lat:47.4908,lng:-93.6111,slug:"itasca"},"Jackson":{lat:43.6711,lng:-95.1497,slug:"jackson"},"Kanabec":{lat:45.9478,lng:-93.2978,slug:"kanabec"},"Kandiyohi":{lat:45.1527,lng:-95.005,slug:"kandiyohi"},"Kittson":{lat:48.776,lng:-96.7803,slug:"kittson"},"Koochiching":{lat:48.2454,lng:-93.7829,slug:"koochiching"},"Lac qui Parle":{lat:44.9998,lng:-96.1769,slug:"lacquiparle"},"Lake":{lat:47.5171,lng:-91.4117,slug:"lake"},"Lake of the Woods":{lat:48.7681,lng:-94.9046,slug:"lakeofthewoods"},"Le Sueur":{lat:44.3734,lng:-93.7301,slug:"lesueur"},"Lincoln":{lat:44.4082,lng:-96.272,slug:"lincoln"},"Lyon":{lat:44.4092,lng:-95.8473,slug:"lyon"},"Mahnomen":{lat:47.3284,lng:-95.8111,slug:"mahnomen"},"Marshall":{lat:48.3627,lng:-96.3578,slug:"marshall"},"Martin":{lat:43.6772,lng:-94.5471,slug:"martin"},"McLeod":{lat:44.8217,lng:-94.2723,slug:"mcleod"},"Meeker":{lat:45.1232,lng:-94.5273,slug:"meeker"},"Mille Lacs":{lat:45.929,lng:-93.633,slug:"millelacs"},"Morrison":{lat:46.0205,lng:-94.2666,slug:"morrison"},"Mower":{lat:43.6662,lng:-92.7595,slug:"mower"},"Murray":{lat:44.0156,lng:-95.7616,slug:"murray"},"Nicollet":{lat:44.3588,lng:-94.2457,slug:"nicollet"},"Nobles":{lat:43.6777,lng:-95.7631,slug:"nobles"},"Norman":{lat:47.3295,lng:-96.4638,slug:"norman"},"Olmsted":{lat:43.9995,lng:-92.4101,slug:"olmsted"},"Otter Tail":{lat:46.4057,lng:-95.7146,slug:"ottertail"},"Pennington":{lat:48.0692,lng:-96.0377,slug:"pennington"},"Pine":{lat:46.1009,lng:-92.7631,slug:"pine"},"Pipestone":{lat:44.0154,lng:-96.257,slug:"pipestone"},"Polk":{lat:47.7743,lng:-96.4,slug:"polk"},"Pope":{lat:45.5896,lng:-95.4467,slug:"pope"},"Ramsey":{lat:45.0152,lng:-93.1,slug:"ramsey"},"Red Lake":{lat:47.8655,lng:-96.0872,slug:"redlake"},"Redwood":{lat:44.4035,lng:-95.2542,slug:"redwood"},"Renville":{lat:44.7237,lng:-94.9556,slug:"renville"},"Rice":{lat:44.3508,lng:-93.2985,slug:"rice"},"Rock":{lat:43.6696,lng:-96.2632,slug:"rock"},"Roseau":{lat:48.7611,lng:-95.8215,slug:"roseau"},"Scott":{lat:44.6518,lng:-93.5337,slug:"scott"},"Sherburne":{lat:45.4532,lng:-93.7692,slug:"sherburne"},"Sibley":{lat:44.5757,lng:-94.2301,slug:"sibley"},"St. Louis":{lat:47.5786,lng:-92.5146,slug:"stlouis"},"Stearns":{lat:45.5552,lng:-94.6105,slug:"stearns"},"Steele":{lat:44.0153,lng:-93.2205,slug:"steele"},"Stevens":{lat:45.5935,lng:-95.9923,slug:"stevens"},"Swift":{lat:45.2758,lng:-95.6901,slug:"swift"},"Todd":{lat:46.0666,lng:-94.9006,slug:"todd"},"Traverse":{lat:45.7699,lng:-96.4748,slug:"traverse"},"Wabasha":{lat:44.2896,lng:-92.2335,slug:"wabasha"},"Wadena":{lat:46.587,lng:-94.9886,slug:"wadena"},"Waseca":{lat:44.0185,lng:-93.5898,slug:"waseca"},"Washington":{lat:45.0379,lng:-92.8901,slug:"washington"},"Watonwan":{lat:43.9781,lng:-94.6138,slug:"watonwan"},"Wilkin":{lat:46.3623,lng:-96.4767,slug:"wilkin"},"Winona":{lat:43.9814,lng:-91.777,slug:"winona"},"Wright":{lat:45.1751,lng:-93.9664,slug:"wright"},"Yellow Medicine":{lat:44.7157,lng:-95.8628,slug:"yellowmedicine"}},
  AR: {"Arkansas":{lat:34.2896,lng:-91.3765,slug:"arkansas"},"Ashley":{lat:33.1908,lng:-91.7723,slug:"ashley"},"Baxter":{lat:36.2803,lng:-92.3299,slug:"baxter"},"Benton":{lat:36.3378,lng:-94.2563,slug:"benton"},"Boone":{lat:36.3043,lng:-93.0792,slug:"boone"},"Bradley":{lat:33.4665,lng:-92.1692,slug:"bradley"},"Calhoun":{lat:33.5605,lng:-92.5139,slug:"calhoun"},"Carroll":{lat:36.3374,lng:-93.541,slug:"carroll"},"Chicot":{lat:33.2671,lng:-91.2972,slug:"chicot"},"Clark":{lat:34.0533,lng:-93.1762,slug:"clark"},"Clay":{lat:36.3673,lng:-90.4187,slug:"clay"},"Cleburne":{lat:35.5936,lng:-92.0089,slug:"cleburne"},"Cleveland":{lat:33.8932,lng:-92.1887,slug:"cleveland"},"Columbia":{lat:33.223,lng:-93.2328,slug:"columbia"},"Conway":{lat:35.2657,lng:-92.6892,slug:"conway"},"Craighead":{lat:35.8277,lng:-90.6314,slug:"craighead"},"Crawford":{lat:35.583,lng:-94.2362,slug:"crawford"},"Crittenden":{lat:35.1976,lng:-90.3051,slug:"crittenden"},"Cross":{lat:35.2857,lng:-90.764,slug:"cross"},"Dallas":{lat:33.9678,lng:-92.654,slug:"dallas"},"Desha":{lat:33.8288,lng:-91.2441,slug:"desha"},"Drew":{lat:33.5872,lng:-91.7228,slug:"drew"},"Faulkner":{lat:35.1465,lng:-92.3369,slug:"faulkner"},"Franklin":{lat:35.5086,lng:-93.8877,slug:"franklin"},"Fulton":{lat:36.3813,lng:-91.8193,slug:"fulton"},"Garland":{lat:34.5789,lng:-93.1469,slug:"garland"},"Grant":{lat:34.2856,lng:-92.423,slug:"grant"},"Greene":{lat:36.1206,lng:-90.5663,slug:"greene"},"Hempstead":{lat:33.736,lng:-93.6644,slug:"hempstead"},"Hot Spring":{lat:34.3152,lng:-92.9441,slug:"hotspring"},"Howard":{lat:34.0831,lng:-93.9909,slug:"howard"},"Independence":{lat:35.7375,lng:-91.5599,slug:"independence"},"Izard":{lat:36.0949,lng:-91.9136,slug:"izard"},"Jackson":{lat:35.5965,lng:-91.2232,slug:"jackson"},"Jefferson":{lat:34.2772,lng:-91.9297,slug:"jefferson"},"Johnson":{lat:35.5734,lng:-93.4663,slug:"johnson"},"Lafayette":{lat:33.2406,lng:-93.6115,slug:"lafayette"},"Lawrence":{lat:36.0411,lng:-91.1012,slug:"lawrence"},"Lee":{lat:34.7795,lng:-90.7797,slug:"lee"},"Lincoln":{lat:33.9564,lng:-91.7424,slug:"lincoln"},"Little River":{lat:33.7019,lng:-94.2363,slug:"littleriver"},"Logan":{lat:35.2187,lng:-93.7209,slug:"logan"},"Lonoke":{lat:34.7551,lng:-91.8941,slug:"lonoke"},"Madison":{lat:36.0125,lng:-93.7241,slug:"madison"},"Marion":{lat:36.2667,lng:-92.6786,slug:"marion"},"Miller":{lat:33.3055,lng:-93.9015,slug:"miller"},"Mississippi":{lat:35.7669,lng:-90.0522,slug:"mississippi"},"Monroe":{lat:34.6795,lng:-91.2033,slug:"monroe"},"Montgomery":{lat:34.5457,lng:-93.6642,slug:"montgomery"},"Nevada":{lat:33.6667,lng:-93.3051,slug:"nevada"},"Newton":{lat:35.9107,lng:-93.2159,slug:"newton"},"Ouachita":{lat:33.5912,lng:-92.8784,slug:"ouachita"},"Perry":{lat:34.9464,lng:-92.9269,slug:"perry"},"Phillips":{lat:34.4237,lng:-90.8556,slug:"phillips"},"Pike":{lat:34.1582,lng:-93.6587,slug:"pike"},"Poinsett":{lat:35.5689,lng:-90.6811,slug:"poinsett"},"Polk":{lat:34.491,lng:-94.2309,slug:"polk"},"Pope":{lat:35.4566,lng:-93.0268,slug:"pope"},"Prairie":{lat:34.8311,lng:-91.5536,slug:"prairie"},"Pulaski":{lat:34.7703,lng:-92.313,slug:"pulaski"},"Randolph":{lat:36.3413,lng:-91.0284,slug:"randolph"},"Saline":{lat:34.6485,lng:-92.6745,slug:"saline"},"Scott":{lat:34.8589,lng:-94.0636,slug:"scott"},"Searcy":{lat:35.8964,lng:-92.6959,slug:"searcy"},"Sebastian":{lat:35.197,lng:-94.275,slug:"sebastian"},"Sevier":{lat:33.9949,lng:-94.2433,slug:"sevier"},"Sharp":{lat:36.1734,lng:-91.4711,slug:"sharp"},"St. Francis":{lat:35.0228,lng:-90.7515,slug:"stfrancis"},"Stone":{lat:35.857,lng:-92.1405,slug:"stone"},"Union":{lat:33.1682,lng:-92.5981,slug:"union"},"Van Buren":{lat:35.583,lng:-92.516,slug:"vanburen"},"Washington":{lat:35.978,lng:-94.2173,slug:"washington"},"White":{lat:35.2551,lng:-91.753,slug:"white"},"Woodruff":{lat:35.1928,lng:-91.2445,slug:"woodruff"},"Yell":{lat:34.9977,lng:-93.4083,slug:"yell"}},
  NM: {"Bernalillo":{lat:35.0536,lng:-106.6691,slug:"bernalillo"},"Catron":{lat:33.9016,lng:-108.3919,slug:"catron"},"Chaves":{lat:33.3616,lng:-104.4698,slug:"chaves"},"Cibola":{lat:34.9283,lng:-107.9927,slug:"cibola"},"Colfax":{lat:36.613,lng:-104.6401,slug:"colfax"},"Curry":{lat:34.573,lng:-103.3461,slug:"curry"},"De Baca":{lat:34.3593,lng:-104.3687,slug:"debaca"},"DoÃ±a Ana":{lat:32.3499,lng:-106.835,slug:"doã±aana"},"Eddy":{lat:32.4578,lng:-104.3064,slug:"eddy"},"Grant":{lat:32.7321,lng:-108.3815,slug:"grant"},"Guadalupe":{lat:34.8698,lng:-104.785,slug:"guadalupe"},"Harding":{lat:35.8594,lng:-103.8534,slug:"harding"},"Hidalgo":{lat:31.8981,lng:-108.7519,slug:"hidalgo"},"Lea":{lat:32.7957,lng:-103.4133,slug:"lea"},"Lincoln":{lat:33.7408,lng:-105.4498,slug:"lincoln"},"Los Alamos":{lat:35.87,lng:-106.308,slug:"losalamos"},"Luna":{lat:32.1845,lng:-107.7472,slug:"luna"},"McKinley":{lat:35.5841,lng:-108.2533,slug:"mckinley"},"Mora":{lat:35.9828,lng:-104.9219,slug:"mora"},"Otero":{lat:32.6156,lng:-105.7513,slug:"otero"},"Quay":{lat:35.107,lng:-103.5481,slug:"quay"},"Rio Arriba":{lat:36.5097,lng:-106.694,slug:"rioarriba"},"Roosevelt":{lat:34.0212,lng:-103.483,slug:"roosevelt"},"San Juan":{lat:36.5116,lng:-108.3246,slug:"sanjuan"},"San Miguel":{lat:35.4769,lng:-104.8035,slug:"sanmiguel"},"Sandoval":{lat:35.6851,lng:-106.8831,slug:"sandoval"},"Santa Fe":{lat:35.5145,lng:-105.964,slug:"santafe"},"Sierra":{lat:33.1195,lng:-107.1882,slug:"sierra"},"Socorro":{lat:33.9917,lng:-106.9391,slug:"socorro"},"Taos":{lat:36.5772,lng:-105.6389,slug:"taos"},"Torrance":{lat:34.555,lng:-105.8906,slug:"torrance"},"Union":{lat:36.4881,lng:-103.4757,slug:"union"},"Valencia":{lat:34.7168,lng:-106.8066,slug:"valencia"}},
  VA: {"Accomack":{lat:37.7643,lng:-75.6362,slug:"accomack"},"Albemarle":{lat:38.0245,lng:-78.5531,slug:"albemarle"},"Alexandria":{lat:38.8221,lng:-77.0578,slug:"alexandria"},"Alleghany":{lat:37.786,lng:-80.0116,slug:"alleghany"},"Amelia":{lat:37.3412,lng:-77.9849,slug:"amelia"},"Amherst":{lat:37.6035,lng:-79.1443,slug:"amherst"},"Appomattox":{lat:37.3742,lng:-78.8114,slug:"appomattox"},"Arlington":{lat:38.8785,lng:-77.1002,slug:"arlington"},"Augusta":{lat:38.1613,lng:-79.1245,slug:"augusta"},"Bath":{lat:38.0607,lng:-79.7397,slug:"bath"},"Bedford":{lat:37.336,lng:-79.5174,slug:"bedford"},"Bland":{lat:37.1309,lng:-81.1318,slug:"bland"},"Botetourt":{lat:37.5563,lng:-79.8128,slug:"botetourt"},"Bristol":{lat:36.6097,lng:-82.1677,slug:"bristol"},"Brunswick":{lat:36.7644,lng:-77.86,slug:"brunswick"},"Buchanan":{lat:37.2654,lng:-82.042,slug:"buchanan"},"Buckingham":{lat:37.5779,lng:-78.5249,slug:"buckingham"},"Buena Vista":{lat:37.7319,lng:-79.3579,slug:"buenavista"},"Campbell":{lat:37.2042,lng:-79.098,slug:"campbell"},"Caroline":{lat:38.0312,lng:-77.3443,slug:"caroline"},"Carroll":{lat:36.7318,lng:-80.7351,slug:"carroll"},"Charles City":{lat:37.3538,lng:-77.0653,slug:"charlescity"},"Charlotte":{lat:37.017,lng:-78.6621,slug:"charlotte"},"Charlottesville":{lat:38.0381,lng:-78.4838,slug:"charlottesville"},"Chesapeake":{lat:36.6771,lng:-76.3051,slug:"chesapeake"},"Chesterfield":{lat:37.3776,lng:-77.5858,slug:"chesterfield"},"Clarke":{lat:39.1117,lng:-78.0008,slug:"clarke"},"Colonial Heights":{lat:37.2612,lng:-77.3984,slug:"colonialheights"},"Covington":{lat:37.7784,lng:-79.9865,slug:"covington"},"Craig":{lat:37.4812,lng:-80.2111,slug:"craig"},"Culpeper":{lat:38.4812,lng:-77.9557,slug:"culpeper"},"Cumberland":{lat:37.509,lng:-78.2416,slug:"cumberland"},"Danville":{lat:36.5814,lng:-79.3956,slug:"danville"},"Dickenson":{lat:37.1235,lng:-82.3521,slug:"dickenson"},"Dinwiddie":{lat:37.0798,lng:-77.6349,slug:"dinwiddie"},"Emporia":{lat:36.6974,lng:-77.534,slug:"emporia"},"Essex":{lat:37.9409,lng:-76.9516,slug:"essex"},"Fairfax":{lat:38.8329,lng:-77.2733,slug:"fairfax"},"Falls Church":{lat:38.8844,lng:-77.175,slug:"fallschurch"},"Fauquier":{lat:38.736,lng:-77.812,slug:"fauquier"},"Floyd":{lat:36.9276,lng:-80.3661,slug:"floyd"},"Fluvanna":{lat:37.8418,lng:-78.2754,slug:"fluvanna"},"Franklin":{lat:36.6826,lng:-76.939,slug:"franklin"},"Frederick":{lat:39.2039,lng:-78.2631,slug:"frederick"},"Fredericksburg":{lat:38.2989,lng:-77.4867,slug:"fredericksburg"},"Galax":{lat:36.6666,lng:-80.9171,slug:"galax"},"Giles":{lat:37.3107,lng:-80.7085,slug:"giles"},"Gloucester":{lat:37.4153,lng:-76.5352,slug:"gloucester"},"Goochland":{lat:37.7198,lng:-77.9132,slug:"goochland"},"Grayson":{lat:36.6567,lng:-81.2303,slug:"grayson"},"Greene":{lat:38.2961,lng:-78.4588,slug:"greene"},"Greensville":{lat:36.6789,lng:-77.5543,slug:"greensville"},"Halifax":{lat:36.7644,lng:-78.9375,slug:"halifax"},"Hampton":{lat:37.0511,lng:-76.3691,slug:"hampton"},"Hanover":{lat:37.7656,lng:-77.4994,slug:"hanover"},"Harrisonburg":{lat:38.4372,lng:-78.871,slug:"harrisonburg"},"Henrico":{lat:37.5467,lng:-77.412,slug:"henrico"},"Henry":{lat:36.682,lng:-79.8754,slug:"henry"},"Highland":{lat:38.3593,lng:-79.5681,slug:"highland"},"Hopewell":{lat:37.2948,lng:-77.3093,slug:"hopewell"},"Isle of Wight":{lat:36.8919,lng:-76.7252,slug:"isleofwight"},"James City":{lat:37.3256,lng:-76.7813,slug:"jamescity"},"King George":{lat:38.2763,lng:-77.1371,slug:"kinggeorge"},"King William":{lat:37.7107,lng:-77.0981,slug:"kingwilliam"},"King and Queen":{lat:37.7103,lng:-76.8838,slug:"kingandqueen"},"Lancaster":{lat:37.7299,lng:-76.4618,slug:"lancaster"},"Lee":{lat:36.7074,lng:-83.1249,slug:"lee"},"Lexington":{lat:37.7821,lng:-79.4449,slug:"lexington"},"Loudoun":{lat:39.0881,lng:-77.6377,slug:"loudoun"},"Louisa":{lat:37.9773,lng:-77.9621,slug:"louisa"},"Lunenburg":{lat:36.9473,lng:-78.2386,slug:"lunenburg"},"Lynchburg":{lat:37.3997,lng:-79.192,slug:"lynchburg"},"Madison":{lat:38.4149,lng:-78.2759,slug:"madison"},"Manassas":{lat:38.7493,lng:-77.4837,slug:"manassas"},"Manassas Park":{lat:38.7715,lng:-77.4441,slug:"manassaspark"},"Martinsville":{lat:36.6821,lng:-79.8629,slug:"martinsville"},"Mathews":{lat:37.4348,lng:-76.3336,slug:"mathews"},"Mecklenburg":{lat:36.6796,lng:-78.364,slug:"mecklenburg"},"Middlesex":{lat:37.6276,lng:-76.5605,slug:"middlesex"},"Montgomery":{lat:37.1716,lng:-80.3882,slug:"montgomery"},"Nelson":{lat:37.7888,lng:-78.8871,slug:"nelson"},"New Kent":{lat:37.5078,lng:-76.9931,slug:"newkent"},"Newport News":{lat:37.12,lng:-76.5302,slug:"newportnews"},"Norfolk":{lat:36.8973,lng:-76.2636,slug:"norfolk"},"Northampton":{lat:37.3436,lng:-75.876,slug:"northampton"},"Northumberland":{lat:37.8812,lng:-76.4119,slug:"northumberland"},"Norton":{lat:36.931,lng:-82.6216,slug:"norton"},"Nottoway":{lat:37.1472,lng:-78.0518,slug:"nottoway"},"Orange":{lat:38.2475,lng:-78.0152,slug:"orange"},"Page":{lat:38.6218,lng:-78.4811,slug:"page"},"Patrick":{lat:36.6802,lng:-80.2838,slug:"patrick"},"Petersburg":{lat:37.2125,lng:-77.408,slug:"petersburg"},"Pittsylvania":{lat:36.818,lng:-79.3981,slug:"pittsylvania"},"Poquoson":{lat:37.135,lng:-76.3593,slug:"poquoson"},"Portsmouth":{lat:36.854,lng:-76.3594,slug:"portsmouth"},"Powhatan":{lat:37.5513,lng:-77.9151,slug:"powhatan"},"Prince Edward":{lat:37.2324,lng:-78.4435,slug:"princeedward"},"Prince George":{lat:37.1846,lng:-77.2339,slug:"princegeorge"},"Prince William":{lat:38.7051,lng:-77.4858,slug:"princewilliam"},"Pulaski":{lat:37.0645,lng:-80.7095,slug:"pulaski"},"Radford":{lat:37.1222,lng:-80.5599,slug:"radford"},"Rappahannock":{lat:38.6844,lng:-78.1565,slug:"rappahannock"},"Richmond":{lat:37.9378,lng:-76.7243,slug:"richmond"},"Roanoke":{lat:37.2788,lng:-79.9595,slug:"roanoke"},"Rockbridge":{lat:37.8156,lng:-79.4512,slug:"rockbridge"},"Rockingham":{lat:38.5095,lng:-78.874,slug:"rockingham"},"Russell":{lat:36.9273,lng:-82.1016,slug:"russell"},"Salem":{lat:37.285,lng:-80.0543,slug:"salem"},"Scott":{lat:36.7134,lng:-82.6031,slug:"scott"},"Shenandoah":{lat:38.855,lng:-78.5709,slug:"shenandoah"},"Smyth":{lat:36.8462,lng:-81.5372,slug:"smyth"},"Southampton":{lat:36.7233,lng:-77.1026,slug:"southampton"},"Spotsylvania":{lat:38.1851,lng:-77.6579,slug:"spotsylvania"},"Stafford":{lat:38.4168,lng:-77.452,slug:"stafford"},"Staunton":{lat:38.1611,lng:-79.0633,slug:"staunton"},"Suffolk":{lat:36.6967,lng:-76.6391,slug:"suffolk"},"Surry":{lat:37.1142,lng:-76.8953,slug:"surry"},"Sussex":{lat:36.9251,lng:-77.254,slug:"sussex"},"Tazewell":{lat:37.1241,lng:-81.5687,slug:"tazewell"},"Virginia Beach":{lat:36.7338,lng:-76.046,slug:"virginiabeach"},"Warren":{lat:38.9133,lng:-78.2115,slug:"warren"},"Washington":{lat:36.7224,lng:-81.9546,slug:"washington"},"Waynesboro":{lat:38.0675,lng:-78.8979,slug:"waynesboro"},"Westmoreland":{lat:38.104,lng:-76.7904,slug:"westmoreland"},"Williamsburg":{lat:37.2701,lng:-76.706,slug:"williamsburg"},"Winchester":{lat:39.1735,lng:-78.1704,slug:"winchester"},"Wise":{lat:36.9737,lng:-82.615,slug:"wise"},"Wythe":{lat:36.9172,lng:-81.0803,slug:"wythe"},"York":{lat:37.2471,lng:-76.563,slug:"york"}},
  PR: {"Adjuntas":{lat:18.1778,lng:-66.7511,slug:"adjuntas"},"Aguada":{lat:18.361,lng:-67.1733,slug:"aguada"},"Aguadilla":{lat:18.4576,lng:-67.1187,slug:"aguadilla"},"Aguas Buenas":{lat:18.2524,lng:-66.1343,slug:"aguasbuenas"},"Aibonito":{lat:18.1321,lng:-66.2583,slug:"aibonito"},"Arecibo":{lat:18.4053,lng:-66.6771,slug:"arecibo"},"Arroyo":{lat:17.9903,lng:-66.0573,slug:"arroyo"},"Añasco":{lat:18.2898,lng:-67.1227,slug:"aasco"},"Barceloneta":{lat:18.4464,lng:-66.5634,slug:"barceloneta"},"Barranquitas":{lat:18.2019,lng:-66.3075,slug:"barranquitas"},"Bayamón":{lat:18.3473,lng:-66.1702,slug:"bayamn"},"Cabo Rojo":{lat:18.0418,lng:-67.154,slug:"caborojo"},"Caguas":{lat:18.2186,lng:-66.0537,slug:"caguas"},"Camuy":{lat:18.4208,lng:-66.8641,slug:"camuy"},"Canóvanas":{lat:18.3196,lng:-65.8844,slug:"canvanas"},"Carolina":{lat:18.3778,lng:-65.9618,slug:"carolina"},"Cataño":{lat:18.4388,lng:-66.1403,slug:"catao"},"Cayey":{lat:18.1087,lng:-66.1437,slug:"cayey"},"Ceiba":{lat:18.2498,lng:-65.6728,slug:"ceiba"},"Ciales":{lat:18.2928,lng:-66.5186,slug:"ciales"},"Cidra":{lat:18.1772,lng:-66.1651,slug:"cidra"},"Coamo":{lat:18.0974,lng:-66.3598,slug:"coamo"},"Comerío":{lat:18.2323,lng:-66.2189,slug:"comero"},"Corozal":{lat:18.3044,lng:-66.3299,slug:"corozal"},"Culebra":{lat:18.3154,lng:-65.2875,slug:"culebra"},"Dorado":{lat:18.4351,lng:-66.2681,slug:"dorado"},"Fajardo":{lat:18.3165,lng:-65.6754,slug:"fajardo"},"Florida":{lat:18.3737,lng:-66.5602,slug:"florida"},"Guayama":{lat:18.0066,lng:-66.1303,slug:"guayama"},"Guayanilla":{lat:18.04,lng:-66.7979,slug:"guayanilla"},"Guaynabo":{lat:18.3457,lng:-66.1146,slug:"guaynabo"},"Gurabo":{lat:18.264,lng:-65.975,slug:"gurabo"},"Guánica":{lat:17.9832,lng:-66.9197,slug:"gunica"},"Hatillo":{lat:18.4099,lng:-66.7994,slug:"hatillo"},"Hormigueros":{lat:18.1337,lng:-67.1117,slug:"hormigueros"},"Humacao":{lat:18.1411,lng:-65.8124,slug:"humacao"},"Isabela":{lat:18.4519,lng:-67.0025,slug:"isabela"},"Jayuya":{lat:18.2031,lng:-66.5859,slug:"jayuya"},"Juana Díaz":{lat:18.0502,lng:-66.4965,slug:"juanadaz"},"Juncos":{lat:18.219,lng:-65.9107,slug:"juncos"},"Lajas":{lat:18.0092,lng:-67.0401,slug:"lajas"},"Lares":{lat:18.2647,lng:-66.8626,slug:"lares"},"Las Marías":{lat:18.2347,lng:-66.9854,slug:"lasmaras"},"Las Piedras":{lat:18.1873,lng:-65.8689,slug:"laspiedras"},"Loíza":{lat:18.4214,lng:-65.8987,slug:"loza"},"Luquillo":{lat:18.3463,lng:-65.7266,slug:"luquillo"},"Manatí":{lat:18.4203,lng:-66.4916,slug:"manat"},"Maricao":{lat:18.172,lng:-66.9519,slug:"maricao"},"Maunabo":{lat:18.0175,lng:-65.9172,slug:"maunabo"},"Mayagüez":{lat:18.1751,lng:-67.333,slug:"mayagez"},"Moca":{lat:18.3749,lng:-67.0791,slug:"moca"},"Morovis":{lat:18.3189,lng:-66.4217,slug:"morovis"},"Naguabo":{lat:18.2283,lng:-65.7618,slug:"naguabo"},"Naranjito":{lat:18.2851,lng:-66.2584,slug:"naranjito"},"Orocovis":{lat:18.2151,lng:-66.4417,slug:"orocovis"},"Patillas":{lat:18.0282,lng:-66.0084,slug:"patillas"},"Peñuelas":{lat:18.0645,lng:-66.7285,slug:"peuelas"},"Ponce":{lat:18.0596,lng:-66.6195,slug:"ponce"},"Quebradillas":{lat:18.4404,lng:-66.9205,slug:"quebradillas"},"Rincón":{lat:18.336,lng:-67.231,slug:"rincn"},"Río Grande":{lat:18.3492,lng:-65.8062,slug:"rogrande"},"Sabana Grande":{lat:18.0829,lng:-66.9407,slug:"sabanagrande"},"Salinas":{lat:18.012,lng:-66.25,slug:"salinas"},"San Germán":{lat:18.1082,lng:-67.0395,slug:"sangermn"},"San Juan":{lat:18.3888,lng:-66.0606,slug:"sanjuan"},"San Lorenzo":{lat:18.15,lng:-65.9824,slug:"sanlorenzo"},"San Sebastián":{lat:18.3301,lng:-66.9681,slug:"sansebastin"},"Santa Isabel":{lat:17.9945,lng:-66.3928,slug:"santaisabel"},"Toa Alta":{lat:18.3601,lng:-66.2452,slug:"toaalta"},"Toa Baja":{lat:18.4285,lng:-66.2008,slug:"toabaja"},"Trujillo Alto":{lat:18.3276,lng:-65.9947,slug:"trujilloalto"},"Utuado":{lat:18.2657,lng:-66.6959,slug:"utuado"},"Vega Alta":{lat:18.4097,lng:-66.3394,slug:"vegaalta"},"Vega Baja":{lat:18.4253,lng:-66.4004,slug:"vegabaja"},"Vieques":{lat:18.1226,lng:-65.4391,slug:"vieques"},"Villalba":{lat:18.1267,lng:-66.4769,slug:"villalba"},"Yabucoa":{lat:18.0709,lng:-65.8992,slug:"yabucoa"},"Yauco":{lat:18.0897,lng:-66.8588,slug:"yauco"}},
  NY: {"Albany":{lat:42.6003,lng:-73.9776,slug:"albany"},"Allegany":{lat:42.2577,lng:-78.0264,slug:"allegany"},"Bronx":{lat:40.8512,lng:-73.8597,slug:"bronx"},"Broome":{lat:42.1608,lng:-75.8184,slug:"broome"},"Cattaraugus":{lat:42.2476,lng:-78.6794,slug:"cattaraugus"},"Cayuga":{lat:42.9141,lng:-76.557,slug:"cayuga"},"Chautauqua":{lat:42.2277,lng:-79.367,slug:"chautauqua"},"Chemung":{lat:42.1415,lng:-76.7585,slug:"chemung"},"Chenango":{lat:42.494,lng:-75.6082,slug:"chenango"},"Clinton":{lat:44.7461,lng:-73.6798,slug:"clinton"},"Columbia":{lat:42.2486,lng:-73.6314,slug:"columbia"},"Cortland":{lat:42.5957,lng:-76.0707,slug:"cortland"},"Delaware":{lat:42.1976,lng:-74.9665,slug:"delaware"},"Dutchess":{lat:41.7635,lng:-73.7433,slug:"dutchess"},"Erie":{lat:42.7644,lng:-78.7316,slug:"erie"},"Essex":{lat:44.1174,lng:-73.7738,slug:"essex"},"Franklin":{lat:44.5936,lng:-74.3035,slug:"franklin"},"Fulton":{lat:43.1138,lng:-74.4169,slug:"fulton"},"Genesee":{lat:42.9992,lng:-78.1959,slug:"genesee"},"Greene":{lat:42.2758,lng:-74.1237,slug:"greene"},"Hamilton":{lat:43.6609,lng:-74.4986,slug:"hamilton"},"Herkimer":{lat:43.4205,lng:-74.9622,slug:"herkimer"},"Jefferson":{lat:44.0497,lng:-75.922,slug:"jefferson"},"Kings":{lat:40.6405,lng:-73.9432,slug:"kings"},"Lewis":{lat:43.7844,lng:-75.449,slug:"lewis"},"Livingston":{lat:42.7247,lng:-77.7796,slug:"livingston"},"Madison":{lat:42.9137,lng:-75.6733,slug:"madison"},"Monroe":{lat:43.1462,lng:-77.6974,slug:"monroe"},"Montgomery":{lat:42.9031,lng:-74.4448,slug:"montgomery"},"Nassau":{lat:40.7377,lng:-73.5851,slug:"nassau"},"New York":{lat:40.783,lng:-73.9632,slug:"newyork"},"Niagara":{lat:43.2011,lng:-78.7446,slug:"niagara"},"Oneida":{lat:43.2436,lng:-75.4374,slug:"oneida"},"Onondaga":{lat:43.0104,lng:-76.1952,slug:"onondaga"},"Ontario":{lat:42.8529,lng:-77.3043,slug:"ontario"},"Orange":{lat:41.4025,lng:-74.3072,slug:"orange"},"Orleans":{lat:43.2522,lng:-78.2313,slug:"orleans"},"Oswego":{lat:43.4299,lng:-76.1453,slug:"oswego"},"Otsego":{lat:42.6357,lng:-75.0306,slug:"otsego"},"Putnam":{lat:41.4245,lng:-73.7566,slug:"putnam"},"Queens":{lat:40.6995,lng:-73.8186,slug:"queens"},"Rensselaer":{lat:42.7086,lng:-73.5117,slug:"rensselaer"},"Richmond":{lat:40.5807,lng:-74.1524,slug:"richmond"},"Rockland":{lat:41.1516,lng:-74.0245,slug:"rockland"},"Saratoga":{lat:43.1049,lng:-73.8649,slug:"saratoga"},"Schenectady":{lat:42.8123,lng:-74.0585,slug:"schenectady"},"Schoharie":{lat:42.5887,lng:-74.4421,slug:"schoharie"},"Schuyler":{lat:42.3944,lng:-76.8803,slug:"schuyler"},"Seneca":{lat:42.7782,lng:-76.8234,slug:"seneca"},"St. Lawrence":{lat:44.4969,lng:-75.0675,slug:"stlawrence"},"Steuben":{lat:42.2685,lng:-77.3815,slug:"steuben"},"Suffolk":{lat:40.8693,lng:-72.8471,slug:"suffolk"},"Sullivan":{lat:41.716,lng:-74.7644,slug:"sullivan"},"Tioga":{lat:42.1687,lng:-76.3073,slug:"tioga"},"Tompkins":{lat:42.4509,lng:-76.4724,slug:"tompkins"},"Ulster":{lat:41.8877,lng:-74.2598,slug:"ulster"},"Warren":{lat:43.5634,lng:-73.8424,slug:"warren"},"Washington":{lat:43.3073,lng:-73.4284,slug:"washington"},"Wayne":{lat:43.1565,lng:-77.0295,slug:"wayne"},"Westchester":{lat:41.1616,lng:-73.7564,slug:"westchester"},"Wyoming":{lat:42.6995,lng:-78.2227,slug:"wyoming"},"Yates":{lat:42.6335,lng:-77.1052,slug:"yates"}},
  MT: {"Beaverhead":{lat:45.1354,lng:-112.9036,slug:"beaverhead"},"Big Horn":{lat:45.4235,lng:-107.4901,slug:"bighorn"},"Blaine":{lat:48.433,lng:-108.9602,slug:"blaine"},"Broadwater":{lat:46.3253,lng:-111.497,slug:"broadwater"},"Carbon":{lat:45.2254,lng:-109.0287,slug:"carbon"},"Carter":{lat:45.5169,lng:-104.5365,slug:"carter"},"Cascade":{lat:47.3099,lng:-111.3462,slug:"cascade"},"Chouteau":{lat:47.8803,lng:-110.4352,slug:"chouteau"},"Custer":{lat:46.2524,lng:-105.5715,slug:"custer"},"Daniels":{lat:48.7838,lng:-105.5505,slug:"daniels"},"Dawson":{lat:47.2663,lng:-104.9007,slug:"dawson"},"Deer Lodge":{lat:46.0616,lng:-113.0677,slug:"deerlodge"},"Fallon":{lat:46.3349,lng:-104.4186,slug:"fallon"},"Fergus":{lat:47.2645,lng:-109.2244,slug:"fergus"},"Flathead":{lat:48.2966,lng:-114.0533,slug:"flathead"},"Gallatin":{lat:45.5435,lng:-111.1709,slug:"gallatin"},"Garfield":{lat:47.2773,lng:-106.9936,slug:"garfield"},"Glacier":{lat:48.705,lng:-112.9942,slug:"glacier"},"Golden Valley":{lat:46.382,lng:-109.1744,slug:"goldenvalley"},"Granite":{lat:46.4047,lng:-113.4412,slug:"granite"},"Hill":{lat:48.6286,lng:-110.1114,slug:"hill"},"Jefferson":{lat:46.1508,lng:-112.0898,slug:"jefferson"},"Judith Basin":{lat:47.0463,lng:-110.2677,slug:"judithbasin"},"Lake":{lat:47.6497,lng:-114.0901,slug:"lake"},"Lewis and Clark":{lat:47.1273,lng:-112.3935,slug:"lewisandclark"},"Liberty":{lat:48.562,lng:-111.0229,slug:"liberty"},"Lincoln":{lat:48.5408,lng:-115.4052,slug:"lincoln"},"Madison":{lat:45.3013,lng:-111.9206,slug:"madison"},"McCone":{lat:47.6486,lng:-105.7924,slug:"mccone"},"Meagher":{lat:46.5984,lng:-110.8898,slug:"meagher"},"Mineral":{lat:47.1433,lng:-114.99,slug:"mineral"},"Missoula":{lat:47.0363,lng:-113.9259,slug:"missoula"},"Musselshell":{lat:46.4972,lng:-108.3938,slug:"musselshell"},"Park":{lat:45.4887,lng:-110.5266,slug:"park"},"Petroleum":{lat:47.1169,lng:-108.2541,slug:"petroleum"},"Phillips":{lat:48.2588,lng:-107.915,slug:"phillips"},"Pondera":{lat:48.2288,lng:-112.2251,slug:"pondera"},"Powder River":{lat:45.3948,lng:-105.6311,slug:"powderriver"},"Powell":{lat:46.8531,lng:-112.9343,slug:"powell"},"Prairie":{lat:46.8614,lng:-105.3813,slug:"prairie"},"Ravalli":{lat:46.0817,lng:-114.119,slug:"ravalli"},"Richland":{lat:47.7852,lng:-104.5582,slug:"richland"},"Roosevelt":{lat:48.2952,lng:-105.0114,slug:"roosevelt"},"Rosebud":{lat:46.23,lng:-106.7303,slug:"rosebud"},"Sanders":{lat:47.6735,lng:-115.1389,slug:"sanders"},"Sheridan":{lat:48.7215,lng:-104.5064,slug:"sheridan"},"Silver Bow":{lat:45.9061,lng:-112.6553,slug:"silverbow"},"Stillwater":{lat:45.6701,lng:-109.394,slug:"stillwater"},"Sweet Grass":{lat:45.8125,lng:-109.9414,slug:"sweetgrass"},"Teton":{lat:47.8387,lng:-112.2397,slug:"teton"},"Toole":{lat:48.6557,lng:-111.6941,slug:"toole"},"Treasure":{lat:46.212,lng:-107.2734,slug:"treasure"},"Valley":{lat:48.3645,lng:-106.67,slug:"valley"},"Wheatland":{lat:46.4677,lng:-109.8444,slug:"wheatland"},"Wibaux":{lat:46.9637,lng:-104.2506,slug:"wibaux"},"Yellowstone":{lat:45.9353,lng:-108.2771,slug:"yellowstone"}},
  MA: {"Barnstable":{lat:41.7236,lng:-70.2913,slug:"barnstable"},"Berkshire":{lat:42.374,lng:-73.2018,slug:"berkshire"},"Bristol":{lat:41.7979,lng:-71.1176,slug:"bristol"},"Dukes":{lat:41.3988,lng:-70.6501,slug:"dukes"},"Essex":{lat:42.6726,lng:-70.956,slug:"essex"},"Franklin":{lat:42.5798,lng:-72.5789,slug:"franklin"},"Hampden":{lat:42.134,lng:-72.6309,slug:"hampden"},"Hampshire":{lat:42.3395,lng:-72.6503,slug:"hampshire"},"Middlesex":{lat:42.4842,lng:-71.3972,slug:"middlesex"},"Nantucket":{lat:41.2842,lng:-70.0734,slug:"nantucket"},"Norfolk":{lat:42.1548,lng:-71.2196,slug:"norfolk"},"Plymouth":{lat:41.9536,lng:-70.8139,slug:"plymouth"},"Suffolk":{lat:42.3329,lng:-71.0775,slug:"suffolk"},"Worcester":{lat:42.3484,lng:-71.9035,slug:"worcester"}},
  VT: {"Addison":{lat:44.0333,lng:-73.1495,slug:"addison"},"Bennington":{lat:43.05,lng:-73.0959,slug:"bennington"},"Caledonia":{lat:44.4677,lng:-72.1047,slug:"caledonia"},"Chittenden":{lat:44.4648,lng:-73.0791,slug:"chittenden"},"Essex":{lat:44.7264,lng:-71.734,slug:"essex"},"Franklin":{lat:44.8568,lng:-72.9098,slug:"franklin"},"Grand Isle":{lat:44.8089,lng:-73.2954,slug:"grandisle"},"Lamoille":{lat:44.6052,lng:-72.6411,slug:"lamoille"},"Orange":{lat:44.0037,lng:-72.3791,slug:"orange"},"Orleans":{lat:44.8298,lng:-72.2459,slug:"orleans"},"Rutland":{lat:43.5739,lng:-73.0379,slug:"rutland"},"Washington":{lat:44.2712,lng:-72.6182,slug:"washington"},"Windham":{lat:42.9792,lng:-72.7196,slug:"windham"},"Windsor":{lat:43.5874,lng:-72.594,slug:"windsor"}},
  CT: {"Fairfield":{lat:41.2677,lng:-73.3744,slug:"fairfield"},"Hartford":{lat:41.8039,lng:-72.7323,slug:"hartford"},"Litchfield":{lat:41.7913,lng:-73.2459,slug:"litchfield"},"Middlesex":{lat:41.4598,lng:-72.5395,slug:"middlesex"},"New Haven":{lat:41.4179,lng:-72.9283,slug:"newhaven"},"New London":{lat:41.4884,lng:-72.1101,slug:"newlondon"},"Tolland":{lat:41.8612,lng:-72.3363,slug:"tolland"},"Windham":{lat:41.8298,lng:-71.9864,slug:"windham"}}
};
try { Object.assign(GIS_COUNTIES, GIS_COUNTIES_MORE); } catch (e) {}

Object.entries(_GIS_RAW).forEach(([st, arr]) => {
  GIS_COUNTIES[st] = {};
  arr.forEach(([name, lat, lng, slug]) => { GIS_COUNTIES[st][name] = { lat, lng, slug }; });
});

// Known public ArcGIS parcel FeatureServer/MapServer query endpoints
const GIS_PARCEL_SERVICES = {
  "FL_Alachua":      "https://maps.acpafl.org/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_Hillsborough": "https://gis.hcpafl.org/arcgis/rest/services/HCPA/Parcels/FeatureServer/0",
  "FL_Orange":       "https://maps.ocpafl.org/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_Pinellas":     "https://maps.pcpao.gov/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_Pasco":        "https://gis.pascocountyfl.net/arcgis/rest/services/PAO/Parcels/MapServer/0",
  "FL_Manatee":      "https://www.mymanatee.org/arcgis/rest/services/PAO/Parcels/FeatureServer/0",
  "FL_Lee":          "https://maps.leepa.org/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_Sarasota":     "https://gis.sc-pa.com/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_Volusia":      "https://vcpa.vcgov.org/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_Brevard":      "https://bcpagis.brevardfl.gov/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_Polk":         "https://gis.polkpa.org/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_Seminole":     "https://www.scpafl.org/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_St. Johns":    "https://www.sjcpa.us/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_Lake":         "https://www.lakecopropappr.com/arcgis/rest/services/Parcels/MapServer/0",
  "FL_Duval":        "https://maps.coj.net/arcgis/rest/services/Property/Parcels/MapServer/0",
  "FL_Palm Beach":   "https://maps.pbcgov.org/arcgis/rest/services/Property/Parcels/MapServer/0",
  "FL_Broward":      "https://gis.bcpa.net/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_Miami-Dade":   "https://gisservices.miamidade.gov/arcgis/rest/services/Property/Parcels/MapServer/0",
  "FL_Collier":      "https://gis.colliercountyfl.gov/arcgis/rest/services/PAO/Parcels/MapServer/0",
  "FL_Charlotte":    "https://www.ccappraiser.com/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_Marion":       "https://www.pa.marion.fl.us/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_Hernando":     "https://gis.hernandocounty.us/arcgis/rest/services/PAO/Parcels/MapServer/0",
  "FL_Citrus":       "https://gis.citruspa.org/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_Flagler":      "https://gis.flaglerpa.org/arcgis/rest/services/Public/Parcels/MapServer/0",
  "FL_St. Lucie":    "https://gis.paslc.gov/arcgis/rest/services/Parcels/MapServer/0",
  "FL_Martin":       "https://gis.pa.martin.fl.us/arcgis/rest/services/Parcels/MapServer/0",
  "TX_Harris":       "https://arcgis.hcad.org/arcgis/rest/services/Parcels/MapServer/0",
  "TX_Dallas":       "https://gis.dallascad.org/arcgis/rest/services/Parcels/MapServer/0",
  "TX_Tarrant":      "https://gis.tad.org/arcgis/rest/services/Parcels/FeatureServer/0",
  "TX_Bexar":        "https://gis.bcad.org/arcgis/rest/services/Parcels/MapServer/0",
  "TX_Travis":       "https://maps.traviscad.org/arcgis/rest/services/Parcels/MapServer/0",
  "TX_Collin":       "https://gis.collincad.org/arcgis/rest/services/Parcels/MapServer/0",
  "TX_Denton":       "https://gis.dentoncad.com/arcgis/rest/services/Parcels/MapServer/0",
  "TX_Fort Bend":    "https://gis.fbcad.org/arcgis/rest/services/Parcels/MapServer/0",
  "TX_Montgomery":   "https://gis.mcad-tx.org/arcgis/rest/services/Parcels/MapServer/0",
  "TX_Williamson":   "https://gis.wcad.org/arcgis/rest/services/Parcels/MapServer/0",
  "TX_Galveston":    "https://gis.galvestoncad.org/arcgis/rest/services/Parcels/MapServer/0",
  "TX_Nueces":       "https://gis.nuecescad.net/arcgis/rest/services/Parcels/MapServer/0",
  "TX_El Paso":      "https://gis.epcad.org/arcgis/rest/services/Parcels/MapServer/0",
  "TX_Brazoria":     "https://gis.brazoriacad.org/arcgis/rest/services/Parcels/MapServer/0",
  "TN_Davidson":     "https://maps.nashville.gov/arcgis/rest/services/Property/Parcels/MapServer/0",
  "TN_Knox":         "https://maps.knoxmpc.org/arcgis/rest/services/Parcels/MapServer/0",
  "TN_Hamilton":     "https://gis.hamiltontn.gov/arcgis/rest/services/Parcels/MapServer/0",
  "TN_Shelby":       "https://maps.shelbycountytn.gov/arcgis/rest/services/Parcels/MapServer/0",
  "TN_Rutherford":   "https://gis.rutherfordcountytn.gov/arcgis/rest/services/Parcels/MapServer/0",
  "TN_Williamson":   "https://gis.williamsoncounty-tn.gov/arcgis/rest/services/Parcels/MapServer/0",
  "TN_Sullivan":     "https://gis.sullivancountytn.gov/arcgis/rest/services/Parcels/MapServer/0",
  "TN_Montgomery":   "https://gis.mcgtn.org/arcgis/rest/services/Parcels/MapServer/0",
  "NC_Wake":         "https://maps.wakegov.com/arcgis/rest/services/Property/Parcels/FeatureServer/0",
  "NC_Mecklenburg":  "https://maps.mecklenburgcountync.gov/arcgis/rest/services/Parcels/FeatureServer/0",
  "NC_Guilford":     "https://gis.guilfordcountync.gov/arcgis/rest/services/Parcels/MapServer/0",
  "NC_Forsyth":      "https://gis.forsyth.cc/arcgis/rest/services/Parcels/MapServer/0",
  "NC_Durham":       "https://gis.durhamnc.gov/arcgis/rest/services/Property/Parcels/MapServer/0",
  "NC_Buncombe":     "https://gis.buncombecounty.org/arcgis/rest/services/Parcels/MapServer/0",
  "NC_Cumberland":   "https://gis.co.cumberland.nc.us/arcgis/rest/services/Parcels/MapServer/0",
  "NC_Cabarrus":     "https://gis.cabarruscounty.us/arcgis/rest/services/Parcels/MapServer/0",
  "NC_Gaston":       "https://gis.gastongov.com/arcgis/rest/services/Parcels/MapServer/0",
  "NC_Iredell":      "https://gis.iredellcountync.gov/arcgis/rest/services/Parcels/MapServer/0",
  "NC_New Hanover":  "https://gis.nhcgov.com/arcgis/rest/services/Parcels/MapServer/0",
};

/* Statewide parcel services — ONE endpoint covers every county in the state.
   FL/TX/TN are ArcGIS-Online-hosted and send CORS headers, so they load directly
   in the browser with no proxy. NC is the state's own server (no CORS) and routes
   through the user's proxy. All four verified live + returning polygon geometry. */
const GIS_STATE_PARCELS = {
  FL: "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0",
  TX: "https://services1.arcgis.com/1mtXwieMId59thmg/arcgis/rest/services/2019_Texas_Parcels_StratMap/FeatureServer/0",
  TN: "https://services1.arcgis.com/YuVBSS7Y1of2Qud1/arcgis/rest/services/Tennessee_Property_Boundaries_Public_Use/FeatureServer/0",
  NC: "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1",
  // Expansion states — all verified live + returning polygons. CORS-direct unless noted.
  OH: "https://services2.arcgis.com/MlJ0G8iWUyC7jAmu/arcgis/rest/services/OhioStatewidePacels_full_view/FeatureServer/0",
  WI: "https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels/FeatureServer/0",
  NM: "https://services2.arcgis.com/yvwHSwAamLDJNzPK/arcgis/rest/services/Final_land_parcel/FeatureServer/0",
  IN: "https://gisdata.in.gov/server/rest/services/Hosted/Parcel_Boundaries_of_Indiana_Current/FeatureServer/0",  // via proxy
  AR: "https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/6",          // via proxy
  MN: "https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/plan_parcels_open/FeatureServer/0", // via proxy, geometry only
  VA: "https://gismaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/FeatureServer/0",          // VGIN statewide parcels (lot lines + parcel id)
  PR: "https://sige.pr.gov/server/rest/services/crim/crim_parcelas/FeatureServer/0",                               // CRIM Catastro Digital (cadastral parcels)
  NY: "https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Tax_Parcels_Public/FeatureServer/0",                 // NYS statewide tax parcels (public counties)
  MT: "https://gisservicemt.gov/arcgis/rest/services/MSDI_Framework/Parcels/MapServer/0",                           // Montana statewide cadastral (DOR)
  MA: "https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/L3_TAXPAR_POLY_ASSESS_gdb/FeatureServer/0", // MassGIS L3 standardized assessor parcels
  VT: "https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_VTPARCELS_WM_NOCACHE_v2/FeatureServer/1", // VCGI statewide standardized parcels (poly)
  CT: "https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/arcgis/rest/services/Connecticut_State_Parcel_Layer_2023/FeatureServer/0", // CT statewide parcel layer 2023 (CAMA)
};

// APN / parcel-id field name on each statewide service (used by APN search; omit = no APN search)
const GIS_STATE_APN_FIELD = { FL: "PARCEL_ID", TX: "GEO_ID", TN: "PARCELID", NC: "PARNO", OH: "LocalParcelID", WI: "PARCELID", IN: "parcel_id", AR: "parcelid", VA: "GPIN", PR: "NUM_CATASTRO", NY: "PRINT_KEY", MT: "PARCELID", MA: "LOC_ID", VT: "SPAN" };

// Bounding-box center [lat, lng] of a GeoJSON feature (for flying to a found parcel)
function featCenter(feat) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (a) => {
    if (typeof a[0] === "number") { minX = Math.min(minX, a[0]); maxX = Math.max(maxX, a[0]); minY = Math.min(minY, a[1]); maxY = Math.max(maxY, a[1]); }
    else a.forEach(walk);
  };
  if (feat && feat.geometry && feat.geometry.coordinates) walk(feat.geometry.coordinates);
  return minX === Infinity ? null : [(minY + maxY) / 2, (minX + maxX) / 2];
}

const sqftToAcres = (v) => { const n = parseFloat(String(v || "").replace(/[^0-9.]/g, "")); return n > 0 ? n / 43560 : 0; };

/* ---- On-the-fly comps engine ----
   Only states whose parcel layer carries sale price + date can do comps. FL's cadastral
   does (SALE_PRC1/SALE_YR1) for all 10.8M parcels; other states need a sales feed. */
const COMP_CONFIG = {
  FL: { service: GIS_STATE_PARCELS.FL, saleP: "SALE_PRC1", saleY: "SALE_YR1", saleM: "SALE_MO1",
        sqft: "LND_SQFOOT", addr: "PHY_ADDR1", use: "DOR_UC",
        vacant: ["000","00","010","10","040","40","070","70","099","99"] },
};

// Comps split into UNIMPROVED (vacant land = offer basis) and IMPROVED (reference).
// 3 each, matched on acreage, closest + most recent, ≤~1.3mi (prefer ≤1mi). One fast
// bbox query (no server-side WHERE — slow on 10.8M parcels), everything filtered client-side.
async function fetchComps(lat, lng, subjectAcres, state, proxy) {
  const cfg = COMP_CONFIG[state];
  if (!cfg) return { unsupported: true };
  const yr = new Date().getFullYear();
  const mi = 0.8, dlat = mi / 69, dlng = mi / (69 * Math.cos(lat * Math.PI / 180));
  const params = new URLSearchParams({
    geometry: `${lng - dlng},${lat - dlat},${lng + dlng},${lat + dlat}`,
    geometryType: "esriGeometryEnvelope", spatialRel: "esriSpatialRelIntersects", inSR: "4326", outSR: "4326",
    outFields: [cfg.addr, cfg.saleP, cfg.saleY, cfg.saleM, cfg.sqft, cfg.use].join(","),
    returnCentroid: "true", returnGeometry: "false", resultRecordCount: "1500", f: "json",
  });
  let feats;
  try { const r = await corsFetch(`${cfg.service}/query?${params}`, { timeout: 22000, proxy }); const j = await r.json(); feats = j.features || []; }
  catch (_) { return { timeout: true }; }
  const A = subjectAcres > 0 ? subjectAcres : 0;
  const sold = feats.map((ft) => {
    const c = ft.centroid, p = ft.attributes || {};
    if (!c) return null;
    const acres = sqftToAcres(p[cfg.sqft]), price = parseFloat(p[cfg.saleP]) || 0, y = parseFloat(p[cfg.saleY]) || 0;
    if (!(acres > 0 && price > 2000 && y >= yr - 5)) return null;
    return { addr: String(p[cfg.addr] || "").trim(), m: p[cfg.saleM], y, price, acres, ppa: Math.round(price / acres),
      dist: Math.hypot((c.y - lat) * 69, (c.x - lng) * 69 * Math.cos(lat * Math.PI / 180)),
      vacant: cfg.vacant.includes(String(p[cfg.use] || "").trim()) };
  }).filter(Boolean);
  // rank: prefer within 1mi, then most recent, then closest
  const rank = (arr) => arr.slice().sort((a, b) => (a.dist <= 1 ? 0 : 1) - (b.dist <= 1 ? 0 : 1) || b.y - a.y || a.dist - b.dist);
  const pick3 = (pool) => {
    const band = A > 0 ? pool.filter((c) => c.acres >= A * 0.5 && c.acres <= A * 2) : pool;
    let chosen = rank(band).slice(0, 3);
    if (chosen.length < 3) chosen = chosen.concat(rank(pool.filter((c) => !chosen.includes(c))).slice(0, 3 - chosen.length));
    const ppas = chosen.filter((c) => c.ppa > 0).map((c) => c.ppa);
    const avg = ppas.length ? Math.round(ppas.reduce((a, b) => a + b, 0) / ppas.length) : 0;
    return { comps: chosen, avg, est: A > 0 ? Math.round(avg * A) : 0 };
  };
  const unimproved = pick3(sold.filter((c) => c.vacant));
  const improved = pick3(sold.filter((c) => !c.vacant));
  const dists = [...unimproved.comps, ...improved.comps].map((c) => c.dist);
  return { improved, unimproved, subjectAcres: A,
    radius: dists.length ? Math.min(2, Math.max(1, Math.ceil(Math.max(...dists) * 10) / 10)) : 1 };
}

// Side-by-side comp columns — unimproved (offer basis) vs improved (reference). pal = palette.
function CompsColumns({ res, pal }) {
  const col = (label, sub, data, hot) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: hot ? pal.accent : pal.dim, marginBottom: 5 }}>{label}</div>
      <div style={{ background: hot ? pal.hot : pal.panel, border: `1px solid ${hot ? pal.accent : pal.line}`, borderRadius: 8, padding: "7px 9px", marginBottom: 6 }}>
        <div style={{ fontSize: 8.5, color: pal.dim, textTransform: "uppercase", letterSpacing: ".04em" }}>{sub}</div>
        <div style={{ fontSize: 17, fontWeight: 800, color: hot ? pal.accent : pal.text, lineHeight: 1.1 }}>{data.est ? "$" + data.est.toLocaleString() : "—"}</div>
        <div className="lc-mono" style={{ fontSize: 9.5, color: pal.dim }}>avg ${data.avg.toLocaleString()}/ac</div>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {data.comps.length ? data.comps.map((c, i) => (
          <div key={i} style={{ lineHeight: 1.25 }}>
            <div style={{ fontSize: 10.5, color: pal.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.addr || "Vacant parcel"}</div>
            <div className="lc-mono" style={{ fontSize: 9, color: pal.dim }}>{c.m}/{c.y} · {c.acres.toFixed(2)}ac · {c.dist.toFixed(1)}mi · ${Math.round(c.price / 1000)}k</div>
          </div>
        )) : <div style={{ fontSize: 10.5, color: pal.dim }}>None found nearby</div>}
      </div>
    </div>
  );
  return (
    <div>
      <div style={{ display: "flex", gap: 10 }}>
        {col("Unimproved · Land", "Your offer basis", res.unimproved, true)}
        {col("Improved · Reference", "If a home were built", res.improved, false)}
      </div>
      <div style={{ fontSize: 8.5, color: pal.dim, marginTop: 7, lineHeight: 1.45 }}>3 closest recent sales ≤{res.radius}mi, matched on acreage. Unimproved = land offer; improved = value if built — use if they push back on price.</div>
    </div>
  );
}

// Government URL generators per state
function getCountyUrls(state, name, slug) {
  const s = slug || name.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const g = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  // Sold-land comp source — supplements the on-the-fly comps engine (and stands in where a
  // state's parcel layer has no sale data, e.g. VA/PR).
  const comps = g(`recent vacant land sales sold ${name} ${state === "PR" ? "Puerto Rico" : state}`);
  let urls;
  if (state === "FL") urls = {
    assessor: `https://www.${s}pa.gov`,
    taxCollector: `https://www.${s}tc.com`,
    auction: `https://${s}.realtaxdeed.com`,
    gis: `https://gis.${s}county.gov`,
  };
  else if (state === "TX") urls = {
    assessor: `https://www.${s}cad.org`,
    taxCollector: `https://www.${s}county.gov/tax-assessor`,
    auction: `https://www.${s}county.gov/tax-sales`,
    gis: `https://gis.${s}county.gov`,
  };
  else if (state === "TN") urls = {
    assessor: `https://assessoroftennessee.com/property-search?county=${encodeURIComponent(name)}`,
    taxCollector: `https://tntrustee.com/${s}`,
    auction: `https://www.tntaxauctions.com/?county=${encodeURIComponent(name)}`,
    gis: `https://gis.${s}county.gov`,
  };
  else if (state === "NC") urls = {
    assessor: `https://www.${s}countync.gov/departments/tax`,
    taxCollector: `https://www.${s}countync.gov/departments/tax/tax-bill-search`,
    auction: `https://www.${s}countync.gov/departments/tax/delinquent-tax-liens`,
    gis: `https://www.${s}countync.gov/departments/gis`,
  };
  else if (state === "VA") urls = {
    // Virginia assesses real estate per locality (county/independent city); no statewide portal.
    assessor: g(`${name} Virginia real estate assessment property record search`),
    taxCollector: g(`${name} Virginia treasurer real estate tax bill`),
    auction: g(`${name} Virginia delinquent real estate tax sale auction`),
    gis: g(`${name} Virginia GIS parcel viewer map`),
  };
  else if (state === "PR") urls = {
    // Puerto Rico: CRIM (Centro de Recaudación de Ingresos Municipales) runs the digital cadastre + property tax.
    assessor: "https://catastro.crimpr.net/cdprpc/",
    taxCollector: g(`CRIM Puerto Rico contribución sobre la propiedad ${name}`),
    auction: g(`Puerto Rico subasta propiedad CRIM contribución morosa ${name}`),
    gis: "https://catastro.crimpr.net/cdprpc/",
  };
  else urls = {
    assessor: g(`${name} County ${state} property appraiser parcel search`),
    taxCollector: g(`${name} County ${state} tax collector delinquent property tax`),
    auction: g(`${name} County ${state} tax deed sale auction list`),
    gis: g(`${name} County ${state} GIS parcel viewer map`),
  };
  urls.comps = comps;
  return urls;
}

// Singleton Leaflet loader
let _leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (_leafletLoading) return _leafletLoading;
  _leafletLoading = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    js.onload = () => {
      const rot = document.createElement("script");
      rot.src = "https://unpkg.com/leaflet-rotate@0.2.8/dist/leaflet-rotate-src.js";
      rot.onload = () => resolve(window.L);
      rot.onerror = () => resolve(window.L);
      document.head.appendChild(rot);
    };
    js.onerror = reject;
    document.head.appendChild(js);
  });
  return _leafletLoading;
}

// County GIS servers usually don't send CORS headers, so browser fetches are blocked.
// corsFetch tries the request directly first (works natively / on CORS-enabled hosts),
// then falls back through public CORS relays. Nominatim allows CORS so it skips this.
// Wrap a target URL for a user-supplied proxy. Supports a {url} placeholder, else appends ?url=.
function applyProxy(proxy, u) {
  return /\{url\}/.test(proxy)
    ? proxy.replace(/\{url\}/g, encodeURIComponent(u))
    : proxy + (proxy.includes("?") ? "&" : "?") + "url=" + encodeURIComponent(u);
}
function corsFetch(url, { signal, timeout = 9000, proxy = "" } = {}) {
  const routes = [(u) => u];                              // direct first — CORS-enabled statewide services (FL/TX/TN, Esri-cloud MA/VT/CT) succeed instantly
  if (proxy) routes.push((u) => applyProxy(proxy, u));    // user's proxy — most reliable for non-CORS state servers (NY/MT/VA/PR + county fallbacks)
  routes.push((u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`);   // public relay (no key, fairly stable)
  routes.push((u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`);
  routes.push((u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`);
  return (async () => {
    let lastErr;
    for (const wrap of routes) {
      if (signal && signal.aborted) throw new Error("aborted");
      try {
        const res = await fetch(wrap(url), { signal: signal || AbortSignal.timeout(timeout) });
        if (res.ok) return res;
        lastErr = new Error("HTTP " + res.status);
      } catch (e) {
        lastErr = e;
        if (signal && signal.aborted) throw e;   // caller cancelled (stale request)
      }
    }
    throw lastErr || new Error("all CORS routes failed");
  })();
}

// Convert Esri JSON polygon/point features -> GeoJSON. Many state ArcGIS MapServers
// (e.g. MT, and older installs) don't support f=geojson and silently return nothing,
// so we fall back to f=json (universally supported) and convert here. Each ring is drawn
// as its own polygon outline — exact hole nesting doesn't matter for lot lines.
function esriToGeoJSON(esriFeatures) {
  return (esriFeatures || []).map((f) => {
    const g = f.geometry || {};
    let geometry = null;
    if (Array.isArray(g.rings) && g.rings.length) {
      geometry = g.rings.length === 1
        ? { type: "Polygon", coordinates: g.rings }
        : { type: "MultiPolygon", coordinates: g.rings.map((r) => [r]) };
    } else if (typeof g.x === "number") {
      geometry = { type: "Point", coordinates: [g.x, g.y] };
    }
    return geometry ? { type: "Feature", properties: f.attributes || {}, geometry } : null;
  }).filter(Boolean);
}

// Run an ArcGIS /query, preferring clean GeoJSON but falling back to Esri JSON + convert.
// Returns an array of GeoJSON features (possibly empty).
async function arcgisQuery(serviceUrl, params, { signal, timeout = 9000, proxy = "" } = {}) {
  const run = async (fmt) => {
    const qs = new URLSearchParams({ ...params, f: fmt });
    const res = await corsFetch(`${serviceUrl}/query?${qs}`, { signal, timeout, proxy });
    return res.json();
  };
  // GeoJSON first. If the service returns a features array (even an empty one), it speaks
  // GeoJSON — return immediately. Only retry as Esri JSON when GeoJSON is unsupported
  // (error object or thrown). This avoids a wasteful second query on every empty viewport.
  try {
    const j = await run("geojson");
    if (j && Array.isArray(j.features)) return j.features;
  } catch (e) { if (signal && signal.aborted) throw e; }
  try {
    const j = await run("json");
    return esriToGeoJSON(j && j.features);
  } catch (_) { return []; }
}

// Query ArcGIS parcel at a point
async function queryArcGISParcel(serviceUrl, lat, lng, proxy = "") {
  const feats = await arcgisQuery(serviceUrl, {
    geometry: `${lng},${lat}`, geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects", outFields: "*",
    returnGeometry: "true", inSR: "4326", outSR: "4326",
  }, { timeout: 9000, proxy });
  return feats[0] || null;
}

// Nominatim reverse geocode (zoom 18 ≈ house-number level for full street address)
async function reverseGeocode(lat, lng, zoom = 18) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&zoom=${zoom}&addressdetails=1&format=json`,
      { headers: { "Accept-Language": "en" }, signal: AbortSignal.timeout(6000) }
    );
    return await res.json();
  } catch (_) { return null; }
}

// Build a full street address string from a Nominatim reverse-geocode result
function buildAddress(geo) {
  const a = (geo && geo.address) || {};
  const line1 = [a.house_number, a.road].filter(Boolean).join(" ");
  const cityish = a.city || a.town || a.village || a.hamlet || a.municipality || a.county;
  const region = [a.state, a.postcode].filter(Boolean).join(" ");
  const full = [line1, cityish, region].filter(Boolean).join(", ");
  return full || (geo && geo.display_name) || "";
}

// Nearest known county centroid within a state — picks which parcel service to query as you pan
function nearestCounty(st, lat, lng) {
  const arr = GIS_COUNTIES[st];
  if (!arr) return null;
  let best = null, bd = Infinity;
  for (const name in arr) {
    const d = arr[name];
    const dist = (d.lat - lat) ** 2 + (d.lng - lng) ** 2;
    if (dist < bd) { bd = dist; best = { name, lat: d.lat, lng: d.lng, slug: d.slug }; }
  }
  return best;
}

// Query every parcel intersecting the current map bounds (for showing all lot outlines).
// maxAllowableOffset generalizes geometry server-side (~3m) so payloads are small and the
// canvas renders fast; we only need outlines, not survey-grade vertices. outFields is trimmed
// to the few the lot click/card actually reads — full attributes are fetched on single-parcel click.
async function queryArcGISParcelsInBounds(serviceUrl, bounds, signal, proxy = "") {
  return arcgisQuery(serviceUrl, {
    geometry: `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`,
    geometryType: "esriGeometryEnvelope", spatialRel: "esriSpatialRelIntersects",
    outFields: "*", returnGeometry: "true", inSR: "4326", outSR: "4326",
    resultRecordCount: "1000", maxAllowableOffset: "0.00003", geometryPrecision: "6",
  }, { signal, timeout: 14000, proxy });
}

const STATE_ABBR = { "Florida": "FL", "Texas": "TX", "Tennessee": "TN", "North Carolina": "NC", "Virginia": "VA", "Puerto Rico": "PR", "New York": "NY", "Montana": "MT", "Massachusetts": "MA", "Vermont": "VT", "Connecticut": "CT" };

const getAutoTheme = () => { const h = new Date().getHours(); return (h >= 20 || h < 7) ? "dark" : "light"; };

const GT = {
  dark: {
    bg: "#080F0A", card: "rgba(6,15,9,0.97)", glass: "rgba(12,24,16,0.88)",
    border: "rgba(0,220,100,0.18)", accent: "#00E87A", accentSoft: "#00B85E",
    text: "#E0F0E7", textDim: "#6B9A7A", badge: "#FF6B35", badgeBg: "rgba(255,107,53,0.15)",
    input: "rgba(255,255,255,0.06)", inputBorder: "rgba(255,255,255,0.12)",
    ctrl: "rgba(8,16,11,0.82)", ctrlBorder: "rgba(0,220,100,0.25)", ctrlText: "#E0F0E7",
  },
  light: {
    bg: "#EEF2ED", card: "rgba(255,255,255,0.98)", glass: "rgba(240,245,240,0.92)",
    border: "rgba(30,120,70,0.18)", accent: "#1A7A46", accentSoft: "#2EAD65",
    text: "#0C1E13", textDim: "#4A7A5A", badge: "#D4380D", badgeBg: "rgba(212,56,13,0.1)",
    input: "rgba(0,0,0,0.04)", inputBorder: "rgba(0,0,0,0.14)",
    ctrl: "rgba(255,255,255,0.88)", ctrlBorder: "rgba(30,120,70,0.2)", ctrlText: "#0C1E13",
  },
};

// Normalize county name from Nominatim
function normCounty(raw) { return (raw || "").replace(/ County$/i, "").replace(/ Parish$/i, "").trim(); }

// Extract parcel fields from ArcGIS response (field names vary widely by county)
function extractParcelFields(props) {
  if (!props) return {};
  const pick = (...keys) => {
    for (const k of keys) {
      for (const variant of [k, k.toUpperCase(), k.toLowerCase()]) {
        const v = props[variant];
        if (v !== undefined && v !== null && String(v).trim() !== "" && String(v) !== "0") return String(v).trim();
      }
    }
    return "";
  };
  return {
    apn:         pick("PARCEL_ID","APN","PIN","PARCELID","FOLIO","ACCOUNT_NUM","ACCT","GPIN","REID","PIN_NUM","PARCEL","ACCOUNT","PROP_ID","GEO_ID","PARCELNO","PARNO","PARID","PARCELNUMB","NUM_CATASTRO","CATASTRO","CATASTRO_N","PRINT_KEY","SPAN","LOC_ID","MAP_PAR_ID","SBL","PROPERTYID"),
    owner:       pick("OWNER","OWNER_NAME","OWNERNAME","OWN_NAME","OWNER1","OWNER_FULL","TAXPAYER","NAME","OWNER_FIRST_NAME","OWNNAME1","OWN1","OWNER_2","PRIMARY_OWNER","OWNERNME1"),
    address:     pick("SITE_ADDR","SITUS","PROP_ADDR","PROPERTY_ADDRESS","SITE_ADDRESS","LOCATION","ADDRESS","PHY_ADDR","SITUS_ADDR","PROP_LOCATION","PHY_ADDR1","SITEADDRESS","PAR_ADDR","SITE_ADD","PROPADDR"),
    mailingAddr: pick("MAIL_ADDR","MAILING_ADDRESS","MAIL_ADDRESS","OWNER_ADDR","OWN_ADDR","MAIL_STREET","OWN_ADDR1","OWNER_ADDRESS","MAILADDR"),
    city:        pick("MAIL_CITY","OWNER_CITY","CITY","CITY_NAME","MAIL_CTY","OWN_CITY","PHY_CITY"),
    state:       pick("MAIL_STATE","OWNER_STATE","STATE","ST","MAIL_ST","OWN_STATE"),
    zip:         pick("MAIL_ZIP","OWNER_ZIP","ZIP","ZIPCODE","ZIP_CODE","MAIL_ZIP5","OWN_ZIPCD","PHY_ZIPCD"),
    acres:       pick("CALC_ACREAGE","ACREAGE","ACRES","LAND_ACRES","GISACRES","LANDAREA","LGL_ACRES","CALC_ACRE","GIS_ACRES","ACREAGE_CA","DEED_ACRES","LEGAL_AREA","DEEDAC","GIS_ACRE","CALC_ACRES","TOTALACRES","GISACRE","ACRES_CALC","SHAPEAREA")
                 || (pick("LND_SQFOOT","LAND_SQFT","SQFT_LAND","LANDSQFT","LOT_SIZE","LOTSIZE","SQUARE_FOOTAGE") ? sqftToAcres(pick("LND_SQFOOT","LAND_SQFT","SQFT_LAND","LANDSQFT","LOT_SIZE","LOTSIZE","SQUARE_FOOTAGE")).toFixed(3) : ""),
    zoning:      pick("ZONING","ZONE_CODE","ZONING_CODE","LND_USE_CODE","USE_CODE","DOR_UC","LUSE_DESC","PROP_USE"),
    landValue:   pick("LAND_VALUE","LND_VAL","ASSESSED_VALUE","JV","LAND_ASSESS","LAND_APPRAISED"),
    totalValue:  pick("TOTAL_VALUE","JUST_VALUE","JV","MARKET_VALUE","ASSESSED_VALUE","TOTAL_ASSESS","APPRAISED","TOT_APPR_VAL","MKT_VAL","PARVAL","TOTAL_VAL","JUST_VAL","TOTALVALUE"),
    taxYear:     pick("TAX_YEAR","YEAR","ASSESSMENT_YEAR"),
    taxOwed:     pick("TAX_AMOUNT","TAXES_DUE","TAX_DUE","DELINQUENT","TAXES_OWED","TAX_OWED","DELQ_AMT","DELINQ_AMT"),
    delinquent:  pick("DELINQUENT","TAX_DELINQUENT","DELINQ","IS_DELINQUENT","TAX_STATUS"),
    saleDate:    pick("SALE_DATE","LAST_SALE_DATE","DEED_DATE","DATE_OF_SALE","SALES_DATE","SALE_YR1","SALE_YR2"),
    salePrice:   pick("SALE_PRICE","LAST_SALE","DEED_PRICE","SALES_PRICE","PRICE","SALE_AMT","SALE_PRC1","SALE_PRC2"),
    legal:       pick("LEGAL_DESC","LEGAL","LEGAL_DESCRIPTION","LEGAL1","PROP_LEGAL","S_LEGAL"),
    sqft:        pick("BLDG_SQFT","BLDG_SF","LIVING_AREA","HEATED_AREA","TOT_LVG_AREA","SQ_FT"),
    yearBuilt:   pick("YEAR_BUILT","YR_BUILT","YEAR_BLT","EFFYR"),
  };
}

function fmt$(v) {
  const n = parseFloat(String(v || "").replace(/[^0-9.]/g, ""));
  return (!isNaN(n) && n > 0) ? "$" + Math.round(n).toLocaleString() : null;
}

/* ---- Lead CSV/TSV serialization (shared by GIS basket + Pipeline import/export) ---- */
const LEAD_CSV_HEADERS = ["OwnerName","Phone","MailingAddress","PropertyAddress","APN","County","Zip","Acres","TargetPrice","MyOffer","Status","BuyBox","Source","LastText","LastCall","LastMailer","Created","Notes"];
function leadToRow(l) {
  return [l.owner,l.phone,l.mailing,l.address,l.apn,l.county,l.zip,l.acres,l.price,l.offer,l.status,l.buybox,l.source,l.texted,l.called,l.mailed,l.created,l.notes];
}
function leadsToCSV(leads) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [LEAD_CSV_HEADERS.join(","), ...leads.map(l => leadToRow(l).map(esc).join(","))].join("\r\n");
}
// One tab-separated row (optionally with header) — pastes straight into Excel/Sheets columns
function leadToTSV(l, withHeader) {
  const clean = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").trim();
  const row = leadToRow(l).map(clean).join("\t");
  return withHeader ? LEAD_CSV_HEADERS.join("\t") + "\r\n" + row : row;
}

/* ---- GIS parcel → Land Command lead ---- */
// Deterministic id so the same parcel de-dupes in the saved-list basket
function parcelLeadId(parcel) {
  const apn = (parcel.fields && parcel.fields.apn) || "";
  return "gis_" + (apn ? apn.replace(/\s+/g, "") : `${(parcel.lat || 0).toFixed(6)}_${(parcel.lng || 0).toFixed(6)}`);
}
function parcelToLead(parcel) {
  const f = parcel.fields || {};
  const priceNum = f.totalValue ? String(Math.round(parseFloat(String(f.totalValue).replace(/[^0-9.]/g, "")) || 0)) : "";
  const delinq = !!(f.delinquent && !["0","false","no","n","","current"].includes(String(f.delinquent).toLowerCase())) ||
    !!(f.taxOwed && parseFloat(String(f.taxOwed).replace(/[^0-9.]/g, "")) > 0);
  return {
    ...emptyLead(),
    id: parcelLeadId(parcel),
    lat: parcel.lat, lng: parcel.lng, pstate: parcel.state || "",
    owner: f.owner || "",
    apn: f.apn || "",
    county: parcel.county || "",
    zip: parcel.zip || "",
    acres: f.acres ? parseFloat(f.acres).toFixed(4) : "",
    price: priceNum,
    address: f.address || parcel.fullAddress || "",
    mailing: [f.mailingAddr, f.city, f.state, f.zip].filter(Boolean).join(", "),
    source: "GIS Map",
    notes: [
      f.apn && `APN ${f.apn}`,
      f.zoning && `Zoning: ${f.zoning}`,
      f.totalValue && fmt$(f.totalValue) && `Assessed ${fmt$(f.totalValue)}`,
      f.saleDate && `Last sale ${f.saleDate}${fmt$(f.salePrice) ? " " + fmt$(f.salePrice) : ""}`,
      delinq && "⚠ TAX DELINQUENT",
      (parcel.lat != null && parcel.lng != null) && `${parcel.lat.toFixed(6)}, ${parcel.lng.toFixed(6)}`,
    ].filter(Boolean).join(" · "),
  };
}

/* ---- ParcelCard — iOS-style slide-up panel ---- */
function ParcelCard({ parcel, onClose, onAddToPipeline, onToggleSave, onStartDeal, isSaved, theme }) {
  const T = GT[theme];
  const [copied, setCopied] = useState(false);
  const [copiedExcel, setCopiedExcel] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const f = parcel.fields || {};
  const urls = parcel.urls || {};
  const isDelinquent = !!(f.delinquent && !["0","false","no","n","","current"].includes(String(f.delinquent).toLowerCase())) ||
    !!(f.taxOwed && parseFloat(String(f.taxOwed).replace(/[^0-9.]/g, "")) > 0);

  const fieldRow = (label, val, mono) => val ? (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0", borderBottom: `1px solid ${T.border}` }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: T.textDim, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 12.5, color: T.text, textAlign: "right", fontFamily: mono ? "'JetBrains Mono',monospace" : "inherit" }}>{val}</span>
    </div>
  ) : null;

  const copyInfo = async () => {
    const lines = [
      f.apn && `APN: ${f.apn}`, f.owner && `Owner: ${f.owner}`,
      (f.address || parcel.fullAddress) && `Address: ${f.address || parcel.fullAddress}`, f.acres && `Acres: ${f.acres}`,
      f.zoning && `Zoning: ${f.zoning}`, f.totalValue && `Value: ${fmt$(f.totalValue)}`,
      isDelinquent && "STATUS: TAX DELINQUENT",
    ].filter(Boolean).join("\n");
    await copyText(lines);
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  };

  const copyExcel = async () => {
    await copyText(leadToTSV(parcelToLead(parcel), false));
    setCopiedExcel(true); setTimeout(() => setCopiedExcel(false), 1800);
  };

  const comps = parcel.comps;
  const acresNum = parseFloat(f.acres) || 0;
  const tile = (label, value, sub) => (
    <div style={{ flex: 1, minWidth: 0, background: T.input, border: `1px solid ${T.border}`, borderRadius: 12, padding: "8px 10px" }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: T.textDim }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800, color: T.text, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
      {sub ? <div style={{ fontSize: 9.5, color: T.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div> : null}
    </div>
  );

  return (
    <div style={{
      position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 1000,
      background: T.card, borderTop: `1px solid ${T.border}`, borderRadius: "20px 20px 0 0",
      boxShadow: "0 -10px 48px rgba(0,0,0,0.45)", maxHeight: minimized ? 150 : "56vh", overflowY: minimized ? "hidden" : "auto",
      fontFamily: "'Inter',system-ui,-apple-system,sans-serif", WebkitOverflowScrolling: "touch", transition: "max-height .2s ease",
    }}>
      <div style={{ padding: "12px 16px 22px" }}>
        {/* Header — explicit exit + minimize buttons (no slide-to-dismiss) */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: T.text, fontFamily: "'Saira Condensed',sans-serif", textTransform: "uppercase", letterSpacing: ".03em", lineHeight: 1.15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {f.owner || "Property Parcel"}
            </div>
            <div style={{ fontSize: 12, color: T.text, marginTop: 2, lineHeight: 1.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.address || parcel.fullAddress || `${parcel.lat?.toFixed(5)}, ${parcel.lng?.toFixed(5)}`}</div>
            <div className="lc-mono" style={{ fontSize: 10.5, color: T.accent, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {parcel.county ? `${parcel.county} County, ${parcel.state}` : parcel.state || ""}{f.apn ? ` · APN ${f.apn}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button onClick={() => setMinimized(m => !m)} title={minimized ? "Expand" : "Minimize"} style={{ border: "none", background: T.input, borderRadius: "50%", width: 30, height: 30, cursor: "pointer", color: T.textDim, fontSize: 13 }}>{minimized ? "▲" : "▽"}</button>
            <button onClick={onClose} title="Close" style={{ border: "none", background: T.input, borderRadius: "50%", width: 30, height: 30, cursor: "pointer", color: T.textDim, fontSize: 17 }}>×</button>
          </div>
        </div>

        {/* Work this lead → launch the guided acquisition funnel */}
        <button onClick={() => onStartDeal && onStartDeal(parcel)} style={{ width: "100%", padding: "12px 0", borderRadius: 13, border: "none", background: T.accent, color: "#fff", fontSize: 13.5, fontWeight: 800, letterSpacing: ".02em", cursor: "pointer", marginBottom: 12 }}>
          ▶ Work This Lead — Start the Funnel
        </button>

        {/* Delinquency (only if the parcel data flags it) */}
        {isDelinquent && (
          <div style={{ background: T.badgeBg, border: `1px solid ${T.badge}`, borderRadius: 10, padding: "7px 12px", marginBottom: 10, fontSize: 12, fontWeight: 800, color: T.badge, textTransform: "uppercase", letterSpacing: ".04em" }}>
            ⚠ Tax Delinquent{f.taxOwed && fmt$(f.taxOwed) ? ` · ${fmt$(f.taxOwed)} owed` : ""}
          </div>
        )}

        {/* Key stats */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {tile("Lot Size", acresNum ? acresNum.toFixed(3) + " ac" : "—", acresNum ? Math.round(acresNum * 43560).toLocaleString() + " sf" : "")}
          {tile("Assessed", fmt$(f.totalValue) || "—", fmt$(f.landValue) ? `land ${fmt$(f.landValue)}` : "")}
          {tile("Last Sale", fmt$(f.salePrice) || "—", f.saleDate ? String(f.saleDate) : "")}
        </div>

        {/* COMPS — underwriting engine */}
        <div style={{ background: T.input, border: `1px solid ${T.border}`, borderRadius: 14, padding: "11px 13px", marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: T.text, fontFamily: "'Saira Condensed',sans-serif", textTransform: "uppercase", letterSpacing: ".05em" }}>📊 Sold Comps</span>
            {comps && comps.unimproved ? <span style={{ fontSize: 9.5, color: T.textDim }}>≤{comps.radius}mi · acreage-matched</span> : null}
          </div>
          {!comps ? (
            <div style={{ fontSize: 12, color: T.textDim, padding: "4px 0", animation: "gpulse 1.2s infinite" }}>◌ Pulling recent sales nearby…</div>
          ) : comps.unsupported ? (
            <div style={{ fontSize: 11.5, color: T.textDim, lineHeight: 1.5 }}>
              Auto-comps run on parcels whose data carries sale price + date (Florida today). This state's layer is boundary-only, so pull recent land sales manually:
              {urls && urls.comps ? <a href={urls.comps} target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: 6, color: T.accent, fontWeight: 700, textDecoration: "none" }}>↗ Recent sold land comps nearby</a> : null}
            </div>
          ) : comps.timeout ? (
            <div style={{ fontSize: 11.5, color: T.textDim, lineHeight: 1.5 }}>The Florida parcel service was slow — comps didn't load. Re-tap the lot to retry.</div>
          ) : (
            <CompsColumns res={comps} pal={{ accent: T.accent, dim: T.textDim, text: T.text, line: T.border, panel: T.card, hot: T.glass }} />
          )}
        </div>

        {/* Tax · Delinquency · Auctions */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 12 }}>
          {[["⚖ Taxes & Delinquency", urls.taxCollector], ["🔨 Tax-Deed Auctions", urls.auction], ["Property Appraiser", urls.assessor], ["County GIS", urls.gis]].map(([label, href]) =>
            href && href !== "#" ? (
              <a key={label} href={href} target="_blank" rel="noreferrer" style={{ padding: "8px 10px", borderRadius: 10, background: T.input, border: `1px solid ${T.border}`, color: T.accent, fontSize: 11, fontWeight: 600, textDecoration: "none", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>↗ {label}</a>
            ) : null)}
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button onClick={onToggleSave} style={{ flex: 1, padding: "11px 0", borderRadius: 13, border: `1px solid ${isSaved ? T.accentSoft : T.border}`, background: isSaved ? T.accentSoft : T.input, color: isSaved ? "#fff" : T.text, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>{isSaved ? "★ Saved" : "☆ Save to List"}</button>
          <button onClick={onAddToPipeline} style={{ flex: 1.4, padding: "11px 0", borderRadius: 13, border: "none", background: T.accent, color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>+ Add to Pipeline</button>
        </div>

        {/* Collapsible details */}
        <button onClick={() => setShowDetails((s) => !s)} style={{ width: "100%", padding: "8px 0", borderRadius: 10, border: `1px solid ${T.border}`, background: "transparent", color: T.textDim, fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>
          {showDetails ? "▾ Hide details" : "▸ More details, mailing & copy"}
        </button>
        {showDetails && (
          <div style={{ marginTop: 10 }}>
            <div style={{ marginBottom: 10 }}>
              {fieldRow("Zoning / Use", f.zoning)}
              {fieldRow("Year Built", f.yearBuilt)}
              {fieldRow("Owner Mailing", [f.mailingAddr, f.city, f.state, f.zip].filter(Boolean).join(", ") || null)}
              {fieldRow("Legal", f.legal)}
              {fieldRow("Coordinates", `${parcel.lat?.toFixed(6)}, ${parcel.lng?.toFixed(6)}`, true)}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={copyExcel} style={{ flex: 1, padding: "10px 0", borderRadius: 12, border: `1px solid ${T.border}`, background: T.input, color: T.text, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{copiedExcel ? "Copied ✓" : "⊞ Copy for Excel"}</button>
              <button onClick={copyInfo} style={{ flex: 1, padding: "10px 0", borderRadius: 12, border: `1px solid ${T.border}`, background: T.input, color: T.text, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{copied ? "Copied ✓" : "Copy Details"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- GISTab ---- */
function GISTab({ data, update, onStartDeal }) {
  const mapRef = React.useRef(null);
  const mapObjRef = React.useRef(null);
  const parcelLayerRef = React.useRef(null);   // all lot outlines in view
  const highlightRef = React.useRef(null);     // the selected (illuminated) lot
  const pinRef = React.useRef(null);
  const viewAbortRef = React.useRef(null);     // aborts stale viewport parcel fetches
  const moveTimerRef = React.useRef(null);     // debounce for moveend
  const loaderRef = React.useRef(null);        // exposes the in-effect viewport loader
  const selectAtRef = React.useRef(null);      // exposes the in-effect parcel selector (for search)
  const ctrlRef = React.useRef({});            // fresh state for map event handlers
  const ctlEls = React.useRef([]);             // overlay control containers (for touch-event isolation)

  // Stop Leaflet (esp. leaflet-rotate's touch handlers) from swallowing taps on overlay
  // controls — without this, +/−/compass/★ fire on desktop clicks but not on mobile touches.
  const registerCtl = React.useCallback((el) => {
    if (!el) return;
    if (!ctlEls.current.includes(el)) ctlEls.current.push(el);
    const L = window.L;
    if (L && L.DomEvent) { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); }
  }, []);

  const [theme, setTheme] = React.useState("dark");
  const [mapReady, setMapReady] = React.useState(false);

  // Re-apply control touch-isolation once Leaflet has loaded (controls mount before window.L exists)
  React.useEffect(() => {
    const L = window.L;
    if (mapReady && L && L.DomEvent) ctlEls.current.forEach(el => { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); });
  }, [mapReady]);

  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState(null);
  const [rotation, setRotation] = React.useState(0);
  const [stateFilter, setStateFilter] = React.useState("FL");
  const [selectedCounty, setSelectedCounty] = React.useState("");
  const [zoom, setZoom] = React.useState(7);
  const [showParcels, setShowParcels] = React.useState(true);
  const [fetchingParcels, setFetchingParcels] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [basketOpen, setBasketOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [proxyTest, setProxyTest] = React.useState("");   // "" | "testing" | "ok" | "fail"
  const [toast, setToast] = React.useState("");
  const [searchQ, setSearchQ] = React.useState("");
  const [searching, setSearching] = React.useState(false);

  const PARCEL_ZOOM = 15;   // show lot outlines at this zoom and deeper (15 keeps the data volume light & the map fast)
  const T = GT[theme];
  const isMobile = useIsMobile();
  const saved = data.gisSaved || [];
  const isSaved = !!(selected && saved.some(l => l.id === parcelLeadId(selected)));
  ctrlRef.current = { stateFilter, showParcels, proxy: (data.settings && data.settings.gisProxy) || "" };   // keep map handlers reading fresh values

  const countyNames = React.useMemo(() => Object.keys(GIS_COUNTIES[stateFilter] || {}), [stateFilter]);

  const STATE_CENTERS = { FL: [27.8, -81.5, 7], TX: [31.5, -99.3, 6], TN: [35.8, -86.4, 7], NC: [35.5, -79.4, 7],
    OH: [40.32, -82.83, 7], IN: [39.84, -86.22, 7], WI: [44.41, -89.77, 7], MN: [45.55, -94.43, 6], AR: [34.91, -92.43, 7], NM: [34.55, -105.89, 7],
    VA: [37.7, -78.7, 7], PR: [18.22, -66.4, 9],
    NY: [42.9, -75.5, 7], MT: [47.0, -109.6, 6], MA: [42.2, -71.8, 8], VT: [44.0, -72.7, 8], CT: [41.6, -72.7, 9] };

  React.useEffect(() => {
    let mounted = true;
    loadLeaflet().then((L) => {
      if (!mounted || !mapRef.current) return;
      const [lat, lng, z] = STATE_CENTERS[stateFilter] || [30, -85, 7];

      const map = L.map(mapRef.current, {
        center: [lat, lng], zoom: z,
        zoomControl: false, attributionControl: false,
        rotate: true, rotateControl: false, touchRotate: false,
      });
      mapObjRef.current = map;

      // Satellite base
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 21 }).addTo(map);
      // Labels
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 21, opacity: 0.85 }).addTo(map);

      // Lot-outline layer — every parcel in view (canvas for performance), each one clickable
      parcelLayerRef.current = L.geoJSON(null, {
        renderer: L.canvas({ padding: 0.5 }),
        style: { color: "#00E87A", weight: 1, fillColor: "#00E87A", fillOpacity: 0.04 },
        onEachFeature: (feat, layer) => {
          layer.on("click", (ev) => { L.DomEvent.stopPropagation(ev); selectAt(ev.latlng, feat); });
        },
      }).addTo(map);

      // Highlight layer — the single selected lot, illuminated (SVG so CSS can make it glow)
      highlightRef.current = L.geoJSON(null, {
        style: { color: "#FFE000", weight: 4.5, fillColor: "#FFE000", fillOpacity: 0.32, className: "lc-parcel-sel" },
      }).addTo(map);

      // Unified selection — used by both direct lot clicks and empty-area point queries
      async function selectAt(latlng, presetFeat) {
        if (!mounted) return;
        const { lat, lng } = latlng;
        setSelected(null); setError(null); setLoading(true);

        if (pinRef.current) pinRef.current.remove();
        pinRef.current = L.marker([lat, lng], {
          icon: L.divIcon({
            html: `<div style="width:14px;height:14px;border-radius:50%;background:#00E87A;border:2.5px solid #fff;box-shadow:0 0 10px #00E87A99;"></div>`,
            iconSize: [14, 14], iconAnchor: [7, 7], className: "",
          }),
        }).addTo(map);

        try {
          const geo = await reverseGeocode(lat, lng, 18);
          const stateName = geo?.address?.state || "";
          const st = STATE_ABBR[stateName] || ctrlRef.current.stateFilter || null;
          const rawCounty = normCounty(geo?.address?.county || geo?.address?.state_district || "");
          const countyData = st ? GIS_COUNTIES[st]?.[rawCounty] : null;
          const serviceUrl = (st && GIS_STATE_PARCELS[st]) || (st ? GIS_PARCEL_SERVICES[`${st}_${rawCounty}`] : null);
          const urls = getCountyUrls(st || ctrlRef.current.stateFilter, rawCounty, countyData?.slug || "");
          const fullAddress = buildAddress(geo);
          const base = { lat, lng, zip: geo?.address?.postcode || "", county: rawCounty, state: st, urls, fullAddress };

          // Direct lot click: we already have the geometry — illuminate + show immediately
          if (presetFeat) {
            if (highlightRef.current) { highlightRef.current.clearLayers(); highlightRef.current.addData(presetFeat); }
            if (parcelLayerRef.current) parcelLayerRef.current.setStyle({ opacity: 0.18, fillOpacity: 0.008 });
            const pf = extractParcelFields(presetFeat.properties);
            if (mounted) { setSelected({ ...base, fields: pf, hasFeat: true }); setLoading(false); }
            loadComps(lat, lng, st, pf);
            return;
          }

          // Empty-area click: show the card with the address NOW; parcel record (CORS-proxied,
          // can be slow/unavailable) fills in asynchronously without blocking the card.
          if (mounted) { setSelected({ ...base, fields: {}, hasFeat: false }); setLoading(false); }
          let qf = {};
          if (serviceUrl && ctrlRef.current.showParcels) {
            const feat = await queryArcGISParcel(serviceUrl, lat, lng, ctrlRef.current.proxy);
            if (feat && mounted) {
              if (highlightRef.current) { highlightRef.current.clearLayers(); highlightRef.current.addData(feat); }
              if (parcelLayerRef.current) parcelLayerRef.current.setStyle({ opacity: 0.18, fillOpacity: 0.008 });
              qf = extractParcelFields(feat.properties);
              setSelected(prev => (prev && prev.lat === lat && prev.lng === lng)
                ? { ...prev, fields: qf, hasFeat: true } : prev);
            }
          }
          loadComps(lat, lng, st, qf);
        } catch (_) {
          if (mounted) { setError("Could not load parcel data — check your connection."); setLoading(false); }
        }
      }

      // Async comps load — fills selected.comps without blocking the card
      function loadComps(lat, lng, st, fields) {
        const acres = parseFloat(fields && fields.acres) || 0;
        const same = (prev) => prev && prev.lat === lat && prev.lng === lng;
        if (!COMP_CONFIG[st]) { if (mounted) setSelected(prev => same(prev) ? { ...prev, comps: { unsupported: true } } : prev); return; }
        fetchComps(lat, lng, acres, st, ctrlRef.current.proxy).then((res) => {
          if (mounted) setSelected(prev => same(prev) ? { ...prev, comps: res } : prev);
        });
      }

      // Load every lot outline within the current viewport (debounced on move; statewide service)
      async function loadParcelsInView() {
        if (!mounted) return;
        const z = map.getZoom();
        if (!ctrlRef.current.showParcels || z < PARCEL_ZOOM) {
          parcelLayerRef.current && parcelLayerRef.current.clearLayers();
          setFetchingParcels(false);
          return;
        }
        const st = ctrlRef.current.stateFilter;
        const serviceUrl = GIS_STATE_PARCELS[st] || null;
        if (!serviceUrl) { parcelLayerRef.current && parcelLayerRef.current.clearLayers(); setFetchingParcels(false); return; }
        if (viewAbortRef.current) viewAbortRef.current.abort();
        const ac = new AbortController(); viewAbortRef.current = ac;
        setFetchingParcels(true);
        const feats = await queryArcGISParcelsInBounds(serviceUrl, map.getBounds(), ac.signal, ctrlRef.current.proxy);
        if (ac.signal.aborted || !mounted) return;
        if (parcelLayerRef.current) { parcelLayerRef.current.clearLayers(); if (feats.length) parcelLayerRef.current.addData(feats); }
        setFetchingParcels(false);
      }
      loaderRef.current = loadParcelsInView;
      selectAtRef.current = selectAt;

      function scheduleParcelLoad() {
        if (moveTimerRef.current) clearTimeout(moveTimerRef.current);
        moveTimerRef.current = setTimeout(loadParcelsInView, 450);
      }

      map.on("zoomend", () => { if (mounted) setZoom(map.getZoom()); });
      map.on("moveend", scheduleParcelLoad);
      map.on("click", (ev) => selectAt(ev.latlng, null));

      if (mounted) setMapReady(true);
    }).catch(() => { if (mounted) setError("Map library failed to load. Check your internet connection."); });

    return () => {
      mounted = false;
      if (moveTimerRef.current) clearTimeout(moveTimerRef.current);
      if (viewAbortRef.current) viewAbortRef.current.abort();
      if (mapObjRef.current) { mapObjRef.current.remove(); mapObjRef.current = null; }
      _leafletLoading = null;
    };
  }, []); // eslint-disable-line

  // NOTE: leaflet-rotate breaks Leaflet's animated moves (flyTo/animated setView/zoomIn
  // all no-op with the rotate plugin), so all map movement uses setView({animate:false}).
  const flyToCounty = (name) => {
    setSelectedCounty(name);
    const d = name ? GIS_COUNTIES[stateFilter]?.[name] : null;
    if (d) mapObjRef.current?.setView([d.lat, d.lng], 15, { animate: false });
  };

  const flyToState = (st) => {
    ctrlRef.current.stateFilter = st;
    setStateFilter(st);
    setSelectedCounty("");
    highlightRef.current?.clearLayers();
    parcelLayerRef.current?.clearLayers();
    const [lat, lng, z] = STATE_CENTERS[st] || [30, -85, 7];
    mapObjRef.current?.setView([lat, lng], z, { animate: false });
  };

  // Search the map by street address or parcel APN → fly in close + open the lot card
  const flyAndSelect = (lat, lng, feat) => {
    mapObjRef.current?.setView([lat, lng], 18, { animate: false });
    setTimeout(() => selectAtRef.current && selectAtRef.current({ lat, lng }, feat || null), 60);
  };
  const runSearch = async () => {
    const q = searchQ.trim();
    if (!q || searching) return;
    setSearching(true); setError(null);
    const proxy = (data.settings && data.settings.gisProxy) || "";
    const addressy = /[a-z]{3,}/i.test(q) && (/,/.test(q) || /\d+\s+[a-z]/i.test(q) ||
      /\b(st|ave|rd|dr|blvd|ln|ct|way|hwy|pkwy|cir|pl|ter|trl|street|avenue|road|drive|lane|court|circle|place|trail|highway|parkway)\b/i.test(q));
    // Look the APN up across all four statewide services in parallel; switch states on a hit
    const tryAPN = async () => {
      const order = [stateFilter, ...Object.keys(GIS_STATE_APN_FIELD).filter(s => s !== stateFilter)];
      const hits = await Promise.all(order.map(async (st) => {
        const svc = GIS_STATE_PARCELS[st], fld = GIS_STATE_APN_FIELD[st];
        if (!svc || !fld) return null;
        try {
          const where = `${fld}='${q.replace(/'/g, "''")}'`;
          const feats = await arcgisQuery(svc, { where, outFields: "*", returnGeometry: "true", outSR: "4326", resultRecordCount: "1" }, { timeout: 12000, proxy });
          return feats[0] ? { st, feat: feats[0] } : null;
        } catch (_) { return null; }
      }));
      const hit = hits.find(Boolean);
      if (!hit) return false;
      if (hit.st !== stateFilter) { ctrlRef.current.stateFilter = hit.st; setStateFilter(hit.st); setSelectedCounty(""); }
      const c = featCenter(hit.feat);
      if (!c) return false;
      flyAndSelect(c[0], c[1], hit.feat);
      return true;
    };
    const tryAddress = async () => {
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1&countrycodes=us`, { headers: { "Accept-Language": "en" }, signal: AbortSignal.timeout(8000) });
        const arr = await res.json();
        if (!arr || !arr[0]) return false;
        flyAndSelect(parseFloat(arr[0].lat), parseFloat(arr[0].lon), null);
        return true;
      } catch (_) { return false; }
    };
    try {
      const ok = addressy ? (await tryAddress() || await tryAPN()) : (await tryAPN() || await tryAddress());
      if (!ok) setError(`No match for “${q}” — try a full street address or exact APN.`);
    } catch (_) { setError("Search failed — check your connection."); }
    setSearching(false);
  };

  const rotate = (delta) => {
    const nr = (rotation + delta + 360) % 360;
    setRotation(nr);
    const map = mapObjRef.current;
    if (map?.setBearing) map.setBearing(nr);
    else if (mapRef.current) { mapRef.current.style.transform = `rotate(${nr}deg)`; mapRef.current.style.transformOrigin = "center"; }
  };

  const resetNorth = () => {
    setRotation(0);
    const map = mapObjRef.current;
    if (map?.setBearing) map.setBearing(0);
    else if (mapRef.current) mapRef.current.style.transform = "";
  };

  const addToPipeline = () => {
    if (!selected) return;
    update({ ...data, leads: [{ ...parcelToLead(selected), id: uid() }, ...data.leads] });
    setToast("Added to Pipeline ✓");
    setTimeout(() => setToast(""), 2500);
  };

  // Toggle a parcel in the saved-list basket (persists in data.gisSaved until removed)
  const toggleSave = () => {
    if (!selected) return;
    const id = parcelLeadId(selected);
    const next = saved.some(l => l.id === id) ? saved.filter(l => l.id !== id) : [parcelToLead(selected), ...saved];
    update({ ...data, gisSaved: next });
  };

  const exportSaved = async () => {
    if (!saved.length) return;
    const csv = leadsToCSV(saved);
    await copyText(csv);
    try {
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url; a.download = `landcommand-gis-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (_) { /* sandbox blocked download — CSV is on the clipboard */ }
    setToast(`Exported ${saved.length} parcel${saved.length === 1 ? "" : "s"} — CSV copied ✓`);
    setTimeout(() => setToast(""), 3200);
  };

  const addAllToPipeline = () => {
    if (!saved.length) return;
    const fresh = saved.map(l => ({ ...l, id: uid() }));
    update({ ...data, leads: [...fresh, ...data.leads], gisSaved: [] });
    setBasketOpen(false);
    setToast(`Added ${fresh.length} to Pipeline ✓`);
    setTimeout(() => setToast(""), 3200);
  };

  const removeSaved = (id) => update({ ...data, gisSaved: saved.filter(l => l.id !== id) });
  const clearSaved = () => { update({ ...data, gisSaved: [] }); setBasketOpen(false); };

  const setProxy = (v) => update({ ...data, settings: { ...(data.settings || {}), gisProxy: v } });
  const testProxy = async () => {
    setProxyTest("testing");
    // Canary = Esri's public sample ArcGIS server: very stable + no CORS headers, so it
    // only succeeds when the proxy actually relays. This tests YOUR proxy plumbing, not
    // any single county's uptime (county endpoints move/expire over time).
    const test = "https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&f=json&resultRecordCount=1";
    try {
      const res = await corsFetch(test, { timeout: 14000, proxy: (data.settings && data.settings.gisProxy) || "" });
      const t = await res.text();
      setProxyTest(/attributes|features|OBJECTID|fieldAliases/i.test(t) ? "ok" : "fail");
    } catch (_) { setProxyTest("fail"); }
    setTimeout(() => setProxyTest(""), 7000);
  };

  const cardOpen = !!selected;

  return (
    <div style={{ position: "relative", height: isMobile ? "calc(100dvh - 56px)" : "calc(100vh - 84px)", minHeight: isMobile ? 360 : 520, background: T.bg, borderRadius: 0, overflow: "hidden", border: "none", fontFamily: "'Inter',system-ui,-apple-system,sans-serif" }}>
      <style>{`
        .gm .leaflet-pane{z-index:1}.gm .leaflet-overlay-pane{z-index:4}.gm .leaflet-marker-pane{z-index:6}
        .gcb{backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);transition:opacity .15s;touch-action:manipulation}
        .gcb:hover{opacity:1!important}
        @keyframes gpulse{0%,100%{opacity:.55}50%{opacity:1}}
        .lc-parcel-sel{filter:drop-shadow(0 0 4px #FFD400) drop-shadow(0 0 9px rgba(255,212,0,.55));animation:gsel 1.6s ease-in-out infinite}
        @keyframes gsel{0%,100%{opacity:.85}50%{opacity:1}}
      `}</style>

      {/* Map */}
      <div ref={mapRef} className="gm" style={{ position: "absolute", inset: 0 }} />

      {/* Loading */}
      {loading && (
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", background: T.glass, border: `1px solid ${T.border}`, borderRadius: 14, padding: "13px 20px", zIndex: 800, display: "flex", alignItems: "center", gap: 10, backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)", color: T.text, fontSize: 13, fontWeight: 600, animation: "gpulse 1.2s infinite" }}>
          <span>📡</span> Querying parcel data…
        </div>
      )}

      {/* Error */}
      {error && (
        <div onClick={() => setError(null)} style={{ position: "absolute", top: 14, left: "50%", transform: "translateX(-50%)", background: T.badgeBg, border: `1px solid ${T.badge}`, borderRadius: 10, padding: "9px 16px", zIndex: 900, color: T.badge, fontSize: 12, fontWeight: 600, backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", cursor: "pointer" }}>
          {error} ×
        </div>
      )}

      {/* Success toast */}
      {toast && (
        <div style={{ position: "absolute", top: 56, left: "50%", transform: "translateX(-50%)", background: T.glass, border: `1px solid ${T.accent}`, borderRadius: 10, padding: "9px 16px", zIndex: 1200, color: T.accent, fontSize: 12.5, fontWeight: 700, backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", boxShadow: "0 6px 20px rgba(0,0,0,0.25)" }}>
          {toast}
        </div>
      )}

      {/* Top bar — state pills (row 1) + county dropdown (row 2) */}
      <div ref={registerCtl} style={{ position: "absolute", top: 12, left: 12, right: 58, zIndex: 700, display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
        {/* Search — jump to any street address or parcel APN */}
        <div style={{ display: "flex", gap: 6, width: isMobile ? "100%" : "min(330px, 64vw)" }}>
          <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
            placeholder="Search address or APN…" className="gcb"
            style={{ flex: 1, minWidth: 0, padding: "9px 14px", borderRadius: 18, border: `1px solid ${T.border}`, background: T.glass, color: T.text, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
          <button onClick={runSearch} title="Search" className="gcb"
            style={{ flexShrink: 0, width: 38, height: 38, borderRadius: "50%", border: `1px solid ${T.ctrlBorder}`, background: searching ? T.ctrl : T.accent, color: searching ? T.ctrlText : "#fff", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {searching ? "…" : "⌕"}
          </button>
        </div>
        {/* Compact location selectors (state + county) — small so they don't obstruct the map */}
        <div style={{ display: "flex", gap: 6, width: isMobile ? "100%" : "min(330px, 64vw)" }}>
          <select value={stateFilter} onChange={e => flyToState(e.target.value)} className="gcb" title="State"
            style={{ flexShrink: 0, width: 72, padding: "8px 8px", borderRadius: 16, border: `1px solid ${T.border}`, background: T.glass, color: T.text, fontSize: 12.5, fontWeight: 800, outline: "none", cursor: "pointer", WebkitAppearance: "none", appearance: "none", textAlign: "center" }}>
            {["FL","TX","TN","NC","OH","IN","WI","MN","AR","NM","VA","PR","NY","MT","MA","VT","CT"].map(st => <option key={st} value={st} style={{ color: "#111", background: "#fff" }}>{st}</option>)}
          </select>
          <select value={selectedCounty} onChange={e => flyToCounty(e.target.value)} className="gcb" title="County"
            style={{ flex: 1, minWidth: 0, padding: "8px 12px", borderRadius: 16, border: `1px solid ${T.border}`, background: T.glass, color: T.text, fontSize: 12.5, fontWeight: 600, outline: "none", cursor: "pointer", WebkitAppearance: "none", appearance: "none" }}>
            <option value="">{stateFilter === "PR" ? "Municipio" : stateFilter === "VA" ? "County / City" : "County"}… ({countyNames.length})</option>
            {countyNames.map(name => <option key={name} value={name} style={{ color: "#111", background: "#fff" }}>{name}{(stateFilter === "PR" || stateFilter === "VA") ? "" : " County"}</option>)}
          </select>
        </div>
      </div>

      {/* Data-source / proxy settings */}
      <button ref={registerCtl} className="gcb" onClick={() => { setSettingsOpen(o => !o); setBasketOpen(false); }} title="Live data source (CORS proxy)" style={{ position: "absolute", top: 12, right: 12, zIndex: 701, width: 38, height: 38, borderRadius: "50%", border: `1px solid ${T.ctrlBorder}`, background: (data.settings && data.settings.gisProxy) ? T.accent : T.ctrl, color: (data.settings && data.settings.gisProxy) ? "#fff" : T.ctrlText, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
        ⚙
      </button>

      {/* Basket panel */}
      {basketOpen && (
        <div style={{ position: "absolute", top: 58, right: 12, width: "min(340px, calc(100vw - 24px))", maxHeight: "calc(100% - 80px)", overflowY: "auto", zIndex: 1100, background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, boxShadow: "0 14px 44px rgba(0,0,0,0.4)", padding: 14, WebkitOverflowScrolling: "touch" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: T.text, fontFamily: "'Saira Condensed',sans-serif", textTransform: "uppercase", letterSpacing: ".05em" }}>Saved Parcels ({saved.length})</span>
            <button onClick={() => setBasketOpen(false)} style={{ border: "none", background: T.input, borderRadius: "50%", width: 28, height: 28, cursor: "pointer", color: T.textDim, fontSize: 16 }}>×</button>
          </div>
          {saved.length === 0 ? (
            <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.5, padding: "6px 2px 10px" }}>
              No parcels saved yet. Tap a parcel on the map, then "☆ Save to List" to collect it here. Saved parcels persist until you remove them — then bulk-export as CSV or push them all to the Pipeline.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
              {saved.map(l => (
                <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: T.input, border: `1px solid ${T.border}`, borderRadius: 10, padding: "8px 10px" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.owner || "Unknown owner"}</div>
                    <div style={{ fontSize: 10.5, color: T.textDim, fontFamily: "'JetBrains Mono',monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {[l.apn && `APN ${l.apn}`, l.county && `${l.county} Co`, l.acres && `${l.acres} ac`].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </div>
                  <button onClick={() => removeSaved(l.id)} title="Remove" style={{ flexShrink: 0, border: "none", background: "transparent", color: T.textDim, fontSize: 16, cursor: "pointer", padding: 4 }}>×</button>
                </div>
              ))}
            </div>
          )}
          {saved.length > 0 && (
            <div style={{ display: "grid", gap: 6 }}>
              <button onClick={exportSaved} style={{ padding: "10px 0", borderRadius: 12, border: `1px solid ${T.border}`, background: T.input, color: T.text, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>⇩ Export CSV ({saved.length})</button>
              <button onClick={addAllToPipeline} style={{ padding: "10px 0", borderRadius: 12, border: "none", background: T.accent, color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>+ Add all to Pipeline</button>
              <button onClick={clearSaved} style={{ padding: "9px 0", borderRadius: 12, border: `1px solid ${T.border}`, background: "transparent", color: T.badge, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Clear list</button>
            </div>
          )}
        </div>
      )}

      {/* Data-source / proxy panel */}
      {settingsOpen && (
        <div style={{ position: "absolute", top: 58, right: 12, width: "min(380px, calc(100vw - 24px))", maxHeight: "calc(100% - 80px)", overflowY: "auto", zIndex: 1100, background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, boxShadow: "0 14px 44px rgba(0,0,0,0.4)", padding: 16, WebkitOverflowScrolling: "touch" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: T.text, fontFamily: "'Saira Condensed',sans-serif", textTransform: "uppercase", letterSpacing: ".05em" }}>Live Data Source</span>
            <button onClick={() => setSettingsOpen(false)} style={{ border: "none", background: T.input, borderRadius: "50%", width: 28, height: 28, cursor: "pointer", color: T.textDim, fontSize: 16 }}>×</button>
          </div>
          <div style={{ fontSize: 12, color: T.textDim, lineHeight: 1.5, marginBottom: 12 }}>
            County GIS servers block direct browser access, so lot outlines &amp; owner data need a CORS proxy. Paste your proxy URL below (a free Cloudflare Worker is the reliable option — ask in chat for the code). Leave blank to try direct + public relays.
          </div>
          <label style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: T.textDim, display: "block", marginBottom: 5 }}>Proxy URL</label>
          <input value={(data.settings && data.settings.gisProxy) || ""} onChange={e => setProxy(e.target.value)} placeholder="https://your-worker.workers.dev/?url={url}"
            style={{ width: "100%", padding: "9px 11px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.input, color: T.text, fontSize: 12, fontFamily: "'JetBrains Mono',monospace", outline: "none", boxSizing: "border-box" }} />
          <div style={{ fontSize: 10.5, color: T.textDim, marginTop: 6, lineHeight: 1.45 }}>
            Use <code>{"{url}"}</code> where the encoded target goes, or paste just the base URL and the app appends <code>?url=</code>.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
            <button onClick={testProxy} disabled={proxyTest === "testing"} style={{ padding: "9px 16px", borderRadius: 10, border: "none", background: T.accent, color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer", opacity: proxyTest === "testing" ? 0.7 : 1 }}>
              {proxyTest === "testing" ? "Testing…" : "Test connection"}
            </button>
            {proxyTest === "ok" && <span style={{ fontSize: 12.5, fontWeight: 700, color: T.accent }}>✓ Proxy works — data flowing</span>}
            {proxyTest === "fail" && <span style={{ fontSize: 12.5, fontWeight: 700, color: T.badge }}>✕ No response — check the URL</span>}
          </div>
        </div>
      )}

      {/* Right controls */}
      <div ref={registerCtl} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", zIndex: 700, display: "flex", flexDirection: "column", gap: 6 }}>
        {/* Saved-parcels basket — sits at the top of the rail, just above the compass */}
        <button className="gcb" onClick={() => { setBasketOpen(o => !o); setSettingsOpen(false); }} title="Saved parcels" style={{ position: "relative", width: isMobile ? 36 : 40, height: isMobile ? 36 : 40, borderRadius: "50%", border: `1px solid ${T.ctrlBorder}`, background: saved.length ? T.accent : T.ctrl, color: saved.length ? "#fff" : T.ctrlText, cursor: "pointer", fontSize: 16, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
          ★
          {saved.length > 0 && <span style={{ position: "absolute", top: -3, right: -3, minWidth: 16, height: 16, padding: "0 3px", borderRadius: 8, background: "#ef4444", color: "#fff", fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", border: `1.5px solid ${T.bg}` }}>{saved.length}</span>}
        </button>
        {[
          ["🧭", resetNorth, "Reset north"],
          ["↺", () => rotate(-15), "Rotate left"],
          ["↻", () => rotate(15), "Rotate right"],
          ["+", () => mapObjRef.current?.setZoom(mapObjRef.current.getZoom() + 1, { animate: false }), "Zoom in"],
          ["−", () => mapObjRef.current?.setZoom(mapObjRef.current.getZoom() - 1, { animate: false }), "Zoom out"],
        ].filter((_, idx) => !isMobile || idx === 0 || idx >= 3).map(([icon, fn, title]) => (
          <button key={title} className="gcb" onClick={fn} title={title} style={{ width: isMobile ? 36 : 40, height: isMobile ? 36 : 40, borderRadius: "50%", border: `1px solid ${T.ctrlBorder}`, background: T.ctrl, color: T.ctrlText, cursor: "pointer", fontSize: icon==="🧭"?18:20, fontWeight: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {icon === "🧭" ? <span style={{ transform: `rotate(${-rotation}deg)`, display: "block", transition: "transform .2s" }}>🧭</span> : icon}
          </button>
        ))}
      </div>

      {/* Bottom chips */}
      <div style={{ position: "absolute", bottom: cardOpen ? "calc(65vh + 10px)" : 14, left: 12, zIndex: 700, display: "flex", gap: 6, transition: "bottom .3s ease", pointerEvents: "none" }}>
        <div className="gcb" style={{ background: T.glass, border: `1px solid ${T.border}`, borderRadius: 10, padding: "5px 10px", color: T.textDim, fontSize: 11, fontFamily: "'JetBrains Mono',monospace" }}>
          {zoom < PARCEL_ZOOM ? "Zoom in to see lot lines" : `Zoom ${zoom}${rotation ? ` · ${rotation}°` : ""}`}
        </div>
        {!mapReady && <div className="gcb" style={{ background: T.glass, border: `1px solid ${T.border}`, borderRadius: 10, padding: "5px 10px", color: T.accent, fontSize: 11, animation: "gpulse 1.2s infinite" }}>Loading map…</div>}
        {fetchingParcels && <div className="gcb" style={{ background: T.glass, border: `1px solid ${T.border}`, borderRadius: 10, padding: "5px 10px", color: T.accent, fontSize: 11, animation: "gpulse 1.2s infinite" }}>◌ Loading lot lines…</div>}
      </div>

      {/* Lot-lines toggle */}
      <button ref={registerCtl} className="gcb" onClick={() => { const nv=!showParcels; ctrlRef.current.showParcels = nv; setShowParcels(nv); if(!nv){ parcelLayerRef.current?.clearLayers(); highlightRef.current?.clearLayers(); } else loaderRef.current?.(); }} style={{ position: "absolute", bottom: cardOpen ? "calc(65vh + 10px)" : 14, right: 12, zIndex: 700, padding: "6px 13px", borderRadius: 10, border: `1px solid ${T.ctrlBorder}`, background: showParcels ? T.accent : T.ctrl, color: showParcels ? "#fff" : T.ctrlText, fontSize: 11.5, fontWeight: 700, cursor: "pointer", transition: "bottom .3s ease" }}>
        {showParcels ? "Lot Lines ON" : "Lot Lines OFF"}
      </button>


      {/* Ownership card */}
      {selected && (
        <ParcelCard parcel={selected} theme={theme} isSaved={isSaved} onToggleSave={toggleSave} onStartDeal={onStartDeal}
          onClose={() => { setSelected(null); highlightRef.current?.clearLayers(); parcelLayerRef.current?.setStyle({ opacity: 1, fillOpacity: 0.04 }); if(pinRef.current){pinRef.current.remove();pinRef.current=null;} }}
          onAddToPipeline={addToPipeline}
        />
      )}
    </div>
  );
}
