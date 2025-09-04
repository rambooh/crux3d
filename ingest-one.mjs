import admin from "firebase-admin";

// Zielpfad + gewünschter Basis-Host (ohne/mit www egal – wir testen beides)
const TARGET_DOC_ID = "kBrk5tvWYTrQ8sBM3e87";
const ORIGIN_URL    = "https://gant.com"; // Basis – Script testet www-Variante automatisch

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
const CRUX_ENDPOINT = `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${CRUX_API_KEY}`;

const ymd = ({year, month, day}) => `${String(year).padStart(4,"0")}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
function lcpGoodShare(hist) {
  if (!hist || !hist.length) return null;
  let good = 0;
  for (const bin of hist) {
    const end = (typeof bin.end === "string" ? parseFloat(bin.end) : bin.end) ?? Infinity;
    const dens = bin.density ?? 0;
    if (end <= 2500) good += dens;
  }
  return Math.max(0, Math.min(1, good));
}
function ensureHttps(u) { return /^https?:\/\//i.test(u) ? u : `https://${u}`; }
function variants(base) {
  const a = new URL(ensureHttps(base));
  const host = a.hostname;
  const hasWww = host.startsWith("www.");
  const b = new URL(a.toString());
  b.hostname = hasWww ? host.slice(4) : `www.${host}`;
  return [a.toString(), b.toString()];
}

async function queryCrux(origin) {
  const r = await fetch(CRUX_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ origin, metrics: ["largest_contentful_paint"] })
  });
  if (!r.ok) {
    const txt = await r.text();
    const err = new Error(`CrUX ${r.status}: ${txt}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function run() {
  // Root-Dokument anlegen/aktualisieren
  const metricsDocRef = db.collection("metrics").doc(TARGET_DOC_ID);

  let pickedOrigin = null, data = null;
  for (const o of variants(ORIGIN_URL)) {
    console.log("Trying origin:", o);
    try {
      data = await queryCrux(o);
      pickedOrigin = o;
      break; // Erfolg – raus
    } catch (e) {
      if (e.status === 404) {
        console.log("No data for:", o);
        continue; // nächste Variante probieren
      } else {
        throw e; // andere Fehler durchreichen
      }
    }
  }
  if (!pickedOrigin || !data?.record?.metrics?.largest_contentful_paint) {
    throw new Error("Keine CrUX-Daten für beide Varianten gefunden.");
  }

  await metricsDocRef.set({ origin: true, url: pickedOrigin }, { merge: true });

  const rec = data.record;
  const lcp = rec.metrics.largest_contentful_paint;
  const lcp_good = lcpGoodShare(lcp.histogram || []);
  const w_start  = ymd(rec.collectionPeriod.firstDate);
  const w_end    = ymd(rec.collectionPeriod.lastDate);
  const dayId    = `${w_end}_all`;

  await metricsDocRef.collection("daily-crux").doc(dayId).set({
    origin: true, url: pickedOrigin, lcp_good, w_start, w_end,
    fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: "crux_api"
  }, { merge: false });

  console.log(`OK: metrics/${TARGET_DOC_ID}/daily-crux/${dayId} for ${pickedOrigin}`);
}

run().catch(err => { console.error(err); process.exit(1); });
