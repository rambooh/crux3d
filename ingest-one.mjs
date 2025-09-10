// ingest-daily-crux-raw.mjs
import admin from "firebase-admin";

// ---------- Config ----------
const TARGET_DOC_ID = "kBrk5tvWYTrQ8sBM3e87";
const ORIGIN_URL    = "https://gant.com";

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, CRUX_API_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  throw new Error("Firebase ENV fehlt (FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY)");
}
if (!CRUX_API_KEY) throw new Error("CRUX_API_KEY fehlt");

// ---------- Firebase ----------
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

// ---------- CrUX ----------
const CRUX_DAILY = `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${CRUX_API_KEY}`;

const FORM_FACTORS = [
  { api: "ALL_FORM_FACTORS", suffix: "all" },
  { api: "PHONE",            suffix: "phone" },
  { api: "DESKTOP",          suffix: "desktop" },
  { api: "TABLET",           suffix: "tablet" }
];

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

async function queryDailyRaw(origin, formFactorApi) {
  const body = formFactorApi === "ALL_FORM_FACTORS"
    ? { origin }
    : { origin, formFactor: formFactorApi };

  const r = await fetch(CRUX_DAILY, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    const err = new Error(`CrUX daily ${r.status}: ${txt}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function run() {
  const metricsDocRef = db.collection("metrics").doc(TARGET_DOC_ID);

  // pick working origin (with/without www)
  let pickedOrigin = null;
  let testData = null;
  for (const o of variants(ORIGIN_URL)) {
    try {
      // probe with ALL_FORM_FACTORS to verify origin
      testData = await queryDailyRaw(o, "ALL_FORM_FACTORS");
      pickedOrigin = o;
      break;
    } catch (e) {
      if (e.status === 404) continue;
      throw e;
    }
  }
  if (!pickedOrigin || !testData?.record?.collectionPeriod) {
    throw new Error("Keine CrUX-Daten für beide Varianten gefunden.");
  }

  // keep lightweight metadata on the metrics root
  await metricsDocRef.set({ origin: true, url: pickedOrigin }, { merge: true });

  // Determine date from the ALL snapshot (all form factors share the same period)
  const w_end_all = ymd(testData.record.collectionPeriod.lastDate);

  // Now fetch & store each form factor raw
  for (const ff of FORM_FACTORS) {
    let data;
    try {
      data = (ff.api === "ALL_FORM_FACTORS")
        ? testData
        : await queryDailyRaw(pickedOrigin, ff.api);
    } catch (e) {
      if (e.status === 404) {
        console.log(`No data for ${ff.api} — skipping`);
        continue;
      }
      throw e;
    }

    const rec = data?.record;
    if (!rec?.collectionPeriod) {
      console.log(`Missing collectionPeriod for ${ff.api} — skipping`);
      continue;
    }

    const w_end = ymd(rec.collectionPeriod.lastDate);
    // Use the actual end date from this record (should match ALL, but keep robust)
    const dayId = `${w_end}_${ff.suffix}`;

    const payload = {
      record: rec,                       // <-- raw CrUX record
      source: "crux_api",
      fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await metricsDocRef.collection("daily-crux").doc(dayId).set(payload, { merge: false });
    console.log(`OK: daily-crux/${dayId} (${ff.api})`);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
