import admin from "firebase-admin";

const TARGET_DOC_ID = "kBrk5tvWYTrQ8sBM3e87";
const ORIGIN_URL    = "https://gant.com"; // Script testet www-Variante automatisch

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, CRUX_API_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) throw new Error("Firebase ENV fehlt");
if (!CRUX_API_KEY) throw new Error("CRUX_API_KEY fehlt");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    })
  });
}
const db = admin.firestore();

const HISTORY_ENDPOINT =
  `https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=${CRUX_API_KEY}`;

const ymd = ({year, month, day}) =>
  `${String(year).padStart(4,"0")}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;

function ensureHttps(u){ return /^https?:\/\//i.test(u) ? u : `https://${u}`; }
function variants(base){
  const a = new URL(ensureHttps(base));
  const host = a.hostname;
  const b = new URL(a);
  b.hostname = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  return [a.toString(), b.toString()];
}

// good-Share aus histogramTS für LCP (alle Bins mit end <= 2500 summieren)
function goodFromHistogramIndex(histTS, idx){
  if (!Array.isArray(histTS)) return null;
  let s = 0;
  for (const bin of histTS){
    const end = (typeof bin.end === "string" ? parseFloat(bin.end) : bin.end) ?? Infinity;
    const dens = Array.isArray(bin.densities) ? bin.densities[idx] ?? 0 : 0;
    if (end <= 2500) s += dens;
  }
  return Math.max(0, Math.min(1, s));
}

async function queryHistory(origin){
  const r = await fetch(HISTORY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      origin,
      metrics: ["largest_contentful_paint"],
      collectionPeriodCount: 40 // bis zu 40 wöchentliche Punkte
    })
  });
  if (!r.ok){
    const t = await r.text();
    const e = new Error(`History ${r.status}: ${t}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

async function run(){
  const metricsDocRef = db.collection("metrics").doc(TARGET_DOC_ID);

  // Origin-Variante finden (mit/ohne www)
  let picked = null, data = null;
  for (const o of variants(ORIGIN_URL)){
    try { data = await queryHistory(o); picked = o; break; }
    catch(e){ if (e.status === 404) continue; else throw e; }
  }
  if (!picked || !data?.record?.metrics?.largest_contentful_paint)
    throw new Error("Keine History-Daten für beide Varianten.");

  // Root-Meta setzen
  await metricsDocRef.set({ origin: true, url: picked }, { merge: true });

  const rec = data.record;
  const cp  = rec.collectionPeriods || []; // array wöchentlicher Perioden (28-Tage-Fenster)
  const lcp = rec.metrics.largest_contentful_paint;
  const p75s = lcp?.percentilesTimeseries?.p75s || [];
  const histTS = lcp?.histogramTimeseries || [];

  // Alle Punkte idempotent in weekly-crux schreiben
  const batchWrites = [];
  for (let i = 0; i < Math.min(cp.length, p75s.length); i++){
    const day = ymd(cp[i].lastDate);           // Ende der Woche (samstags) :contentReference[oaicite:1]{index=1}
    const docId = `${day}_all`;
    const lcp_good = goodFromHistogramIndex(histTS, i);
    const payload = {
      origin: true,
      url: picked,
      lcp_p75: p75s[i] ?? null,
      lcp_good,
      w_start: ymd(cp[i].firstDate),
      w_end: day,
      fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "crux_history_api"
    };
    batchWrites.push(
      metricsDocRef.collection("weekly-crux").doc(docId).set(payload, { merge: false })
    );
  }
  await Promise.all(batchWrites);
  console.log(`OK: wrote ${batchWrites.length} weekly docs to metrics/${TARGET_DOC_ID}/weekly-crux`);
}

run().catch(err => { console.error(err); process.exit(1); });
