import admin from "firebase-admin";

// ---------- Config ----------
const TARGET_DOC_ID = "kBrk5tvWYTrQ8sBM3e87";
const ORIGIN_URL    = "https://gant.com";

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, CRUX_API_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) throw new Error("Firebase ENV fehlt");
if (!CRUX_API_KEY) throw new Error("CRUX_API_KEY fehlt");

// ---------- Firebase ----------
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

// ---------- CrUX ----------
const CRUX_ENDPOINT = `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${CRUX_API_KEY}`;

// CrUX metric keys and their category thresholds (goodUpper, okUpper)
// Ref: https://developer.chrome.com/docs/crux/methodology#metrics
const METRIC_THRESHOLDS = {
  first_contentful_paint:         { goodUpper: 1800, okUpper: 3000 }, // ms
  largest_contentful_paint:       { goodUpper: 2500, okUpper: 4000 }, // ms
  interaction_to_next_paint:      { goodUpper: 200,  okUpper: 500  }, // ms
  first_input_delay:              { goodUpper: 100,  okUpper: 300  }, // ms (legacy)
  experimental_time_to_first_byte:{ goodUpper: 800,  okUpper: 1800 }, // ms
  cumulative_layout_shift:        { goodUpper: 0.1,  okUpper: 0.25 }  // unitless
};

// Optional short names for convenience top-level fields
const SHORT = {
  first_contentful_paint:          "fcp",
  largest_contentful_paint:        "lcp",
  interaction_to_next_paint:       "inp",
  cumulative_layout_shift:         "cls",
  first_input_delay:               "fid",
  experimental_time_to_first_byte: "ttfb"
};

const ymd = ({year, month, day}) =>
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

// Sum shares by category using the standard CrUX histogram layout
function shares(metricName, hist = []) {
  const t = METRIC_THRESHOLDS[metricName];
  if (!t) return { good: null, ok: null, poor: null };

  let good = 0, ok = 0, poor = 0;
  for (const bin of hist) {
    const end = (typeof bin.end === "string" ? parseFloat(bin.end) : bin.end);
    const dens = bin.density ?? 0;

    // CrUX histograms are already split by thresholds; use end boundary
    if (end == null || end === Infinity) {
      // open-ended tail is always "poor"
      poor += dens;
    } else if (end <= t.goodUpper) {
      good += dens;
    } else if (end <= t.okUpper) {
      ok += dens;
    } else {
      poor += dens;
    }
  }

  // Clamp to [0,1] and normalize tiny FP drift
  const total = good + ok + poor || 1;
  return {
    good: Math.max(0, Math.min(1, good)),
    ok:   Math.max(0, Math.min(1, ok)),
    poor: Math.max(0, Math.min(1, poor)),
    total
  };
}

async function queryCrux(origin) {
  // If you omit "metrics", CrUX returns all available for the key you query.
  const body = { origin }; // get everything (LCP, FCP, INP, CLS, FID, TTFB) for the 28d window
  const r = await fetch(CRUX_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body)
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

  // Try with/without www.
  let pickedOrigin = null, data = null;
  for (const o of variants(ORIGIN_URL)) {
    console.log("Trying origin:", o);
    try {
      data = await queryCrux(o);
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
  if (!pickedOrigin || !data?.record?.metrics) {
    throw new Error("Keine CrUX-Daten für beide Varianten gefunden.");
  }

  // Keep root doc up to date
  await metricsDocRef.set({ origin: true, url: pickedOrigin }, { merge: true });

  const rec     = data.record;
  const period  = rec.collectionPeriod;
  const w_start = ymd(period.firstDate);
  const w_end   = ymd(period.lastDate);
  const dayId   = `${w_end}_all`;

  // Build full payload
  const payload = {
    origin: true,
    url: pickedOrigin,
    w_start,
    w_end,
    fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: "crux_api"
  };

  // For each metric returned, store raw + derived stats
  for (const [metricName, m] of Object.entries(rec.metrics)) {
    const hist = m.histogram || [];
    const p75  = m.percentiles?.p75 ?? null;

    const { good, ok, poor } = shares(metricName, hist);

    // Full raw + derived under the metric key
    payload[metricName] = {
      p75,
      histogram: hist,     // keep entire histogram from API
      shares: { good, ok, poor }
    };

    // Convenience top-level fields (like your old lcp_good) for dashboard usage
    const short = SHORT[metricName];
    if (short) {
      payload[`${short}_good`] = (good ?? null); // 0..1
      payload[`${short}_ok`]   = (ok ?? null);
      payload[`${short}_poor`] = (poor ?? null);
      payload[`${short}_p75`]  = (p75 ?? null);  // raw units (ms for most, unitless for CLS)
    }
  }

  // Write the daily snapshot
  await metricsDocRef.collection("daily-crux").doc(dayId).set(payload, { merge: false });

  console.log(`OK: metrics/${TARGET_DOC_ID}/daily-crux/${dayId} for ${pickedOrigin}`);
}

run().catch(err => { console.error(err); process.exit(1); });
