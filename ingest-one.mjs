// ingest-daily-crux-raw.mjs
import admin from "firebase-admin";

const TARGET_DOC_ID = "kBrk5tvWYTrQ8sBM3e87";
const ORIGIN_URL    = "https://gant.com"; // we'll try with and without www

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, CRUX_API_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  throw new Error("Firebase ENV fehlt (FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY)");
}
if (!CRUX_API_KEY) throw new Error("CRUX_API_KEY fehlt");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}
const db = admin.firestore();

const CRUX_ENDPOINT = `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${CRUX_API_KEY}`;

const ymd = ({ year, month, day }) =>
  `${String(year).padStart(4,"0")}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;

function ensureHttps(u) { return /^https?:\/\//i.test(u) ? u : `https://${u}`; }
function variants(base) {
  const a = new URL(ensureHttps(base));
  const host = a.hostname;
  const hasWww = host.startsWith("www.");
  const b = new URL(a.toString());
  b.hostname = hasWww ? host.slice(4) : `www.${host}`;
  return [a.toString(), b.toString()];
}

async function queryCruxAll(origin) {
  // No "metrics" array → CrUX returns all available metrics for that key
  const r = await fetch(CRUX_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ origin }),
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
  const metricsDocRef = db.collection("metrics").doc(TARGET_DOC_ID);

  let pickedOrigin = null;
  let data = null;

  for (const o of variants(ORIGIN_URL)) {
    console.log("Trying origin:", o);
    try {
      data = await queryCruxAll(o);
      pickedOrigin = o;
      break;
    } catch (e) {
      if (e.status === 404) {
        console.log("No data for:", o);
        continue;
      }
      throw e;
    }
  }

  const rec = data?.record;
  if (!pickedOrigin || !rec?.metrics || !rec?.collectionPeriod) {
    throw new Error("Keine CrUX-Daten für beide Varianten gefunden.");
  }

  // Keep a tiny bit of metadata on the site root doc (useful for consoles/joins)
  await metricsDocRef.set({ origin: true, url: pickedOrigin }, { merge: true });

  const w_start = ymd(rec.collectionPeriod.firstDate);
  const w_end   = ymd(rec.collectionPeriod.lastDate);
  const dayId   = `${w_end}_all`;

  // Store the record **raw** as we got it from CrUX
  // plus minimal ingestion metadata next to it.
  const payload = {
    record: rec, // <-- raw CrUX record (key, metrics, collectionPeriod)
    source: "crux_api",
    fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await metricsDocRef.collection("daily-crux").doc(dayId).set(payload, { merge: false });

  console.log(`OK: metrics/${TARGET_DOC_ID}/daily-crux/${dayId} (raw) for ${pickedOrigin}`);
}

run().catch(err => { console.error(err); process.exit(1); });
