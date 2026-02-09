// server.js
const express = require("express");
const app = express();

const multer = require("multer");
const sharp = require("sharp");
const archiver = require("archiver");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Stripe = require("stripe");

const PORT = process.env.PORT || 4242;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PRICE_GBP_PENCE = 499;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe webhook must be RAW
app.post("/webhook", express.raw({ type: "application/json" }), webhookHandler);

// Normal middleware
app.use(express.json());
app.use(express.static("public"));

const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const jobs = new Map();

// Cleanup
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > 60 * 60 * 1000) {
      try {
        for (const f of job.files || []) {
          if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        }
        fs.rmSync(path.join(UPLOAD_DIR, jobId), { recursive: true, force: true });
      } catch {}
      jobs.delete(jobId);
    }
  }
}, 300000);

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error("Job not found");
  return job;
}

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, req.params.jobId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname.replace(/[^a-z0-9.\-_]/gi, "_")}`);
  }
});

const upload = multer({ storage, limits: { files: 10, fileSize: 25 * 1024 * 1024 } });

// Pages
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.get("/success", (_, res) => res.sendFile(path.join(__dirname, "public/success.html")));
app.get("/cancel", (_, res) => res.sendFile(path.join(__dirname, "public/cancel.html")));

// API
app.post("/api/jobs", (_, res) => {
  const jobId = newId("job");
  jobs.set(jobId, { status: "CREATED", createdAt: Date.now(), files: [] });
  res.json({ jobId });
});

app.post("/api/jobs/:jobId/upload", upload.array("images", 10), (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    for (const f of req.files) job.files.push({ path: f.path, originalname: f.originalname });
    job.status = "UPLOADED";
    res.json({ fileCount: job.files.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/checkout", async (req, res) => {
  try {
    const job = getJob(req.body.jobId);
    if (!job.files.length) throw new Error("No files uploaded");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      metadata: { jobId: req.body.jobId },
      line_items: [{
        price_data: {
          currency: "gbp",
          unit_amount: PRICE_GBP_PENCE,
          product_data: { name: "ZipPixel – Image ZIP Compression" }
        },
        quantity: 1
      }],
      success_url: `${BASE_URL}/success?jobId=${req.body.jobId}`,
      cancel_url: `${BASE_URL}/cancel`
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/download/:jobId", async (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    if (job.status !== "PAID") return res.status(402).send("Not paid");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=zippixel.zip");

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);

    for (const f of job.files) {
      const buffer = await sharp(f.path).jpeg({ quality: 80 }).toBuffer();
      archive.append(buffer, { name: f.originalname.replace(/\.[^.]+$/, ".jpg") });
    }

    await archive.finalize();
  } catch (e) {
    res.status(400).send(e.message);
  }
});

function webhookHandler(req, res) {
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === "checkout.session.completed") {
      const jobId = event.data.object.metadata.jobId;
      if (jobs.has(jobId)) jobs.get(jobId).status = "PAID";
    }

    res.json({ received: true });
  } catch (err) {
    res.status(400).send(err.message);
  }
}

app.listen(PORT, () => console.log(`ZipPixel live on ${BASE_URL}`));
