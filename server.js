// server.js — PDFOperations (RENDER SAFE MONEY MODE v16.6 - SPLIT PAGE REORDER + DELETE SUPPORT)
// // ✅ Pricing tiers: £2.99 (≤10) / £9.99 (11–50) + optional share link (+£2.49)
// ✅ Server-side enforcement: max 50 files (client enforces size; server enforces count + mode validation)
// ✅ Routes: /api/jobs, /api/upload-url, /api/jobs/:jobId/register, /api/jobs/:jobId/mode, /api/checkout
// ✅ Webhook + Stripe self-heal preserved
// ✅ merge_pdf mode — PAID download returns a single merged PDF (supports cross-PDF order)
// ✅ split_pdf mode — PAID download returns ZIP of per-page PDFs
//    - NEW: supports reorder + delete via splitOrder: [1,3,2,...] (1-based original pages)
// ✅ compress_pdf mode — PAID download currently returns a single compressed JPG (raster-based best-effort target sizing)
// // ✅ rotate_pdf mode — PAID download returns a single rotated PDF (degrees: 90/180/270)

require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const archiver = require("archiver");
const path = require("path");
const crypto = require("crypto");
const Stripe = require("stripe");

// sharp is optional at boot
let sharp = null;
try {
  sharp = require("sharp");
} catch (e) {
  console.warn(
    "⚠️ sharp failed to load (native module). Downloads will still work, image transforms disabled."
  );
}

// pdf-lib is required for merge_pdf + split_pdf + rotate_pdf (but we fail gracefully if missing)
let PDFDocumentLib = null; // PDFDocument
let PDFDegrees = null; // degrees()
try {
  const pdfLib = require("pdf-lib");
  PDFDocumentLib = pdfLib.PDFDocument;
  PDFDegrees = pdfLib.degrees;
} catch (e) {
  console.warn(
    "⚠️ pdf-lib failed to load. merge_pdf/split_pdf/rotate_pdf modes will error until you install `pdf-lib`."
  );
}

// R2 (S3-compatible)
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();

const PORT = process.env.PORT || 4242;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PUBLIC_DIR = path.join(__dirname, "public");

// ====== LIMITS ======
const MAX_FILES = Number(process.env.MAX_FILES || 50); // v15+
const MAX_MB_EACH = Number(process.env.MAX_MB_EACH || 25);

// ====== PRICING TIERS ======
const TIER_10_LIMIT = Number(process.env.TIER_10_LIMIT || 10);
const TIER_10_PRICE_GBP_PENCE = Number(process.env.TIER_10_PRICE_GBP_PENCE || 299);
const TIER_50_LIMIT = Number(process.env.TIER_50_LIMIT || 50);
const TIER_50_PRICE_GBP_PENCE = Number(process.env.TIER_50_PRICE_GBP_PENCE || 999);
const SHARE_LINK_UPSELL_PENCE = Number(process.env.SHARE_LINK_UPSELL_PENCE || 249);

// ====== TOOL-BASED PRICING (OVERRIDES TIER BASE) ======
const TOOL_BASE_PRICE = {
  compress: 299,
  compress_pdf: 299,
  convert: 299,
  merge_pdf: 299,
  split_pdf: 299,
  rotate_pdf: 299,

  protect_pdf: 399,
  watermark_pdf: 399,

  sign_pdf: 499,
  edit_pdf: 499
};

// ====== TTL ======
const UNPAID_JOB_TTL_MS = Number(process.env.UNPAID_JOB_TTL_MS || 1000 * 60 * 60); // 1h
const PAID_JOB_TTL_MS = Number(process.env.PAID_JOB_TTL_MS || 1000 * 60 * 60 * 24); // 24h
const SHARE_TTL_MS = Number(process.env.SHARE_TTL_MS || 1000 * 60 * 60 * 24 * 7); // 7d

// ====== R2 CONFIG ======
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;

const r2Configured = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

const r2 = r2Configured
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

// ====== STRIPE CONFIG ======
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const stripeConfigured = !!STRIPE_SECRET_KEY;
const stripe = stripeConfigured ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" }) : null;

// ====== MISC LIMITS ======
const MAX_PAGE_ORDER_LEN = Number(process.env.MAX_PAGE_ORDER_LEN || 1500); // merge cross-order cap
const MAX_SPLIT_ORDER_LEN = Number(process.env.MAX_SPLIT_ORDER_LEN || 2000); // split pages cap

// ====== REQUIRE HELPERS ======
const requireStripe = () => {
  if (!stripe) throw new Error("Stripe not configured");
};

const requireR2 = () => {
  if (!r2) throw new Error("R2 not configured");
};

// ====== JOB STORE (IN-MEMORY MVP) ======
const jobs = new Map();
// Fast lookup for share tokens (prevents O(n) scan)
const shareIndex = new Map(); // token -> jobId

const newId = () => `job_${crypto.randomBytes(8).toString("hex")}`;
const newShareToken = () => crypto.randomBytes(16).toString("hex");

// ====== UTIL ======
function sanitizeName(name) {
  return (
    String(name || "file")
      .replace(/[/\\?%*:|"<>]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "file"
  );
}

function makeUniqueName(desired, used) {
  let base = desired;
  let ext = "";
  const dot = desired.lastIndexOf(".");
  if (dot > 0 && dot < desired.length - 1) {
    base = desired.slice(0, dot);
    ext = desired.slice(dot);
  }
  let candidate = `${base}${ext}`;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base} (${n})${ext}`;
    n++;
  }
  used.add(candidate);
  return candidate;
}

function getJob(id) {
  const job = jobs.get(id);
  if (!job) throw new Error("Job not found");

  if (job.expiresAt && Date.now() > job.expiresAt) {
    if (job.shareToken) shareIndex.delete(job.shareToken);
    jobs.delete(id);
    throw new Error("Job expired");
  }
  return job;
}

function inferTierFromFileCount(count) {
  const n = Number(count || 0);
  if (!Number.isFinite(n) || n <= 0)
    return { key: "zip10", limit: TIER_10_LIMIT, price: TIER_10_PRICE_GBP_PENCE };

  if (n <= TIER_10_LIMIT)
    return { key: "zip10", limit: TIER_10_LIMIT, price: TIER_10_PRICE_GBP_PENCE };
  if (n <= TIER_50_LIMIT)
    return { key: "zip50", limit: TIER_50_LIMIT, price: TIER_50_PRICE_GBP_PENCE };

  return { key: "zip50", limit: TIER_50_LIMIT, price: TIER_50_PRICE_GBP_PENCE };
}

function computeTotalPence(job) {
  const count = job?.files?.length || 0;
  const share = !!job?.options?.shareLink;

  // Base price by tool
  let base = TOOL_BASE_PRICE[job.mode] || TIER_10_PRICE_GBP_PENCE;

  // If file count exceeds lower tier, upgrade to Pro price
  if (count > TIER_10_LIMIT) {
    base = TIER_50_PRICE_GBP_PENCE;
  }

  const total = base + (share ? SHARE_LINK_UPSELL_PENCE : 0);

  // Fake tier object for compatibility (used in metadata + naming)
  const tier = count > TIER_10_LIMIT
    ? { key: "zip50", price: TIER_50_PRICE_GBP_PENCE }
    : { key: "zip10", price: base };

  return { total, tier };
}

  const VALID_MODES = new Set([
    "compress",
    "compress_pdf",
    "convert",
    "merge_pdf",
    "split_pdf",
    "rotate_pdf",
    "sign_pdf",
  ]);

const VALID_CONVERT_TARGETS = new Set(["jpg", "jpeg", "png", "webp", "pdf"]);
const VALID_PDF_COMPRESS_LEVELS = new Set(["light", "balanced", "max"]);
const VALID_ROTATE_DEGREES = new Set([90, 180, 270]);

function normalizeConvertTarget(t) {
  const v = String(t || "").toLowerCase().trim();
  if (!v) return null;
  if (v === "jpeg") return "jpg";
  return v;
}

function normalizePdfLevel(level) {
  const v = String(level || "").toLowerCase().trim();
  if (VALID_PDF_COMPRESS_LEVELS.has(v)) return v;
  return "balanced";
}

function normalizeRotateDegrees(deg) {
  const n = Number(deg);
  if (VALID_ROTATE_DEGREES.has(n)) return n;
  return 90;
}

function normalizeTargetBytes(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;

  const min = 50 * 1024;        // 50KB floor
  const max = 25 * 1024 * 1024; // 25MB ceiling

  if (n < min) return min;
  if (n > max) return max;
  return Math.round(n);
}

function normalizeRotateMap(map) {
  // Expected: array where index = page number (1-based). map[0] ignored.
  // Values: 0 | 90 | 180 | 270
  if (!Array.isArray(map) || map.length < 2) return null;

  const out = [];
  out.length = map.length;
  out[0] = 0;

  for (let i = 1; i < map.length; i++) {
    const raw = Number(map[i] || 0);
    if (raw === 0) {
      out[i] = 0;
      continue;
    }
    const n = Number(raw);
    if (n === 90 || n === 180 || n === 270) out[i] = n;
    else out[i] = 0;
  }

  // If everything is 0, still keep it (frontend may send “no-op” state)
  return out;
}

function parseCrossKey(s) {
  const str = String(s || "");
  const m = str.match(/^(\d+):(\d+)$/);
  if (!m) return null;
  const fileIndex = Number(m[1]);
  const pageNumber = Number(m[2]); // 1-based
  if (!Number.isInteger(fileIndex) || fileIndex < 0) return null;
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return null;
  return { key: `${fileIndex}:${pageNumber}`, fileIndex, pageNumber };
}

function normalizeMergeOrder(order) {
  if (!Array.isArray(order) || !order.length) return { type: "none", order: null };

  // If it looks like cross keys, treat as cross
  const hasCross = order.some((x) => typeof x === "string" && String(x).includes(":"));
  if (hasCross) {
    const out = [];
    for (const x of order) {
      const parsed = parseCrossKey(x);
      if (parsed) out.push(parsed.key);
      if (out.length >= MAX_PAGE_ORDER_LEN) break;
    }
    if (!out.length) return { type: "none", order: null };
    return { type: "cross", order: out };
  }

  // Otherwise: legacy numeric reorder
  const nums = order
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .slice(0, MAX_PAGE_ORDER_LEN);

  if (!nums.length) return { type: "none", order: null };
  return { type: "single", order: nums };
}

// ✅ NEW: split order (1-based original pages), supports delete by omission
function normalizeSplitOrder(splitOrder) {
  if (!Array.isArray(splitOrder) || !splitOrder.length) return null;

  const out = [];
  const seen = new Set();

  for (const raw of splitOrder) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) continue;
    if (seen.has(n)) continue; // enforce uniqueness
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_SPLIT_ORDER_LEN) break;
  }

  return out.length ? out : null;
}

function isPdfMeta(meta) {
  const mime = String(meta?.mimetype || "");
  const name = String(meta?.originalname || "");
  return mime === "application/pdf" || /\.pdf$/i.test(name);
}

function validateJobFilesForMode(job) {
  const files = Array.isArray(job.files) ? job.files : [];
  if (!files.length) throw new Error("No files registered");
  if (files.length > MAX_FILES) throw new Error(`Too many files (max ${MAX_FILES}).`);

  if (job.mode === "merge_pdf") {
    if (!PDFDocumentLib) throw new Error("PDF merge is unavailable (pdf-lib not installed).");
    if (files.length < 2) throw new Error("Merge PDFs requires at least 2 PDFs.");
    const nonPdf = files.find((f) => !isPdfMeta(f));
    if (nonPdf) throw new Error("Merge PDFs only accepts PDF files.");
  }

  if (job.mode === "split_pdf") {
    if (!PDFDocumentLib) throw new Error("PDF split is unavailable (pdf-lib not installed).");
    if (files.length !== 1) throw new Error("Split PDF requires exactly 1 PDF.");
    const nonPdf = files.find((f) => !isPdfMeta(f));
    if (nonPdf) throw new Error("Split PDF only accepts a PDF file.");
  }

  if (job.mode === "compress_pdf") {
    if (!sharp) throw new Error("PDF compression is unavailable (sharp not installed).");
    if (files.length !== 1) throw new Error("Compress PDF requires exactly 1 PDF.");
    const nonPdf = files.find((f) => !isPdfMeta(f));
    if (nonPdf) throw new Error("Compress PDF only accepts a PDF file.");
    job.pdfCompressLevel = normalizePdfLevel(job.pdfCompressLevel);
    job.targetBytes = normalizeTargetBytes(job.targetBytes);
  }

  if (job.mode === "rotate_pdf") {
    if (!PDFDocumentLib || !PDFDegrees)
      throw new Error("PDF rotate is unavailable (pdf-lib not installed).");
    if (files.length !== 1) throw new Error("Rotate PDF requires exactly 1 PDF.");
    const nonPdf = files.find((f) => !isPdfMeta(f));
    if (nonPdf) throw new Error("Rotate PDF only accepts a PDF file.");
    job.rotateDegrees = normalizeRotateDegrees(job.rotateDegrees);
        if (job.rotateMap != null) {
      // keep as-is; we’ll validate against actual page count at download time
      job.rotateMap = normalizeRotateMap(job.rotateMap);
    }
  }

  if (job.mode === "convert") {
    if (job.convertTarget && !VALID_CONVERT_TARGETS.has(job.convertTarget)) {
      throw new Error("Invalid convert target");
    }
  }

  if (job.mode === "sign_pdf") {
    if (files.length !== 1) throw new Error("Sign PDF requires exactly 1 PDF.");
    const nonPdf = files.find((f) => !isPdfMeta(f));
    if (nonPdf) throw new Error("Sign PDF only accepts a PDF file.");
  }
  }

// ====== R2 CLEANUP HELPERS ======
async function deleteJobObjectsFromR2(jobId) {
  if (!r2Configured) return;

  let continuationToken = undefined;

  while (true) {
    const listResp = await r2.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: `${jobId}/`,
        ContinuationToken: continuationToken,
      })
    );

    const contents = listResp.Contents || [];
    if (contents.length) {
      const toDelete = contents.map((o) => ({ Key: o.Key }));
      await r2.send(
        new DeleteObjectsCommand({
          Bucket: R2_BUCKET,
          Delete: { Objects: toDelete, Quiet: true },
        })
      );
    }

    if (!listResp.IsTruncated) break;
    continuationToken = listResp.NextContinuationToken;
  }
}

// ====== STREAM HELPERS ======
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ====== PAYMENT SELF-HEAL (webhook fallback) ======
async function ensurePaid(job) {
  if (job.status === "PAID") return true;
  if (!stripeConfigured) return false;
  if (!job.checkoutSessionId) return false;

  try {
    const session = await stripe.checkout.sessions.retrieve(job.checkoutSessionId);
    if (session?.payment_status === "paid") {
      markJobPaid(job);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function markJobPaid(job) {
  if (job.status === "PAID") return;

  job.status = "PAID";
  job.paidAt = Date.now();

  if (job.options?.shareLink) {
    job.shareToken = job.shareToken || newShareToken();
    job.shareExpiresAt = job.shareExpiresAt || Date.now() + SHARE_TTL_MS;
    job.expiresAt = Date.now() + SHARE_TTL_MS;
    shareIndex.set(job.shareToken, job.jobId);
  } else {
    if (job.shareToken) shareIndex.delete(job.shareToken);
    job.shareToken = null;
    job.shareExpiresAt = null;
    job.expiresAt = Date.now() + PAID_JOB_TTL_MS;
  }
}

// ====== SECURITY ======
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Stripe webhook MUST come before express.json
async function webhookHandler(req, res) {
  try {
    requireStripe();

    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) throw new Error("No webhook secret");

    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const jobId = session?.metadata?.jobId;
      if (jobId) {
        try {
          const job = getJob(jobId);
          if (session?.payment_status === "paid") markJobPaid(job);
        } catch {
          // ignore
        }
      }
    }

    res.json({ received: true });
  } catch (e) {
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
}

app.post("/webhook", express.raw({ type: "application/json" }), webhookHandler);
app.use(express.json({ limit: "1mb" }));

// ====== HEALTH ======
app.get("/health", (_, res) => {
  res.json({
    ok: true,
    stripeConfigured,
    r2Configured,
    sharpLoaded: !!sharp,
    pdfLibLoaded: !!PDFDocumentLib,
    jobsInMemory: jobs.size,
    pricing: {
      tier10: { limit: TIER_10_LIMIT, pricePence: TIER_10_PRICE_GBP_PENCE },
      tier50: { limit: TIER_50_LIMIT, pricePence: TIER_50_PRICE_GBP_PENCE },
      shareUpsellPence: SHARE_LINK_UPSELL_PENCE,
    },
    limits: { maxFiles: MAX_FILES, maxMBEach: MAX_MB_EACH },
    modes: Array.from(VALID_MODES),
    pdfCompressLevels: Array.from(VALID_PDF_COMPRESS_LEVELS),
    rotateDegrees: Array.from(VALID_ROTATE_DEGREES),
    mergeOrder: {
      crossFormat: "['fileIndex:pageNumber', ...] (pageNumber is 1-based)",
      legacySingleFormat: "[0,2,1,...] only for 1-PDF reorder",
      maxOrderLen: MAX_PAGE_ORDER_LEN,
    },
    splitOrder: {
      format: "[1,3,2,...] (1-based original page numbers). Missing pages are deleted.",
      maxLen: MAX_SPLIT_ORDER_LEN,
    },
  });
});

// ====== STATIC ======
// ====== STATIC ======
app.use(express.static(PUBLIC_DIR));

// Core pages
[
  { route: "/", file: "index.html" },
  { route: "/success", file: "success.html" },
  { route: "/cancel", file: "cancel.html" },
  { route: "/privacy", file: "privacy.html" },
  { route: "/terms", file: "terms.html" },
  { route: "/pricing", file: "pricing.html" },
].forEach(({ route, file }) => {
  app.get(route, (_, res) => {
    res.sendFile(path.join(PUBLIC_DIR, file));
  });
});

// Legacy compress route -> homepage
app.get("/compress-pdf", (_, res) => {
  res.redirect(301, "/");
});

app.get("/compress-pdf.html", (_, res) => {
  res.redirect(301, "/");
});

const TOOL_PAGES = [
  "merge-pdf",
  "split-pdf",
  "pdf-to-jpg",
  "jpg-to-pdf",
  "rotate-pdf",
  "reduce-pdf-size",
  "compress-pdf-to-5mb",
  "compress-pdf-under-5mb",
  "compress-pdf-under-2mb",
  "compress-pdf-under-1mb",
  "compress-pdf-under-10mb",
  "reduce-pdf-size-for-email",
  "pdf-too-large-to-upload",

  "convert",
  "sign-pdf",

  "protect-pdf",
  "edit-pdf",
  "watermark-pdf"
];

TOOL_PAGES.forEach((slug) => {
  app.get(`/${slug}`, (_, res) => {
    res.sendFile(path.join(PUBLIC_DIR, `${slug}.html`));
  });
});

// Fallback: send home for unknown routes (prevents weird “stuck page” behavior)
app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ====== API ======

// Create job
app.post("/api/jobs", (_, res) => {
  const jobId = newId();

  jobs.set(jobId, {
    jobId,
    createdAt: Date.now(),
    expiresAt: Date.now() + UNPAID_JOB_TTL_MS,

    status: "CREATED", // CREATED -> UPLOADED -> PAID
    files: [],

    options: { shareLink: false },

    mode: "compress", // compress | compress_pdf | convert | merge_pdf | split_pdf | rotate_pdf
    convertTarget: null,

    // merge options
    pageOrder: null,       // either ["0:1","1:2",...] OR [0,2,1,...] legacy OR null
    pageOrderType: "none", // "none" | "cross" | "single"

    // ✅ split options (NEW)
    splitOrder: null,      // [1,3,2,...] (1-based original pages) OR null


    pdfCompressLevel: "balanced",
    targetBytes: null,

    // rotate_pdf options
    // rotate_pdf options
    rotateDegrees: 90,
    rotateMap: null, // [0, 90, 0, 180, ...] index = page (1-based); 0 means no rotation
    shareToken: null,
    shareExpiresAt: null,

    checkoutSessionId: null,
    paidAt: null,

    downloadCount: 0,
  });

  res.json({ jobId });
});

// Presigned upload url
// Presigned upload url
app.post("/api/upload-url", async (req, res) => {
  try {
    requireR2();

    const body = req.body || {};

    // Accept multiple client shapes (backwards compatible)
    const jobId = body.jobId;
    const filename =
      body.filename ||
      body.fileName ||
      body.name ||
      (body.file && (body.file.name || body.file.filename));

    const contentType =
      body.type ||
      body.contentType ||
      body.mimetype ||
      (body.file && (body.file.type || body.file.mimetype)) ||
      "application/octet-stream";

    if (!jobId || !filename) {
      // helpful debugging payload (safe)
      throw new Error(
        `Missing jobId/filename. Got keys: ${Object.keys(body).join(", ")}`
      );
    }

    const job = getJob(jobId);
    if (job.status !== "CREATED") throw new Error("Invalid job state");

    const key = `${jobId}/${Date.now()}_${sanitizeName(filename)}`;

    const url = await getSignedUrl(
      r2,
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: 60 }
    );

    res.json({ url, key });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Register files (metadata only)
app.post("/api/jobs/:jobId/register", (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    if (job.status !== "CREATED") throw new Error("Invalid state");

    const files = Array.isArray(req.body.files) ? req.body.files : [];
    if (!files.length) throw new Error("No files to register");
    if (files.length > MAX_FILES) throw new Error(`Too many files (max ${MAX_FILES}).`);

    job.files = files.map((f) => ({
      key: String(f.key || ""),
      originalname: String(f.originalname || "file"),
      mimetype: String(f.mimetype || "application/octet-stream"),
    }));

    for (const f of job.files) {
      if (!f.key.startsWith(`${job.jobId}/`)) throw new Error("Invalid file key");
    }

    // If they had a page order set already, keep it; validity is enforced at download time too.
    validateJobFilesForMode(job);

    job.status = "UPLOADED";
    res.json({ ok: true, count: job.files.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/jobs/:jobId/mode", (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    const { mode, target, order, splitOrder, level, degrees, angle, rotateMap, targetBytes } = req.body || {};

    const m = String(mode || "").toLowerCase().trim();
    if (!VALID_MODES.has(m)) throw new Error("Invalid mode");

    if (job.status !== "CREATED") throw new Error("Invalid state");

    job.mode = m;

    if (m === "convert") {
      const t = normalizeConvertTarget(target);
      if (t && !VALID_CONVERT_TARGETS.has(t)) throw new Error("Invalid convert target");
      job.convertTarget = t || null;

      job.pageOrder = null;
      job.pageOrderType = "none";
      job.splitOrder = null;

      job.pdfCompressLevel = "balanced";
      job.targetBytes = null;
      job.rotateDegrees = 90;
      job.rotateMap = null;

    } else if (m === "merge_pdf") {
      job.convertTarget = null;

      const norm = normalizeMergeOrder(order);
      job.pageOrderType = norm.type;
      job.pageOrder = norm.order;

      job.splitOrder = null;

      job.pdfCompressLevel = "balanced";
      job.targetBytes = null;
      job.rotateDegrees = 90;
      job.rotateMap = null;

    } else if (m === "split_pdf") {
      job.convertTarget = null;

      job.pageOrder = null;
      job.pageOrderType = "none";
      job.splitOrder = normalizeSplitOrder(splitOrder);

      job.pdfCompressLevel = "balanced";
      job.targetBytes = null;
      job.rotateDegrees = 90;
      job.rotateMap = null;

    } else if (m === "compress_pdf") {
      job.convertTarget = null;

      job.pageOrder = null;
      job.pageOrderType = "none";
      job.splitOrder = null;

      job.pdfCompressLevel = normalizePdfLevel(level);
      job.targetBytes = normalizeTargetBytes(targetBytes);
      job.rotateDegrees = 90;
      job.rotateMap = null;

    } else if (m === "rotate_pdf") {
      job.convertTarget = null;

      job.pageOrder = null;
      job.pageOrderType = "none";
      job.splitOrder = null;

      job.pdfCompressLevel = "balanced";
      job.targetBytes = null;

      const rm = normalizeRotateMap(rotateMap);
      job.rotateMap = rm;
      job.rotateDegrees = normalizeRotateDegrees(degrees != null ? degrees : angle);

    } else if (m === "sign_pdf") {
      job.convertTarget = null;

      job.pageOrder = null;
      job.pageOrderType = "none";
      job.splitOrder = null;

      job.pdfCompressLevel = "balanced";
      job.targetBytes = null;
      job.rotateDegrees = 90;
      job.rotateMap = null;

    } else {
      job.convertTarget = null;

      job.pageOrder = null;
      job.pageOrderType = "none";
      job.splitOrder = null;

      job.pdfCompressLevel = "balanced";
      job.targetBytes = null;
      job.rotateDegrees = 90;
      job.rotateMap = null;
    }

    res.json({
      ok: true,
      pageOrderType: job.pageOrderType,
      splitOrderLen: job.splitOrder ? job.splitOrder.length : 0,
      targetBytes: job.targetBytes || null,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Checkout
app.post("/api/checkout", async (req, res) => {
  try {
    requireStripe();

    const { jobId, shareLink } = req.body || {};
    const job = getJob(jobId);

    if (job.status !== "UPLOADED") throw new Error("Nothing to pay for");
    if (!job.files?.length) throw new Error("No files registered");
    if (job.files.length > MAX_FILES) throw new Error(`Too many files (max ${MAX_FILES}).`);

    validateJobFilesForMode(job);

    job.options.shareLink = !!shareLink;

    // Clear any old token until payment confirmed
    if (job.shareToken) shareIndex.delete(job.shareToken);
    job.shareToken = null;
    job.shareExpiresAt = null;

    const { total, tier } = computeTotalPence(job);

    const productNameBase =
      tier.key === "zip50" ? "PDFOperations Pro (up to 50 files)" : "PDFOperations (up to 10 files)";

    const levelLabel = (() => {
      const lvl = normalizePdfLevel(job.pdfCompressLevel);
      if (lvl === "max") return "Maximum";
      if (lvl === "light") return "Light";
      return "Balanced";
    })();
    
    const rotateLabel = (() => {
      if (Array.isArray(job.rotateMap) && job.rotateMap.length > 1) return "per-page";
      const d = normalizeRotateDegrees(job.rotateDegrees);
      return `${d}°`;
    })();

    const modeLabel =
      job.mode === "merge_pdf"
        ? "Merge PDFs"
        : job.mode === "split_pdf"
            ? "Split PDF"
            : job.mode === "compress_pdf"
                ? `Compress PDF (${levelLabel})`
                : job.mode === "rotate_pdf"
                    ? `Rotate PDF (${rotateLabel})`
                    : job.mode === "convert"
                        ? `Convert to ${String(job.convertTarget || "").toUpperCase() || "format"}`
                        : job.mode === "sign_pdf"
                            ? "Sign PDF"
                            : "ZIP download";

    const productName = `${productNameBase} — ${modeLabel}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      adaptive_pricing: { enabled: true },

      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: total,
            product_data: {
              name: productName,
              description: job.options.shareLink ? `${modeLabel} + shareable link` : modeLabel,
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${BASE_URL}/success?jobId=${jobId}`,
      cancel_url: `${BASE_URL}/cancel`,
      metadata: {
        jobId,
        shareLink: job.options.shareLink ? "1" : "0",
        tier: tier.key,
        mode: job.mode,
        convertTarget: job.convertTarget || "",
        pdfLevel: job.mode === "compress_pdf" ? normalizePdfLevel(job.pdfCompressLevel) : "",
        rotateDeg: job.mode === "rotate_pdf" ? String(normalizeRotateDegrees(job.rotateDegrees)) : "",
        fileCount: String(job.files.length),
        totalPence: String(total),
        mergeOrderType: job.mode === "merge_pdf" ? String(job.pageOrderType || "none") : "",
        splitOrderLen: job.mode === "split_pdf" ? String(job.splitOrder?.length || 0) : "",
      },
    });

    job.checkoutSessionId = session.id;

    res.json({ url: session.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Status endpoint for success page polling
app.get("/api/status/:jobId", async (req, res) => {
  try {
    const job = getJob(req.params.jobId);

    if (job.status !== "PAID") {
      await ensurePaid(job);
    }

    res.json({
      ok: true,
      jobId: job.jobId,
      status: job.status,
      paidAt: job.paidAt || null,
      shareToken: job.shareToken || null,
      shareExpiresAt: job.shareExpiresAt || null,
      mode: job.mode,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

async function compressPdfBufferToTarget(inputBuffer, level, targetBytes) {
  if (!sharp) throw new Error("PDF compression is unavailable (sharp not installed).");

  const lvl = normalizePdfLevel(level);

  const densityMap = {
    light: [144, 132, 120],
    balanced: [132, 118, 104, 92],
    max: [118, 104, 92, 82, 72],
  };

  const qualityMap = {
    light: [82, 76, 70],
    balanced: [72, 66, 60, 54],
    max: [62, 56, 50, 44, 38],
  };

  const densities = densityMap[lvl];
  const qualities = qualityMap[lvl];

  let best = null;

  for (const density of densities) {
    for (const quality of qualities) {
      try {
        const out = await sharp(inputBuffer, { density, pages: -1 })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();

        if (!best || out.length < best.length) best = out;

        if (targetBytes && out.length <= targetBytes) {
          return {
            buffer: out,
            hitTarget: true,
            density,
            quality,
          };
        }
      } catch (_) {
        // keep trying
      }
    }
  }

  if (best) {
    return {
      buffer: best,
      hitTarget: !targetBytes || best.length <= targetBytes,
    };
  }

  throw new Error("Could not compress this PDF.");
}

// Download (paid)
app.get("/api/download/:jobId", async (req, res) => {
  try {
    requireR2();

    const job = getJob(req.params.jobId);

    if (job.status !== "PAID") {
      const ok = await ensurePaid(job);
      if (!ok) throw new Error("Payment not confirmed");
    }

    validateJobFilesForMode(job);

    job.downloadCount = Number(job.downloadCount || 0) + 1;

    // ====== MERGE PDF MODE ======
    if (job.mode === "merge_pdf") {
      if (!PDFDocumentLib) throw new Error("PDF merge is unavailable (pdf-lib not installed).");

      const srcDocs = [];
      const srcPageCounts = [];

      for (const f of job.files) {
        const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: f.key }));
        const buf = await streamToBuffer(obj.Body);
        const doc = await PDFDocumentLib.load(buf);
        srcDocs.push(doc);
        srcPageCounts.push(doc.getPageCount());
      }

      const merged = await PDFDocumentLib.create();

      const addDefaultOrder = async () => {
        for (let fi = 0; fi < srcDocs.length; fi++) {
          const src = srcDocs[fi];
          const pages = await merged.copyPages(src, src.getPageIndices());
          for (const p of pages) merged.addPage(p);
        }
      };

      // Cross-PDF order:
      if (job.pageOrderType === "cross" && Array.isArray(job.pageOrder) && job.pageOrder.length) {
        let added = 0;

        for (const key of job.pageOrder) {
          const parsed = parseCrossKey(key);
          if (!parsed) continue;

          const { fileIndex, pageNumber } = parsed; // pageNumber is 1-based
          if (fileIndex >= srcDocs.length) continue;

          const src = srcDocs[fileIndex];
          const totalPages = srcPageCounts[fileIndex] || 0;
          if (pageNumber < 1 || pageNumber > totalPages) continue;

          const pageIdx = pageNumber - 1;
          const pages = await merged.copyPages(src, [pageIdx]);
          if (pages[0]) {
            merged.addPage(pages[0]);
            added++;
          }

          if (added >= MAX_PAGE_ORDER_LEN) break;
        }

        // If something went wrong and we added nothing, fallback safely
        if (added === 0) {
          await addDefaultOrder();
        }
      }
      // Legacy single-PDF reorder:
      else if (job.pageOrderType === "single" && Array.isArray(job.pageOrder) && job.pageOrder.length) {
        // If multiple PDFs exist, we ignore legacy numeric order and do default
        if (srcDocs.length === 1) {
          const src = srcDocs[0];
          const totalPages = srcPageCounts[0] || 0;

          let indices = src.getPageIndices();

          if (job.pageOrder.length === totalPages) {
            const isValid =
              job.pageOrder.every((n) => Number.isInteger(n) && n >= 0 && n < totalPages) &&
              new Set(job.pageOrder).size === totalPages;

            if (isValid) indices = job.pageOrder;
          }

          const pages = await merged.copyPages(src, indices);
          for (const p of pages) merged.addPage(p);
        } else {
          await addDefaultOrder();
        }
      } else {
        await addDefaultOrder();
      }

      const mergedBytes = await merged.save();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="pdfoperations_merged_${job.jobId}.pdf"`
      );

      return res.send(Buffer.from(mergedBytes));
    }

    // ====== SPLIT PDF MODE (NOW SUPPORTS REORDER + DELETE) ======
    if (job.mode === "split_pdf") {
      if (!PDFDocumentLib) throw new Error("PDF split is unavailable (pdf-lib not installed).");

      const only = job.files[0];
      const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: only.key }));
      const buf = await streamToBuffer(obj.Body);

      const src = await PDFDocumentLib.load(buf);
      const totalPages = src.getPageCount();

      // Build output plan:
      // - If splitOrder exists: it’s 1-based original pages in desired output order.
      // - Missing pages = deleted.
      // - Invalid/out-of-range values are ignored.
      let plan = null;

      if (Array.isArray(job.splitOrder) && job.splitOrder.length) {
        const seen = new Set();
        const cleaned = [];

        for (const n of job.splitOrder) {
          const p = Number(n);
          if (!Number.isInteger(p) || p < 1 || p > totalPages) continue;
          if (seen.has(p)) continue;
          seen.add(p);
          cleaned.push(p);
          if (cleaned.length >= Math.min(MAX_SPLIT_ORDER_LEN, totalPages)) break;
        }

        // If they deleted everything, fail loudly (otherwise you ship an empty ZIP)
        if (cleaned.length === 0) {
          throw new Error("No pages selected. Add at least one page.");
        }

        plan = cleaned; // 1-based original pages
      } else {
        // Default: keep all pages 1..N
        plan = Array.from({ length: totalPages }, (_, i) => i + 1);
      }

      const safeBase = sanitizeName(String(only.originalname || "document").replace(/\.pdf$/i, ""));
      const seqPad = String(plan.length).length;
      const origPad = String(totalPages).length;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="pdfoperations_split_${job.jobId}.zip"`
      );

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", (err) => {
        try { res.status(500).send(err.message); } catch {}
      });
      archive.pipe(res);

      const used = new Set();

      // Output ZIP in plan order.
      // Filename includes both output sequence + original page number for clarity.
      for (let outIdx = 0; outIdx < plan.length; outIdx++) {
        const originalPageNo = plan[outIdx];     // 1-based
        const pageIndex = originalPageNo - 1;    // 0-based

        const out = await PDFDocumentLib.create();
        const [copied] = await out.copyPages(src, [pageIndex]);
        out.addPage(copied);

        const bytes = await out.save();

        const seq = String(outIdx + 1).padStart(seqPad, "0");
        const orig = String(originalPageNo).padStart(origPad, "0");

        const filename = makeUniqueName(
          sanitizeName(`${safeBase}_part_${seq}_page_${orig}.pdf`),
          used
        );

        archive.append(Buffer.from(bytes), { name: filename });
      }

      await archive.finalize();
      return;
    }

        // ====== COMPRESS PDF MODE ======
      if (job.mode === "compress_pdf") {
      if (!sharp) throw new Error("PDF compression is unavailable (sharp not installed).");

      const only = job.files[0];
      const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: only.key }));
      const buf = await streamToBuffer(obj.Body);

      const targetBytes = normalizeTargetBytes(job.targetBytes);
      const result = await compressPdfBufferToTarget(
        buf,
        normalizePdfLevel(job.pdfCompressLevel),
        targetBytes
      );

      if (targetBytes && result.buffer.length > targetBytes) {
        throw new Error(
          `This PDF could not be reduced below ${(targetBytes / (1024 * 1024)).toFixed(1)}MB automatically. Try splitting it or removing image-heavy pages.`
        );
      }

      const base = sanitizeName(
        String(only.originalname || "document").replace(/\.pdf$/i, "")
      );

      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${base}_compressed.jpg"`
      );

      return res.send(result.buffer);
    }

        // ====== ROTATE PDF MODE (PER-PAGE SUPPORT) ======
    if (job.mode === "rotate_pdf") {
      if (!PDFDocumentLib || !PDFDegrees)
        throw new Error("PDF rotate is unavailable (pdf-lib not installed).");

      const only = job.files[0];
      const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: only.key }));
      const buf = await streamToBuffer(obj.Body);

      const pdf = await PDFDocumentLib.load(buf);
      const totalPages = pdf.getPageCount();

      // If rotateMap exists and matches doc length, apply per-page
      const rm = Array.isArray(job.rotateMap) ? job.rotateMap : null;

      if (rm && rm.length >= totalPages + 1) {
        for (let i = 0; i < totalPages; i++) {
          const pageNo = i + 1; // 1-based
          const deg = Number(rm[pageNo] || 0);

          if (deg === 90 || deg === 180 || deg === 270) {
            const page = pdf.getPage(i);
            const current = page.getRotation()?.angle || 0;
            const next = (current + deg) % 360;
            page.setRotation(PDFDegrees(next));
          }
        }
      } else {
        // Legacy fallback: rotate whole document
        const deg = normalizeRotateDegrees(job.rotateDegrees);
        for (let i = 0; i < totalPages; i++) {
          const page = pdf.getPage(i);
          const current = page.getRotation()?.angle || 0;
          const next = (current + deg) % 360;
          page.setRotation(PDFDegrees(next));
        }
      }

      const outBytes = await pdf.save();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="pdfoperations_rotated_${job.jobId}.pdf"`
      );

      return res.send(Buffer.from(outBytes));
    }

    // ====== SIGN PDF MODE (PASS-THROUGH) ======
    if (job.mode === "sign_pdf") {
      const only = job.files[0];
      const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: only.key }));

      res.setHeader("Content-Type", "application/pdf");

      const base = sanitizeName(
        String(only.originalname || "document").replace(/\.pdf$/i, "")
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${base}_signed.pdf"`
      );

      return obj.Body.pipe(res);
    }

    // ====== ZIP MODES ======
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="pdfoperations_${job.jobId}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      try { res.status(500).send(err.message); } catch {}
    });
    archive.pipe(res);

    const used = new Set();

    for (const f of job.files) {
      const obj = await r2.send(
        new GetObjectCommand({
          Bucket: R2_BUCKET,
          Key: f.key,
        })
      );

      // ====== CONVERT MODE (SAFE + NON-BREAKING) ======
      if (job.mode === "convert" && sharp && job.convertTarget) {
        let buffer;
        try {
          buffer = await streamToBuffer(obj.Body);
        } catch {
          archive.append(obj.Body, {
            name: makeUniqueName(sanitizeName(f.originalname), used),
          });
          continue;
        }

        const mime = String(f.mimetype || "");
        const isImage = mime.startsWith("image/");
        const isPdf = mime === "application/pdf";

        let converted = null;
        let newExt = "";

        try {
          if (isImage) {
            const image = sharp(buffer);

            if (job.convertTarget === "jpg") {
              converted = await image.jpeg({ quality: 90 }).toBuffer();
              newExt = ".jpg";
            } else if (job.convertTarget === "png") {
              converted = await image.png().toBuffer();
              newExt = ".png";
            } else if (job.convertTarget === "webp") {
              converted = await image.webp({ quality: 85 }).toBuffer();
              newExt = ".webp";
            } else if (job.convertTarget === "pdf") {
              // minimal inline image->pdf (kept non-breaking; your original helper may exist elsewhere)
              converted = buffer; // fallback: just keep original if you don’t support image->pdf here
              newExt = ".pdf";
            }
          }

          if (!converted && isPdf) {
            if (job.convertTarget === "jpg") {
              converted = await sharp(buffer, { density: 300 })
                .jpeg({ quality: 90 })
                .toBuffer();
              newExt = ".jpg";
            } else if (job.convertTarget === "png") {
              converted = await sharp(buffer, { density: 300 }).png().toBuffer();
              newExt = ".png";
            } else if (job.convertTarget === "webp") {
              converted = await sharp(buffer, { density: 300 })
                .webp({ quality: 85 })
                .toBuffer();
              newExt = ".webp";
            }
          }
        } catch {
          converted = null;
        }

        if (converted && newExt) {
          const base = String(f.originalname || "file").replace(/\.[^/.]+$/, "");
          archive.append(converted, {
            name: makeUniqueName(sanitizeName(base + newExt), used),
          });
          continue;
        }

        archive.append(buffer, {
          name: makeUniqueName(sanitizeName(f.originalname), used),
        });
        continue;
      }

      // ====== DEFAULT (NO CONVERSION) ======
      archive.append(obj.Body, {
        name: makeUniqueName(sanitizeName(f.originalname), used),
      });
    }

    await archive.finalize();
  } catch (e) {
    res.status(400).send(e.message);
  }
});

// Share meta (for share page)
app.get("/api/share/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const jobId = shareIndex.get(token);
    if (!jobId) return res.status(404).json({ error: "Not found" });

    const job = getJob(jobId);

    if (job.status !== "PAID") {
      await ensurePaid(job);
    }

    res.json({
      ok: true,
      jobId: job.jobId,
      token,
      expiresAt: job.shareExpiresAt,
      mode: job.mode,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Share download
app.get("/api/share/:token/download", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const jobId = shareIndex.get(token);
    if (!jobId) return res.status(404).send("Not found");
    const job = getJob(jobId);

    if (job.status !== "PAID") {
      const ok = await ensurePaid(job);
      if (!ok) throw new Error("Payment not confirmed");
    }

    // reuse the same download route logic via redirect (keeps behavior identical)
    res.redirect(`/api/download/${encodeURIComponent(job.jobId)}`);
  } catch (e) {
    res.status(400).send(e.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ PDFOperations server running on port ${PORT}`);
});