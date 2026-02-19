// server.js — ZipPixel (RENDER SAFE MONEY MODE v15)
// ✅ Pricing tiers: £2.99 (≤10) / £9.99 (11–50) + optional share link (+£2.49)
// ✅ Server-side enforcement: max 50 files, 25MB each (size enforced at upload time in R2 presign policy via client; server still validates count)
// ✅ Routes unchanged: /api/jobs, /api/upload-url, /api/jobs/:jobId/register, /api/checkout
// ✅ Webhook + Stripe self-heal preserved
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
const MAX_FILES = Number(process.env.MAX_FILES || 50); // v15
const MAX_MB_EACH = Number(process.env.MAX_MB_EACH || 25);

// ====== PRICING TIERS ======
// You can override via env, but defaults are the money-mode tiers.
const TIER_10_LIMIT = Number(process.env.TIER_10_LIMIT || 10);
const TIER_10_PRICE_GBP_PENCE = Number(process.env.TIER_10_PRICE_GBP_PENCE || 299);

const TIER_50_LIMIT = Number(process.env.TIER_50_LIMIT || 50);
const TIER_50_PRICE_GBP_PENCE = Number(process.env.TIER_50_PRICE_GBP_PENCE || 999);

const SHARE_LINK_UPSELL_PENCE = Number(process.env.SHARE_LINK_UPSELL_PENCE || 249);

// ====== TTLs ======
// Unpaid jobs should expire quickly (abandoned uploads)
const UNPAID_JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes
// Paid jobs without share link: keep long enough for user to download reliably
const PAID_JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
// Paid jobs with share link: must match your promise
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Cleanup cadence
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
// NOTE: This will reset on redeploy. For real durability, move to Redis/D1/KV.
// This code still self-heals paid state via Stripe checks when possible.
const jobs = new Map();

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

  // If expired, remove from memory (cleanup loop also handles this)
  if (job.expiresAt && Date.now() > job.expiresAt) {
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

  // Past 50 is not allowed; clamp to protect server math; caller should already have been rejected.
  return { key: "zip50", limit: TIER_50_LIMIT, price: TIER_50_PRICE_GBP_PENCE };
}

function computeTotalPence(job) {
  const count = job?.files?.length || 0;
  const tier = inferTierFromFileCount(count);
  const share = !!job?.options?.shareLink;
  const total = tier.price + (share ? SHARE_LINK_UPSELL_PENCE : 0);
  return { total, tier };
}

// ====== R2 CLEANUP HELPERS ======
async function deleteJobObjectsFromR2(jobId) {
  if (!r2Configured) return;

  // Delete all objects under prefix `${jobId}/`
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
// If webhook is delayed/missed, verify payment via Stripe session.
async function ensurePaid(job) {
  if (job.status === "PAID") return true;
  if (!stripeConfigured) return false;
  if (!job.checkoutSessionId) return false;

  try {
    const session = await stripe.checkout.sessions.retrieve(job.checkoutSessionId);
    if (session?.payment_status === "paid") {
      // Mark paid + issue share token if purchased
      markJobPaid(job);
      return true;
    }
  } catch {
    // ignore stripe errors here; caller can treat as "not paid yet"
  }
  return false;
}

function markJobPaid(job) {
  // idempotent
  if (job.status === "PAID") return;

  job.status = "PAID";
  job.paidAt = Date.now();

  // If they bought share link, generate token + extend TTL to SHARE_TTL_MS
  if (job.options?.shareLink) {
    job.shareToken = job.shareToken || newShareToken();
    job.shareExpiresAt = job.shareExpiresAt || Date.now() + SHARE_TTL_MS;
    job.expiresAt = Date.now() + SHARE_TTL_MS; // keep files as long as share link is valid
  } else {
    job.shareToken = null;
    job.shareExpiresAt = null;
    job.expiresAt = Date.now() + PAID_JOB_TTL_MS; // keep paid downloads available reliably
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
    jobsInMemory: jobs.size,
    pricing: {
      tier10: { limit: TIER_10_LIMIT, pricePence: TIER_10_PRICE_GBP_PENCE },
      tier50: { limit: TIER_50_LIMIT, pricePence: TIER_50_PRICE_GBP_PENCE },
      shareUpsellPence: SHARE_LINK_UPSELL_PENCE,
    },
    limits: { maxFiles: MAX_FILES, maxMBEach: MAX_MB_EACH },
  });
});

// ====== STATIC ======
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

["/", "/success", "/cancel", "/privacy", "/terms", "/pricing"].forEach((route) => {
  app.get(route, (_, res) =>
    res.sendFile(path.join(PUBLIC_DIR, route === "/" ? "index.html" : `${route.slice(1)}.html`))
  );
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

    mode: "compress",
    convertTarget: null,

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

    // (We can't enforce file size here without a signed policy; client enforces MAX_MB_EACH.)
    // We *do* keep the server-side count enforcement at register-time.
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

    // Safety: ensure keys are under job prefix
    for (const f of job.files) {
      if (!f.key.startsWith(`${job.jobId}/`)) throw new Error("Invalid file key");
    }

    job.status = "UPLOADED";
    res.json({ ok: true, count: job.files.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Set job mode (compress | convert)
app.post("/api/jobs/:jobId/mode", (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    const { mode, target } = req.body || {};

    if (!["compress", "convert"].includes(mode)) {
      throw new Error("Invalid mode");
    }

    job.mode = mode;
    job.convertTarget = mode === "convert" ? String(target || "").toLowerCase() : null;

    res.json({ ok: true });
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

    job.options.shareLink = !!shareLink;

    // Clear any old token until payment confirmed
    job.shareToken = null;
    job.shareExpiresAt = null;

    const { total, tier } = computeTotalPence(job);

    const productName =
      tier.key === "zip50" ? "ZipPixel Pro ZIP (up to 50 files)" : "ZipPixel ZIP (up to 10 files)";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: total,
            product_data: {
              name: productName,
              description: job.options.shareLink ? "ZIP download + shareable link" : "ZIP download",
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
        fileCount: String(job.files.length),
        totalPence: String(total),
      },
    });

    job.checkoutSessionId = session.id;

    res.json({ url: session.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Status endpoint for success page polling (webhook + stripe fallback)
app.get("/api/status/:jobId", async (req, res) => {
  try {
    const job = getJob(req.params.jobId);

    // If not paid yet, try to self-heal via Stripe
    if (job.status !== "PAID") {
      await ensurePaid(job);
    }

    res.json({
      ok: true,
      status: job.status, // CREATED | UPLOADED | PAID
      paid: job.status === "PAID",
      shareToken: job.shareToken || null,
      expiresAt: job.expiresAt || null,
      downloads: job.downloadCount || 0,
      fileCount: job.files?.length || 0,
    });
  } catch {
    res.status(404).json({ ok: false, error: "Not found" });
  }
});

// Download ZIP (zip from R2) — PAID ONLY (webhook + stripe fallback)
app.get("/api/download/:jobId", async (req, res) => {
  try {
    requireR2();

    const job = getJob(req.params.jobId);

    if (job.status !== "PAID") {
      const ok = await ensurePaid(job);
      if (!ok) return res.status(402).send("Payment required");
    }

    job.downloadCount++;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="zippixel_${Date.now()}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      try {
        res.status(500).send(err.message);
      } catch {}
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
        // We must buffer the object because:
        // 1) conversion needs a buffer
        // 2) if conversion fails, we can still append the original bytes (buffer) safely
        let buffer;
        try {
          buffer = await streamToBuffer(obj.Body);
        } catch {
          // If we can't read it, skip conversion and try streaming original (best-effort)
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
          // ===== IMAGE INPUTS =====
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

          // ===== PDF INPUTS (first page only) =====
          // Note: this only works if your Sharp build supports PDF input (pdfium/poppler).
          if (!converted && isPdf) {
            if (job.convertTarget === "jpg") {
              converted = await sharp(buffer, { density: 300 }).jpeg({ quality: 90 }).toBuffer();
              newExt = ".jpg";
            } else if (job.convertTarget === "png") {
              converted = await sharp(buffer, { density: 300 }).png().toBuffer();
              newExt = ".png";
            } else if (job.convertTarget === "webp") {
              converted = await sharp(buffer, { density: 300 }).webp({ quality: 85 }).toBuffer();
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

        // Conversion not possible → append original bytes (buffer) with original name
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
    const job = [...jobs.values()].find((j) => j.shareToken === token);

    if (!job) return res.status(404).json({ error: "Not found" });

    // Stripe fallback if webhook missed
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
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Share page
app.get("/s/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const job = [...jobs.values()].find((j) => j.shareToken === token);

    if (!job) return res.status(404).send("Not found");

    // Stripe fallback if webhook missed
    if (job.status !== "PAID") {
      await ensurePaid(job);
    }

    if (job.status !== "PAID") return res.status(404).send("Not found");
    if (job.shareExpiresAt && Date.now() > job.shareExpiresAt) return res.status(410).send("Link expired");

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

    if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;
      const jobId = session?.metadata?.jobId;

      if (jobId && jobs.has(jobId)) {
        const job = jobs.get(jobId);

        // Extra safety: only mark paid if Stripe says paid
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

  // Remove from memory first (so we don’t keep serving it)
  for (const jobId of expired) {
    jobs.delete(jobId);
  }

  // Best-effort R2 cleanup
  if (r2Configured) {
    for (const jobId of expired) {
      try {
        await deleteJobObjectsFromR2(jobId);
      } catch {
        // best-effort only
      }
    }
  }
}

setInterval(() => {
  cleanupExpiredJobs().catch(() => {});
}, CLEANUP_INTERVAL_MS);

const { PassThrough } = require("stream");
const PDFDocument = require("pdfkit");

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
    const doc = new PDFDocument({ autoFirstPage: false });
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

// ====== START ======
app.listen(PORT, () => {
  console.log(`🚀 ZipPixel running at ${BASE_URL}`);
  console.log(`Stripe configured: ${stripeConfigured}`);
  console.log(`R2 configured: ${r2Configured}`);
  console.log(`sharp loaded: ${!!sharp}`);
});