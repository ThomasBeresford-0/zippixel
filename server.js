// server.js — ZipPixel (v13 MONEY MODE)
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const sharp = require("sharp");
const archiver = require("archiver");
const path = require("path");
const crypto = require("crypto");
const Stripe = require("stripe");

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

// ====== PRICING ======
const STANDARD_PRICE_GBP_PENCE = Number(process.env.STANDARD_PRICE_GBP_PENCE || 299);
const SHARE_LINK_UPSELL_PENCE = 249;

// ====== STRIPE ======
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ====== R2 ======
const R2_BUCKET = process.env.CF_R2_BUCKET;

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CF_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY,
  },
});

// ====== JOB STORE (IN-MEMORY MVP) ======
const jobs = new Map();

const newId = () => `job_${crypto.randomBytes(8).toString("hex")}`;
const newShareToken = () => crypto.randomBytes(16).toString("hex");

const getJob = (id) => {
  const job = jobs.get(id);
  if (!job) throw new Error("Job not found");
  return job;
};

const sanitizeName = (name) =>
  String(name || "file")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "file";

const makeUniqueName = (desired, used) => {
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
};

// ====== PAYMENT CHECK ======
async function ensurePaid(job) {
  if (job.status === "PAID") return true;

  if (job.checkoutSessionId) {
    const session = await stripe.checkout.sessions.retrieve(job.checkoutSessionId);
    if (session.payment_status === "paid") {
      job.status = "PAID";
      return true;
    }
  }
  return false;
}

// ====== SECURITY ======
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

app.post("/webhook", express.raw({ type: "application/json" }), webhookHandler);
app.use(express.json({ limit: "1mb" }));

// ====== STATIC ======
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

["/", "/success", "/cancel", "/privacy", "/terms", "/pricing"].forEach((route) => {
  app.get(route, (_, res) =>
    res.sendFile(path.join(PUBLIC_DIR, route === "/" ? "index.html" : `${route.slice(1)}.html`))
  );
});

// ====== JOB CREATE ======
app.post("/api/jobs", (_, res) => {
  const jobId = newId();
  jobs.set(jobId, {
    jobId,
    createdAt: Date.now(),
    status: "CREATED",
    files: [],
    options: { shareLink: false },
    shareToken: null,
    shareExpiresAt: null,
    downloadCount: 0,
  });
  res.json({ jobId });
});

// ====== PRESIGNED UPLOAD ======
app.post("/api/upload-url", async (req, res) => {
  const { jobId, filename, type } = req.body;
  getJob(jobId);

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
});

// ====== REGISTER FILES ======
app.post("/api/jobs/:jobId/register", (req, res) => {
  const job = getJob(req.params.jobId);
  job.files = req.body.files || [];
  job.status = "UPLOADED";
  res.json({ ok: true });
});

// ====== CHECKOUT ======
app.post("/api/checkout", async (req, res) => {
  const { jobId, shareLink } = req.body;
  const job = getJob(jobId);

  job.options.shareLink = !!shareLink;

  if (shareLink) {
    job.shareToken = newShareToken();
    job.shareExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  const total =
    STANDARD_PRICE_GBP_PENCE + (shareLink ? SHARE_LINK_UPSELL_PENCE : 0);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "gbp",
          unit_amount: total,
          product_data: { name: "ZipPixel Download" },
        },
        quantity: 1,
      },
    ],
    success_url: `${BASE_URL}/success?jobId=${jobId}`,
    cancel_url: `${BASE_URL}/cancel`,
  });

  job.checkoutSessionId = session.id;
  res.json({ url: session.url });
});

// ====== SHARE META ======
app.get("/api/share/:token", async (req, res) => {
  const job = [...jobs.values()].find((j) => j.shareToken === req.params.token);
  if (!job) return res.status(404).json({ error: "Not found" });

  if (!(await ensurePaid(job))) return res.status(404).json({ error: "Not found" });

  if (job.shareExpiresAt && Date.now() > job.shareExpiresAt) {
    return res.status(410).json({ error: "Expired" });
  }

  res.json({
    jobId: job.jobId,
    fileCount: job.files.length,
    downloads: job.downloadCount,
    expiresAt: job.shareExpiresAt,
  });
});

// ====== DOWNLOAD ======
app.get("/api/download/:jobId", async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!(await ensurePaid(job))) return res.status(402).send("Not paid");

  job.downloadCount++;

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="zippixel.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(res);

  const used = new Set();

  for (const f of job.files) {
    const obj = await r2.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: f.key,
      })
    );

    archive.append(obj.Body, {
      name: makeUniqueName(sanitizeName(f.originalname), used),
    });
  }

  await archive.finalize();
});

// ====== SHARE PAGE ======
app.get("/s/:token", async (req, res) => {
  const job = [...jobs.values()].find((j) => j.shareToken === req.params.token);
  if (!job) return res.status(404).send("Not found");

  if (!(await ensurePaid(job))) return res.status(404).send("Not found");

  if (job.shareExpiresAt && Date.now() > job.shareExpiresAt) {
    return res.status(410).send("Link expired");
  }

  res.sendFile(path.join(PUBLIC_DIR, "share.html"));
});

// ====== WEBHOOK ======
function webhookHandler(req, res) {
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === "checkout.session.completed") {
      // Status confirmed on-demand by ensurePaid()
    }

    res.json({ received: true });
  } catch (e) {
    res.status(400).send(e.message);
  }
}

app.listen(PORT, () =>
  console.log(`🚀 ZipPixel running at ${BASE_URL}`)
);
