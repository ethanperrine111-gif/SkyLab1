// SkyLab — live TFR proxy (Supabase Edge Function, Deno).
//
// tfr.faa.gov has the authoritative, live list of every active Temporary Flight Restriction
// (wildfire, VIP/Presidential, sporting events, security) but sends no CORS headers and exposes the
// geometry only as per-NOTAM AIXM XML. A static web page can't use it directly. This function runs
// server-side: it pulls the active list, fetches each TFR's XML, parses the boundary (polygon or
// circle) and altitudes, and returns one CORS-enabled GeoJSON FeatureCollection.
//
// Deploy (public, no auth so the static page can call it):
//   supabase functions deploy tfr --no-verify-jwt --project-ref zfzayopcdswmkwgugyqp
//
// Query params:
//   ?states=UT,ID,WY,NV,AZ,CO,NM   (default western region; use ?states=ALL for the whole US)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Warm-instance cache so repeated toggles don't hammer the FAA.
const cache: Record<string, { t: number; gj: unknown }> = {};
const TTL = 10 * 60 * 1000; // 10 minutes

const LIST_URL = "https://tfr.faa.gov/tfrapi/exportTfrList";
// Geometry lives at /download/ (the old /save_pages/ path 404s). Coords are decimal degrees.
const DETAIL = (id: string) =>
  `https://tfr.faa.gov/download/detail_${id.replace(/\//g, "_")}.xml`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}

// --- coordinate parsing -------------------------------------------------------
// FAA AIXM gives geoLat/geoLong as DDMMSS.ss + hemisphere (e.g. "404500.00N", "1110000.00W").
// Some feeds use plain decimal degrees. Distinguish by the integer-part length.
function parseCoord(raw: string | null): number | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const h = s.slice(-1).toUpperCase();
  const neg = h === "S" || h === "W";
  const num = /[NSEW]$/i.test(s) ? s.slice(0, -1) : s;
  const dot = num.indexOf(".");
  const intp = dot >= 0 ? num.slice(0, dot) : num;
  let v: number;
  if (intp.replace("-", "").length <= 3) {
    v = parseFloat(num); // already decimal degrees
  } else {
    const frac = dot >= 0 ? num.slice(dot) : "";
    const ss = parseFloat(intp.slice(-2) + frac) || 0;
    const mm = parseInt(intp.slice(-4, -2), 10) || 0;
    const dd = parseInt(intp.slice(0, -4), 10) || 0;
    v = dd + mm / 60 + ss / 3600;
  }
  if (!isFinite(v)) return null;
  return neg ? -v : v;
}

function toKm(v: number, unit: string): number {
  const u = (unit || "NM").toUpperCase();
  if (u.startsWith("NM")) return v * 1.852;
  if (u === "KM") return v;
  if (u === "M") return v / 1000;
  if (u.startsWith("MI") || u === "SM") return v * 1.609344;
  if (u === "FT") return v * 0.0003048;
  return v * 1.852; // default nautical miles
}

function circleRing(lat: number, lon: number, km: number): number[][] {
  const R = 6371, d = km / R, la1 = lat * Math.PI / 180, lo1 = lon * Math.PI / 180;
  const out: number[][] = [];
  for (let i = 0; i <= 48; i++) {
    const b = 2 * Math.PI * i / 48;
    const la = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
    const lo = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la));
    out.push([lo * 180 / Math.PI, la * 180 / Math.PI]);
  }
  return out;
}

// --- tiny XML helpers (the schema is fixed and controlled, so regex is enough) ---
function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp("<" + name + "\\b[^>]*>([\\s\\S]*?)</" + name + ">"));
  return m ? m[1].trim() : null;
}
function tagAll(xml: string, name: string): string[] {
  const re = new RegExp("<" + name + "\\b[^>]*>([\\s\\S]*?)</" + name + ">", "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

interface ListItem { notam_id: string; type: string; facility: string; state: string; description: string; creation_date: string; }

function xmlToFeatures(xmlRaw: string, meta: ListItem): unknown[] {
  // The modern free-text block embeds HTML that breaks naive parsing — drop it first.
  const xml = xmlRaw.replace(/<txtDescrModern[\s\S]*?<\/txtDescrModern>/g, "");
  const name = tag(xml, "txtName") || tag(xml, "txtLocalName") || meta.notam_id;
  const effective = tag(xml, "dateEffective");
  const expires = tag(xml, "dateExpire");
  const upper = tag(xml, "valDistVerUpper");
  const upperU = tag(xml, "uomDistVerUpper");
  const lower = tag(xml, "valDistVerLower");
  const lowerU = tag(xml, "uomDistVerLower");
  const ceiling = upper ? (upper + " " + (upperU || "")).trim() : null;
  const floor = lower ? (lower + " " + (lowerU || "")).trim() : (tag(xml, "codeDistVerLower") || null);

  const props = (extra: Record<string, unknown>) => ({
    name, type: meta.type, facility: meta.facility, state: meta.state,
    notam: meta.notam_id, effective, expires, floor, ceiling, source: "live", ...extra,
  });

  const areas = tagAll(xml, "abdMergedArea");
  const blocks = areas.length ? areas : [xml];
  const feats: unknown[] = [];
  for (const area of blocks) {
    let ring: number[][] | null = null;
    const radius = tag(area, "valRadiusArc") || tag(area, "valRadius");
    if (radius) {
      const clat = parseCoord(tag(area, "geoLatArc") || tag(area, "geoLatCen") || tag(area, "geoLat"));
      const clon = parseCoord(tag(area, "geoLongArc") || tag(area, "geoLongCen") || tag(area, "geoLong"));
      const ru = tag(area, "uomRadiusArc") || tag(area, "uomRadius") || "NM";
      if (clat != null && clon != null) ring = circleRing(clat, clon, toKm(parseFloat(radius), ru));
    }
    if (!ring) {
      const pts: number[][] = [];
      for (const a of tagAll(area, "Avx")) {
        const la = parseCoord(tag(a, "geoLat"));
        const lo = parseCoord(tag(a, "geoLong"));
        if (la != null && lo != null) pts.push([lo, la]);
      }
      if (pts.length >= 3) {
        const f = pts[0], l = pts[pts.length - 1];
        if (f[0] !== l[0] || f[1] !== l[1]) pts.push(f);
        ring = pts;
      } else if (pts.length === 1 && radius) {
        ring = circleRing(pts[0][1], pts[0][0], toKm(parseFloat(radius), "NM"));
      }
    }
    if (ring) feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: props({}) });
  }
  return feats;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    const statesParam = (url.searchParams.get("states") || "UT,ID,WY,NV,AZ,CO,NM,MT,OR,CA").toUpperCase();
    const all = statesParam === "ALL";
    const want = new Set(statesParam.split(",").map((s) => s.trim()));

    const now = Date.now();
    const hit = cache[statesParam];
    if (hit && now - hit.t < TTL) return json(hit.gj);

    const listRes = await fetch(LIST_URL, { headers: { accept: "application/json" } });
    if (!listRes.ok) return json({ type: "FeatureCollection", features: [], error: "list " + listRes.status });
    const list: ListItem[] = await listRes.json();

    let items = list.filter((x) => all || want.has((x.state || "").toUpperCase()));
    items = items.slice(0, 80); // safety cap so we never blow the function timeout

    const features: unknown[] = [];
    const CHUNK = 8;
    for (let i = 0; i < items.length; i += CHUNK) {
      const part = items.slice(i, i + CHUNK);
      const got = await Promise.all(part.map(async (it) => {
        try {
          const r = await fetch(DETAIL(it.notam_id));
          if (!r.ok) return [];
          return xmlToFeatures(await r.text(), it);
        } catch (_e) {
          return [];
        }
      }));
      got.forEach((g) => features.push(...g));
    }

    const gj = { type: "FeatureCollection", features };
    cache[statesParam] = { t: now, gj };
    return json(gj);
  } catch (e) {
    // Never hard-fail — the client falls back to the ArcGIS security layer on an empty/error body.
    return json({ type: "FeatureCollection", features: [], error: String(e) });
  }
});
