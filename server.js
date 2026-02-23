// server.js — ZipPixel (RENDER SAFE MONEY MODE v16.5 - TRUE PAGE-LEVEL MERGE (CROSS-PDF) + ROTATE PDF MODE)
// ✅ Pricing tiers: £2.99 (≤10) / £9.99 (11–50) + optional share link (+£2.49)
// ✅ Server-side enforcement: max 50 files (client enforces size; server enforces count + mode validation)
// ✅ Routes: /api/jobs, /api/upload-url, /api/jobs/:jobId/register, /api/jobs/:jobId/mode, /api/checkout
// ✅ Webhook + Stripe self-heal preserved
// ✅ merge_pdf mode — PAID download returns a single merged PDF
//    - default: file order + natural page order
//    - optional: cross-PDF page order via ["fileIndex:pageNumber", ...] (e.g. ["0:1","1:2","0:3"])
//    - optional legacy: single-PDF reorder via [0,2,1,...] when ONLY 1 PDF registered
// ✅ split_pdf mode — PAID download returns a ZIP of per-page PDFs (in page order)
// ✅ compress_pdf mode — PAID download returns a single compressed PDF (raster-based; level: light/balanced/max)
// ✅ rotate_pdf mode — PAID download returns a single rotated PDF (degrees: 90/180/270)

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

// ====== TTLs ======
const UNPAID_JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PAID_JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ====== STRIPE ======
const stripeConfigured = !!process.env.STRIPE_SECRET_KEY;
const stripe = stripeConfigured ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

// ====== R2 ======
const R2_BUCKET = process.env.CF_R2_BUCKET;

const r2Configured =
  !!process.env.CF_ACCOUNT_ID &&
  !!process.env.CF_R2_ACCESS_KEY_ID &&
  !!process.env.CF_R2_SECRET_ACCESS_KEY &&
  !!R2_BUCKET;

const r2 = r2Configured
  ? new S3Client({
      region: "auto",
      endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.CF_R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

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
  const tier = inferTierFromFileCount(count);
  const share = !!job?.options?.shareLink;
  const total = tier.price + (share ? SHARE_LINK_UPSELL_PENCE : 0);
  return { total, tier };
}

// ====== MODE HELPERS ======
const VALID_MODES = new Set([
  "compress",
  "compress_pdf",
  "convert",
  "merge_pdf",
  "split_pdf",
  "rotate_pdf",
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

function normalizePdfLevel(lvl) {
  const v = String(lvl || "").toLowerCase().trim();
  if (!v) return "balanced";
  if (!VALID_PDF_COMPRESS_LEVELS.has(v)) return "balanced";
  return v;
}

function normalizeRotateDegrees(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return 90;
  const i = Math.round(n);
  if (!VALID_ROTATE_DEGREES.has(i)) return 90;
  return i;
}

function isPdfMeta(fileMeta) {
  const mt = String(fileMeta?.mimetype || "").toLowerCase();
  const name = String(fileMeta?.originalname || "").toLowerCase();
  return mt === "application/pdf" || name.endsWith(".pdf");
}

// ====== PAGE ORDER (MERGE) ======
// Supports 2 formats:
// 1) Cross-PDF page order: ["fileIndex:pageNumber", ...] where pageNumber is 1-based.
//    e.g. ["0:1","1:2","0:3","1:1","0:2"]
// 2) Legacy single-PDF reorder: [0,2,1,...] used only when there is exactly 1 PDF.
const MAX_PAGE_ORDER_LEN = Number(process.env.MAX_PAGE_ORDER_LEN || 2000);

function parseCrossKey(k) {
  const s = String(k || "").trim();
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length !== 2) return null;

  const fi = Number(parts[0]);
  const p1 = Number(parts[1]); // 1-based
  if (!Number.isInteger(fi) || fi < 0) return null;
  if (!Number.isInteger(p1) || p1 < 1) return null;

  return { fi, p1, key: `${fi}:${p1}` };
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
  }

  if (job.mode === "rotate_pdf") {
    if (!PDFDocumentLib || !PDFDegrees)
      throw new Error("PDF rotate is unavailable (pdf-lib not installed).");
    if (files.length !== 1) throw new Error("Rotate PDF requires exactly 1 PDF.");
    const nonPdf = files.find((f) => !isPdfMeta(f));
    if (nonPdf) throw new Error("Rotate PDF only accepts a PDF file.");
    job.rotateDegrees = normalizeRotateDegrees(job.rotateDegrees);
  }

  if (job.mode === "convert") {
    if (job.convertTarget && !VALID_CONVERT_TARGETS.has(job.convertTarget)) {
      throw new Error("Invalid convert target");
    }
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
  });
});

// ====== STATIC ======
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

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

// ====== SEO TOOL PAGES ======
const TOOL_PAGES = [
  "compress-pdf",
  "merge-pdf",
  "split-pdf",
  "pdf-to-jpg",
  "jpg-to-pdf",
  "rotate-pdf",
  "reduce-pdf-size",
  "compress-pdf-to-5mb",
  "convert",
];

TOOL_PAGES.forEach((slug) => {
  app.get(`/${slug}`, (_, res) => {
    res.sendFile(path.join(PUBLIC_DIR, `${slug}.html`));
  });
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
    pageOrder: null,      // either ["0:1","1:2",...] OR [0,2,1,...] legacy OR null
    pageOrderType: "none",// "none" | "cross" | "single"

    // compress_pdf options
    pdfCompressLevel: "balanced",

    // rotate_pdf options
    rotateDegrees: 90,

    shareToken: null,
    shareExpiresAt: null,

    checkoutSessionId: null,
    paidAt: null,

    downloadCount: 0,
  });

  res.json({ jobId });
});

// Presigned upload url
app.post("/api/upload-url", async (req, res) => {
  try {
    requireR2();

    const { jobId, filename, type } = req.body || {};
    if (!jobId || !filename) throw new Error("Missing jobId/filename");

    const job = getJob(jobId);
    if (job.status !== "CREATED") throw new Error("Invalid job state");

    const key = `${jobId}/${Date.now()}_${sanitizeName(filename)}`;

    const url = await getSignedUrl(
      r2,
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ContentType: type || "application/octet-stream",
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

// Set job mode (compress | compress_pdf | convert | merge_pdf | split_pdf | rotate_pdf)
app.post("/api/jobs/:jobId/mode", (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    const { mode, target, order, level, degrees, angle } = req.body || {};

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

      job.pdfCompressLevel = "balanced";
      job.rotateDegrees = 90;
    } else if (m === "merge_pdf") {
      job.convertTarget = null;
      job.pdfCompressLevel = "balanced";
      job.rotateDegrees = 90;

      const norm = normalizeMergeOrder(order);
      job.pageOrderType = norm.type;
      job.pageOrder = norm.order;

    } else if (m === "compress_pdf") {
      job.convertTarget = null;

      job.pageOrder = null;
      job.pageOrderType = "none";

      job.pdfCompressLevel = normalizePdfLevel(level);
      job.rotateDegrees = 90;
    } else if (m === "rotate_pdf") {
      job.convertTarget = null;

      job.pageOrder = null;
      job.pageOrderType = "none";

      job.pdfCompressLevel = "balanced";
      job.rotateDegrees = normalizeRotateDegrees(degrees != null ? degrees : angle);
    } else {
      job.convertTarget = null;

      job.pageOrder = null;
      job.pageOrderType = "none";

      job.pdfCompressLevel = "balanced";
      job.rotateDegrees = 90;
    }

    res.json({ ok: true, pageOrderType: job.pageOrderType });
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
      tier.key === "zip50" ? "ZipPixel Pro (up to 50 files)" : "ZipPixel (up to 10 files)";

    const levelLabel = (() => {
      const lvl = normalizePdfLevel(job.pdfCompressLevel);
      if (lvl === "max") return "Maximum";
      if (lvl === "light") return "Light";
      return "Balanced";
    })();

    const rotateLabel = (() => {
      const d = normalizeRotateDegrees(job.rotateDegrees);
      return `${d}°`;
    })();

    const modeLabel =
      job.mode === "merge_pdf"
        ? "Merge PDFs"
        : job.mode === "split_pdf"
            ? "Split PDF"
            : (job.mode === "compress_pdf"
                ? `Compress PDF (${levelLabel})`
                : (job.mode === "rotate_pdf"
                    ? `Rotate PDF (${rotateLabel})`
                    : (job.mode === "convert"
                        ? `Convert to ${String(job.convertTarget || "").toUpperCase() || "format"}`
                        : "ZIP download")));

    const productName = `${productNameBase} — ${modeLabel}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
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
      status: job.status,
      paid: job.status === "PAID",
      shareToken: job.shareToken || null,
      expiresAt: job.expiresAt || null,
      downloads: job.downloadCount || 0,
      fileCount: job.files?.length || 0,
      mode: job.mode || "compress",
      convertTarget: job.convertTarget || null,
      pdfLevel: job.pdfCompressLevel || null,
      rotateDegrees: job.rotateDegrees || null,
      pageOrderType: job.pageOrderType || "none",
    });
  } catch {
    res.status(404).json({ ok: false, error: "Not found" });
  }
});

// Download — PAID ONLY
app.get("/api/download/:jobId", async (req, res) => {
  try {
    requireR2();

    const job = getJob(req.params.jobId);

    if (job.status !== "PAID") {
      const ok = await ensurePaid(job);
      if (!ok) return res.status(402).send("Payment required");
    }

    validateJobFilesForMode(job);
    job.downloadCount++;

    // ====== ROTATE PDF MODE ======
    if (job.mode === "rotate_pdf") {
      if (!PDFDocumentLib || !PDFDegrees)
        throw new Error("PDF rotate is unavailable (pdf-lib not installed).");

      const only = job.files[0];
      const obj = await r2.send(
        new GetObjectCommand({ Bucket: R2_BUCKET, Key: only.key })
      );
      const inputBuf = await streamToBuffer(obj.Body);

      const deg = normalizeRotateDegrees(job.rotateDegrees);

      const pdf = await PDFDocumentLib.load(inputBuf);
      const pages = pdf.getPages();
      for (const p of pages) {
        p.setRotation(PDFDegrees(deg));
      }

      const outBytes = await pdf.save();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="zippixel_rotated_${deg}deg_${job.jobId}.pdf"`
      );
      return res.send(Buffer.from(outBytes));
    }

    // ====== COMPRESS PDF MODE ======
    if (job.mode === "compress_pdf") {
      if (!sharp) throw new Error("PDF compression is unavailable (sharp not installed).");

      const only = job.files[0];
      const obj = await r2.send(
        new GetObjectCommand({ Bucket: R2_BUCKET, Key: only.key })
      );
      const inputBuf = await streamToBuffer(obj.Body);

      const lvl = normalizePdfLevel(job.pdfCompressLevel);

      const settings =
        lvl === "light"
          ? { density: 170, quality: 82 }
          : (lvl === "max"
              ? { density: 110, quality: 60 }
              : { density: 140, quality: 72 });

      let pagesCount = 1;
      try {
        const meta = await sharp(inputBuf, { density: settings.density }).metadata();
        if (meta && Number.isFinite(meta.pages) && meta.pages > 0) pagesCount = meta.pages;
      } catch {
        pagesCount = 1;
      }

      const MAX_PAGES_COMPRESS = Number(process.env.MAX_PDF_COMPRESS_PAGES || 80);
      if (pagesCount > MAX_PAGES_COMPRESS) {
        throw new Error(`PDF too long to compress (max ${MAX_PAGES_COMPRESS} pages).`);
      }

      const outBuf = await pdfFromRenderedPages(inputBuf, pagesCount, settings);

      if (outBuf && outBuf.length && outBuf.length < inputBuf.length) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="zippixel_compressed_${job.jobId}.pdf"`
        );
        return res.send(outBuf);
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="zippixel_${job.jobId}.pdf"`
      );
      return res.send(inputBuf);
    }

    // ====== MERGE PDF MODE (TRUE PAGE-LEVEL) ======
    if (job.mode === "merge_pdf") {
      if (!PDFDocumentLib) throw new Error("PDF merge is unavailable (pdf-lib not installed).");

      const merged = await PDFDocumentLib.create();

      // Load all PDFs once
      const srcDocs = [];
      const srcPageCounts = [];

      for (const f of job.files) {
        const obj = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: f.key }));
        const buf = await streamToBuffer(obj.Body);

        const src = await PDFDocumentLib.load(buf);
        srcDocs.push(src);
        srcPageCounts.push(src.getPageCount());
      }

      // Helper: add pages in default order (file order + natural pages)
      const addDefaultOrder = async () => {
        for (let fi = 0; fi < srcDocs.length; fi++) {
          const src = srcDocs[fi];
          const pages = await merged.copyPages(src, src.getPageIndices());
          for (const p of pages) merged.addPage(p);
        }
      };

      // Cross-PDF page order:
      // job.pageOrder = ["fi:p1", ...] where p1 is 1-based.
      if (job.pageOrderType === "cross" && Array.isArray(job.pageOrder) && job.pageOrder.length) {
        let added = 0;
        for (const key of job.pageOrder) {
          const parsed = parseCrossKey(key);
          if (!parsed) continue;

          const fi = parsed.fi;
          const p1 = parsed.p1;

          if (fi < 0 || fi >= srcDocs.length) continue;
          const total = srcPageCounts[fi] || 0;
          if (p1 < 1 || p1 > total) continue;

          const src = srcDocs[fi];
          const pageIdx0 = p1 - 1;

          const [copied] = await merged.copyPages(src, [pageIdx0]);
          merged.addPage(copied);
          added++;
          if (added >= MAX_PAGE_ORDER_LEN) break;
        }

        // If something went wrong and we added nothing, fallback safely
        if (added === 0) {
          await addDefaultOrder();
        }
      }
      // Legacy single-PDF reorder:
      // job.pageOrder = [0..n-1] only meaningful when there is exactly 1 PDF.
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
        `attachment; filename="zippixel_merged_${job.jobId}.pdf"`
      );

      return res.send(Buffer.from(mergedBytes));
    }

    // ====== SPLIT PDF MODE ======
    if (job.mode === "split_pdf") {
      if (!PDFDocumentLib) throw new Error("PDF split is unavailable (pdf-lib not installed).");

      const only = job.files[0];
      const obj = await r2.send(
        new GetObjectCommand({ Bucket: R2_BUCKET, Key: only.key })
      );
      const buf = await streamToBuffer(obj.Body);

      const src = await PDFDocumentLib.load(buf);
      const indices = src.getPageIndices();
      const totalPages = indices.length;

      const safeBase = sanitizeName(String(only.originalname || "document").replace(/\.pdf$/i, ""));
      const pad = String(totalPages).length;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="zippixel_split_${job.jobId}.zip"`
      );

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", (err) => {
        try { res.status(500).send(err.message); } catch {}
      });
      archive.pipe(res);

      const used = new Set();

      for (let i = 0; i < totalPages; i++) {
        const out = await PDFDocumentLib.create();
        const [copied] = await out.copyPages(src, [i]);
        out.addPage(copied);
        const bytes = await out.save();

        const pageNo = String(i + 1).padStart(pad, "0");
        const filename = makeUniqueName(
          sanitizeName(`${safeBase}_page_${pageNo}.pdf`),
          used
        );

        archive.append(Buffer.from(bytes), { name: filename });
      }

      await archive.finalize();
      return;
    }

    // ====== ZIP MODES ======
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="zippixel_${job.jobId}.zip"`);

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
              converted = await imageToPdf(buffer);
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

        if (converted) {
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

    if (job.status !== "PAID") return res.status(404).json({ error: "Not found" });
    if (job.shareExpiresAt && Date.now() > job.shareExpiresAt)
      return res.status(410).json({ error: "Expired" });

    res.json({
      jobId: job.jobId,
      fileCount: job.files.length,
      downloads: job.downloadCount,
      expiresAt: job.shareExpiresAt,
      mode: job.mode || "compress",
      convertTarget: job.convertTarget || null,
      pdfLevel: job.pdfCompressLevel || null,
      rotateDegrees: job.rotateDegrees || null,
      pageOrderType: job.pageOrderType || "none",
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Share page
app.get("/s/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const jobId = shareIndex.get(token);
    if (!jobId) return res.status(404).send("Not found");

    const job = getJob(jobId);

    if (job.status !== "PAID") {
      await ensurePaid(job);
    }

    if (job.status !== "PAID") return res.status(404).send("Not found");
    if (job.shareExpiresAt && Date.now() > job.shareExpiresAt)
      return res.status(410).send("Link expired");

    res.sendFile(path.join(PUBLIC_DIR, "share.html"));
  } catch {
    res.status(404).send("Not found");
  }
});

// ====== WEBHOOK ======
function webhookHandler(req, res) {
  try {
    if (!stripe) throw new Error("Stripe not configured");

    const event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );

    const type = event.type;

    if (
      type === "checkout.session.completed" ||
      type === "checkout.session.async_payment_succeeded"
    ) {
      const session = event.data.object;
      const jobId = session?.metadata?.jobId;

      if (jobId && jobs.has(jobId)) {
        const job = jobs.get(jobId);

        const paymentStatus = session?.payment_status;
        if (paymentStatus === "paid") {
          markJobPaid(job);
        }
      }
    }

    res.json({ received: true });
  } catch (e) {
    res.status(400).send(e.message);
  }
}

// ====== CLEANUP LOOP ======
async function cleanupExpiredJobs() {
  const now = Date.now();

  const expired = [];
  for (const [jobId, job] of jobs.entries()) {
    if (job.expiresAt && now > job.expiresAt) {
      expired.push(jobId);
    }
  }

  if (!expired.length) return;

  for (const jobId of expired) {
    const job = jobs.get(jobId);
    if (job?.shareToken) shareIndex.delete(job.shareToken);
    jobs.delete(jobId);
  }

  if (r2Configured) {
    for (const jobId of expired) {
      try {
        await deleteJobObjectsFromR2(jobId);
      } catch {}
    }
  }
}

setInterval(() => {
  cleanupExpiredJobs().catch(() => {});
}, CLEANUP_INTERVAL_MS);

// ====== UTILS ======
const { PassThrough } = require("stream");
const PDFKitDocument = require("pdfkit");

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function imageToPdf(buffer) {
  return new Promise((resolve) => {
    const doc = new PDFKitDocument({ autoFirstPage: false });
    const stream = new PassThrough();
    const chunks = [];

    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));

    doc.pipe(stream);
    doc.addPage();
    doc.image(buffer, {
      fit: [500, 700],
      align: "center",
      valign: "center",
    });
    doc.end();
  });
}

// Render PDF pages via sharp and rebuild as compressed PDF (raster-based)
async function pdfFromRenderedPages(pdfBuffer, pageCount, settings) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFKitDocument({ autoFirstPage: false, compress: true });
      const stream = new PassThrough();
      const chunks = [];

      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);

      doc.pipe(stream);

      for (let page = 0; page < pageCount; page++) {
        let img;
        try {
          img = await sharp(pdfBuffer, { density: settings.density, page })
            .jpeg({ quality: settings.quality, mozjpeg: true })
            .toBuffer();
        } catch (e) {
          throw new Error("Could not render PDF pages for compression.");
        }

        let meta = null;
        try { meta = await sharp(img).metadata(); } catch {}

        const w = meta?.width || 595;
        const h = meta?.height || 842;

        doc.addPage({ size: [w, h], margin: 0 });
        doc.image(img, 0, 0, { width: w, height: h });
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ====== START ======
app.listen(PORT, () => {
  console.log(`🚀 ZipPixel running at ${BASE_URL}`);
  console.log(`Stripe configured: ${stripeConfigured}`);
  console.log(`R2 configured: ${r2Configured}`);
  console.log(`sharp loaded: ${!!sharp}`);
  console.log(`pdf-lib loaded: ${!!PDFDocumentLib}`);
});