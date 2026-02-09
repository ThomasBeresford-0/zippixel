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

// NEW: ffmpeg (self-contained binary)
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 4242;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ====== PRICING (tiered) ======
const STANDARD_MAX = 5;
const PRO_MAX = 10;

const STANDARD_PRICE_GBP_PENCE = Number(process.env.STANDARD_PRICE_GBP_PENCE || 299);
const PRO_PRICE_GBP_PENCE = Number(process.env.PRO_PRICE_GBP_PENCE || process.env.PRICE_GBP_PENCE || 499);

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
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Normal JSON for everything else
app.use(express.json());

// ====== STATIC SITE ======
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

app.get("/robots.txt", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "robots.txt")));
app.get("/sitemap.xml", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "sitemap.xml")));
app.get("/favicon.ico", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "favicon.ico")));

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/success", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "success.html")));
app.get("/cancel", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "cancel.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "privacy.html")));
app.get("/terms", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "terms.html")));
app.get("/pricing", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "pricing.html")));

app.get("/health", (req, res) => res.json({ ok: true }));

// ====== UPLOADS / JOBS ======
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const jobs = new Map(); // jobId -> { status, createdAt, files, paidAt?, checkoutSessionId? }

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

// ====== MULTER ======
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

// Accept images + common video types
const allowedMimes = new Set([
  // images
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/avif",

  // videos (MVP)
  "video/mp4",
  "video/quicktime", // .mov
  "video/webm",
  "video/x-matroska", // .mkv (sometimes)
]);

// IMPORTANT: videos are big. If you keep 25MB for everything, video will be useless.
// Set these envs in prod if you want: MAX_MB_EACH=250
const MAX_MB_EACH = Number(process.env.MAX_MB_EACH || 250);

const upload = multer({
  storage,
  limits: { files: PRO_MAX, fileSize: MAX_MB_EACH * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!allowedMimes.has(file.mimetype)) {
      return cb(new Error("Only image/video uploads are allowed."));
    }
    cb(null, true);
  },
});

// ====== VIDEO COMPRESS (FFMPEG) ======
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg binary not found"));

    const p = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (code ${code})`));
    });
  });
}

async function compressVideoToMp4(inputPath, outputPath) {
  // MVP settings:
  // - H.264 video + AAC audio
  // - "faststart" for web-friendly MP4
  // - CRF 28 (decent compression), preset "veryfast" (lower CPU cost)
  // - scale down to max 1280 wide (keeps quality decent, reduces size)
  const args = [
    "-y",
    "-i", inputPath,
    "-vf", "scale='min(1280,iw)':-2",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "28",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath
  ];

  await runFfmpeg(args);
}

// ====== API ======
app.post("/api/jobs", (req, res) => {
  const jobId = newId("job");
  jobs.set(jobId, { status: "CREATED", createdAt: Date.now(), files: [] });
  res.json({ jobId });
});

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

app.post("/api/checkout", async (req, res) => {
  try {
    const { jobId, tier } = req.body || {};
    const job = getJob(jobId);

    if (!job.files || job.files.length === 0) {
      return res.status(400).json({ error: "Upload files first." });
    }

    const count = job.files.length;
    const computedTier = count > STANDARD_MAX ? "pro" : "standard";
    const finalTier = (tier === "standard" || tier === "pro") ? tier : computedTier;
    const safeTier = (finalTier === "standard" && count > STANDARD_MAX) ? "pro" : finalTier;

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
            product_data: { name: productName }
          },
          quantity: 1
        }
      ],
      success_url: `${BASE_URL}/success?jobId=${encodeURIComponent(jobId)}`,
      cancel_url: `${BASE_URL}/cancel`
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

app.get("/api/download/:jobId", async (req, res) => {
  try {
    const job = getJob(req.params.jobId);

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

    const jobDir = path.join(UPLOAD_DIR, req.params.jobId);
    const outDir = path.join(jobDir, "out");
    fs.mkdirSync(outDir, { recursive: true });

    for (const f of job.files) {
      const originalBase = path.basename(f.originalname || "file");
      const safeBase = originalBase.replace(/[^a-z0-9.\-_]/gi, "_");

      if (f.mimetype && f.mimetype.startsWith("image/")) {
        // Images -> JPG
        const base = safeBase.replace(/\.(heic|heif)$/i, ".jpg");
        const outName = base.replace(/\.[^.]+$/, ".jpg");

        const buf = await sharp(f.path)
          .rotate()
          .jpeg({ quality: 80, mozjpeg: true })
          .toBuffer();

        archive.append(buf, { name: outName });
      } else if (f.mimetype && f.mimetype.startsWith("video/")) {
        // Videos -> compressed mp4
        const outName = safeBase.replace(/\.[^.]+$/, ".mp4");
        const outPath = path.join(outDir, `${Date.now()}_${outName}`);

        await compressVideoToMp4(f.path, outPath);

        // Append as stream (avoid loading big file into memory)
        archive.file(outPath, { name: outName });
      } else {
        // Shouldn’t happen due to filter, but just in case:
        archive.file(f.path, { name: safeBase });
      }
    }

    await archive.finalize();
  } catch (e) {
    res.status(400).send(e.message);
  }
});

// ====== STRIPE WEBHOOK (RAW BODY) ======
app.post("/webhook", express.raw({ type: "application/json" }), webhookHandler);

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
