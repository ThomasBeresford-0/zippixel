// server.js
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const sharp = require("sharp");
const archiver = require("archiver");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Stripe = require("stripe");

const app = express();

const PORT = process.env.PORT || 4242;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ====== PRICING (tiered) ======
const STANDARD_MAX = 5; // 1–5 files
const PRO_MAX = 10;      // 6–10 files

const STANDARD_PRICE_GBP_PENCE = Number(process.env.STANDARD_PRICE_GBP_PENCE || 299);
const PRO_PRICE_GBP_PENCE = Number(
  process.env.PRO_PRICE_GBP_PENCE || process.env.PRICE_GBP_PENCE || 499
);

if (!process.env.STRIPE_SECRET_KEY) console.warn("⚠️ STRIPE_SECRET_KEY missing");
if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn("⚠️ STRIPE_WEBHOOK_SECRET missing");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// --- Security headers ---
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

// --- Basic rate limiting ---
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ====== STRIPE WEBHOOK (RAW BODY) ======
// CRITICAL: this MUST be registered BEFORE express.json()
app.post("/webhook", express.raw({ type: "application/json" }), webhookHandler);

// Normal JSON for everything else
app.use(express.json());

// ====== STATIC SITE ======
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

// (Optional but fine)
app.get("/robots.txt", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "robots.txt")));
app.get("/sitemap.xml", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "sitemap.xml")));
app.get("/favicon.ico", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "favicon.ico")));

// Pages
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/success", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "success.html")));
app.get("/cancel", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "cancel.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "privacy.html")));
app.get("/terms", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "terms.html")));
app.get("/pricing", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "pricing.html")));

// Health check (Render/monitoring)
app.get("/health", (req, res) => res.json({ ok: true }));

// ====== UPLOADS / JOBS ======
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// In-memory jobs store (MVP). Note: server restarts reset jobs.
const jobs = new Map(); // jobId -> { status, createdAt, files, paidAt?, checkoutSessionId?, tier?, pricePaidPence? }

// Cleanup jobs after 60 mins
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > 60 * 60 * 1000) {
      try {
        for (const f of job.files || []) {
          if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
        }
        const jobDir = path.join(UPLOAD_DIR, jobId);
        if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
      } catch {}
      jobs.delete(jobId);
    }
  }
}, 5 * 60 * 1000);

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error("Job not found.");
  return job;
}

// ====== MULTER (images + PDFs only) ======
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const jobId = req.params.jobId;
    const dir = path.join(UPLOAD_DIR, jobId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-z0-9.\-_]/gi, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});

// Allowed: images + PDFs (NO VIDEO)
const allowedMimes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/avif",
  "application/pdf",
]);

const MAX_MB_EACH = Number(process.env.MAX_MB_EACH || 25);

const upload = multer({
  storage,
  limits: { files: PRO_MAX, fileSize: MAX_MB_EACH * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!allowedMimes.has(file.mimetype)) {
      return cb(new Error("Only image or PDF uploads are allowed."));
    }
    cb(null, true);
  },
});

// ====== API ======
app.post("/api/jobs", (req, res) => {
  const jobId = newId("job");
  jobs.set(jobId, { status: "CREATED", createdAt: Date.now(), files: [] });
  res.json({ jobId });
});

// Keep field name "images" so your frontend doesn’t have to change.
// It can carry PDFs too — it’s just a field name.
app.post("/api/jobs/:jobId/upload", upload.array("images", PRO_MAX), (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files" });

    for (const f of req.files) {
      job.files.push({ path: f.path, originalname: f.originalname, mimetype: f.mimetype });
    }

    job.status = "UPLOADED";
    res.json({ ok: true, fileCount: job.files.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Tiered checkout: 1–5 => Standard (£2.99), 6–10 => Pro (£4.99)
app.post("/api/checkout", async (req, res) => {
  try {
    const { jobId, tier } = req.body || {};
    const job = getJob(jobId);

    if (!job.files || job.files.length === 0) {
      return res.status(400).json({ error: "Upload files first." });
    }

    const count = job.files.length;
    const computedTier = count > STANDARD_MAX ? "pro" : "standard";

    // If frontend sends tier, trust only if consistent with file count
    const requestedTier = tier === "standard" || tier === "pro" ? tier : computedTier;
    const safeTier = requestedTier === "standard" && count > STANDARD_MAX ? "pro" : requestedTier;

    const unitAmount = safeTier === "pro" ? PRO_PRICE_GBP_PENCE : STANDARD_PRICE_GBP_PENCE;

    const productName =
      safeTier === "pro"
        ? `ZipPixel – Pro ZIP (up to ${PRO_MAX} files)`
        : `ZipPixel – Standard ZIP (up to ${STANDARD_MAX} files)`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      metadata: { jobId, tier: safeTier, fileCount: String(count) },
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: unitAmount,
            product_data: { name: productName },
          },
          quantity: 1,
        },
      ],
      success_url: `${BASE_URL}/success?jobId=${encodeURIComponent(jobId)}`,
      cancel_url: `${BASE_URL}/cancel`,
    });

    job.status = "CHECKOUT_CREATED";
    job.checkoutSessionId = session.id;
    job.tier = safeTier;
    job.pricePaidPence = unitAmount;

    res.json({ url: session.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Paywall: only PAID can download
app.get("/api/download/:jobId", async (req, res) => {
  try {
    const job = getJob(req.params.jobId);

    // If webhook is slow, verify once via Stripe to reduce “Not paid” rage.
    if (job.status !== "PAID" && job.checkoutSessionId) {
      try {
        const s = await stripe.checkout.sessions.retrieve(job.checkoutSessionId);
        if (s && s.payment_status === "paid") {
          job.status = "PAID";
          job.paidAt = Date.now();
        }
      } catch {}
    }

    if (job.status !== "PAID") return res.status(402).send("Not paid.");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="zippixel_bundle.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error(err);
      res.status(500).end("ZIP error");
    });

    archive.pipe(res);

    for (const f of job.files) {
      const originalBase = path.basename(f.originalname || "file");
      const safeBase = originalBase.replace(/[^a-z0-9.\-_]/gi, "_");

      if (f.mimetype && f.mimetype.startsWith("image/")) {
        // Images -> JPG (compressed)
        const base = safeBase.replace(/\.(heic|heif)$/i, ".jpg");
        const outName = base.replace(/\.[^.]+$/, ".jpg");

        const buf = await sharp(f.path)
          .rotate()
          .jpeg({ quality: 80, mozjpeg: true })
          .toBuffer();

        archive.append(buf, { name: outName });
      } else if (f.mimetype === "application/pdf") {
        // PDFs -> keep as-is inside the ZIP
        const outName = safeBase.toLowerCase().endsWith(".pdf") ? safeBase : `${safeBase}.pdf`;
        archive.file(f.path, { name: outName });
      } else {
        // Should never happen (multer filter blocks it), but belt + braces:
        archive.file(f.path, { name: safeBase });
      }
    }

    await archive.finalize();
  } catch (e) {
    res.status(400).send(e.message);
  }
});

// --- Webhook handler ---
function webhookHandler(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const jobId = session?.metadata?.jobId;
    if (jobId && jobs.has(jobId)) {
      const job = jobs.get(jobId);
      job.status = "PAID";
      job.paidAt = Date.now();
    }
  }

  res.json({ received: true });
}

app.listen(PORT, () => console.log(`ZipPixel running at ${BASE_URL}`));
