import admin from "firebase-admin";

// Zielpfad + Origin
const TARGET_DOC_ID = "kBrk5tvWYTrQ8sBM3e87";
const ORIGIN_URL    = "https://www.gant.com/";

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
const normalizeOrigin = (o) => /^https?:\/\//i.test(o) ? o : `https://${o}`;
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

async function run() {
  const origin = normalizeOrigin(ORIGIN_URL);
  const metricsDocRef = db.collection("metrics").doc(TARGET_DOC_ID);
  await metricsDocRef.set({ origin: true, url: origin }, { merge: true });

  const res = await fetch(CRUX_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ origin, metrics: ["largest_contentful_paint"] })
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  const rec = data?.record;
  const lcp = rec?.metrics?.largest_contentful_paint;
  if (!rec || !lcp) throw new Error("Keine LCP-Daten");

  const lcp_good = lcpGoodShare(lcp.histogram || []);
  const w_start  = ymd(rec.collectionPeriod.firstDate);
  const w_end    = ymd(rec.collectionPeriod.lastDate);
  const dayId    = `${w_end}_all`;

  await metricsDocRef.collection("daily-crux").doc(dayId).set({
    origin: true, url: origin, lcp_good, w_start, w_end,
    fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: "crux_api"
  }, { merge: false });

  console.log(`OK: metrics/${TARGET_DOC_ID}/daily-crux/${dayId}`);
}
run().catch(err => { console.error(err); process.exit(1); });
