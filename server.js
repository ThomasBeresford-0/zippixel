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
const PRICE_GBP_PENCE = Number(process.env.PRICE_GBP_PENCE || 499);

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("⚠️ STRIPE_SECRET_KEY missing");
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.warn("⚠️ STRIPE_WEBHOOK_SECRET missing");
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// --- Security headers (safe defaults) ---
app.use(
  helmet({
    contentSecurityPolicy: false, // keep off for now (Stripe redirect + inline minimal)
  })
);

// --- Basic rate limiting (stop bots/abuse) ---
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// --- Stripe webhook MUST be raw body ---
app.post("/webhook", express.raw({ type: "application/json" }), webhookHandler);

// Normal JSON for everything else
app.use(express.json());

// Static site
app.use(express.static("public", { extensions: ["html"] }));

// Serve SEO files explicitly
app.get("/robots.txt", (req, res) => res.sendFile(path.join(__dirname, "public/robots.txt")));
app.get("/sitemap.xml", (req, res) => res.sendFile(path.join(__dirname, "public/sitemap.xml")));
app.get("/favicon.ico", (req, res) => res.sendFile(path.join(__dirname, "public/favicon.ico")));

// Pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.get("/success", (req, res) => res.sendFile(path.join(__dirname, "public/success.html")));
app.get("/cancel", (req, res) => res.sendFile(path.join(__dirname, "public/cancel.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public/privacy.html")));
app.get("/terms", (req, res) => res.sendFile(path.join(__dirname, "public/terms.html")));

// Health check (Render/monitoring)
app.get("/health", (req, res) => res.json({ ok: true }));

const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// In-memory jobs store (MVP). Note: if the server restarts, jobs reset.
const jobs = new Map(); // jobId -> { status, createdAt, files: [{path, originalname, mimetype}], paidAt?, checkoutSessionId? }

// Cleanup jobs after 60 mins
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > 60 * 60 * 1000) {
      try {
        for (const f of job.files || []) if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
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

// Multer: store per job folder
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
  }
});

// Only allow image mime types
const allowedMimes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/avif",
]);

const upload = multer({
  storage,
  limits: { files: 10, fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!allowedMimes.has(file.mimetype)) {
      return cb(new Error("Only image uploads are allowed."));
    }
    cb(null, true);
  },
});

// --- API ---
app.post("/api/jobs", (req, res) => {
  const jobId = newId("job");
  jobs.set(jobId, { status: "CREATED", createdAt: Date.now(), files: [] });
  res.json({ jobId });
});

app.post("/api/jobs/:jobId/upload", upload.array("images", 10), (req, res) => {
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

app.post("/api/checkout", async (req, res) => {
  try {
    const { jobId } = req.body;
    const job = getJob(jobId);
    if (!job.files || job.files.length === 0) return res.status(400).json({ error: "Upload images first." });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      metadata: { jobId },
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: PRICE_GBP_PENCE,
            product_data: { name: "ZipPixel – Image Compression ZIP" }
          },
          quantity: 1
        }
      ],
      success_url: `${BASE_URL}/success?jobId=${encodeURIComponent(jobId)}`,
      cancel_url: `${BASE_URL}/cancel`
    });

    job.status = "CHECKOUT_CREATED";
    job.checkoutSessionId = session.id;

    res.json({ url: session.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Paywall: only PAID can download
app.get("/api/download/:jobId", async (req, res) => {
  try {
    const job = getJob(req.params.jobId);

    // If webhook is slow, we do one extra verification attempt (reduces “Not paid” rage).
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
    res.setHeader("Content-Disposition", `attachment; filename="zippixel_compressed.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error(err);
      res.status(500).end("ZIP error");
    });
    archive.pipe(res);

    for (const f of job.files) {
      const base = path.basename(f.originalname || "image").replace(/\.(heic|heif)$/i, ".jpg");
      const outName = base.replace(/\.[^.]+$/, ".jpg");

      const buf = await sharp(f.path)
        .rotate()
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer();

      archive.append(buf, { name: outName });
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
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
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
