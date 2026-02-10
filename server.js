// server.js
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const sharp = require("sharp");
const archiver = require("archiver");
const fs = require("fs");
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

// ====== PRICING ======
const STANDARD_MAX = 5;
const PRO_MAX = 10;

const STANDARD_PRICE_GBP_PENCE = Number(process.env.STANDARD_PRICE_GBP_PENCE || 299);
const PRO_PRICE_GBP_PENCE = Number(process.env.PRO_PRICE_GBP_PENCE || 499);

const PRINT_READY_UPSELL_PENCE = 199;
const EMAIL_SAFE_UPSELL_PENCE = 149;
const SHARE_LINK_UPSELL_PENCE = 249;
const DAY_PASS_PRICE_PENCE = 999;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ====== R2 SETUP ======
const R2_BUCKET = process.env.CF_R2_BUCKET;

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CF_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY,
  },
});

const requireR2Env = () => {
  const missing = [];
  if (!process.env.CF_ACCOUNT_ID) missing.push("CF_ACCOUNT_ID");
  if (!process.env.CF_R2_ACCESS_KEY_ID) missing.push("CF_R2_ACCESS_KEY_ID");
  if (!process.env.CF_R2_SECRET_ACCESS_KEY) missing.push("CF_R2_SECRET_ACCESS_KEY");
  if (!process.env.CF_R2_BUCKET) missing.push("CF_R2_BUCKET");
  if (missing.length) throw new Error(`Missing env: ${missing.join(", ")}`);
};

// ====== JOB STORAGE ======
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

// Make filenames unique inside the ZIP (avoid collisions)
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

// Optional: clean up old jobs + their R2 objects
async function deleteJobObjectsFromR2(jobId) {
  try {
    requireR2Env();
    const prefix = `${jobId}/`;
    let token;

    while (true) {
      const listed = await r2.send(
        new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          Prefix: prefix,
          ContinuationToken: token,
        })
      );

      const objects = (listed.Contents || []).map((o) => ({ Key: o.Key }));
      if (objects.length) {
        await r2.send(
          new DeleteObjectsCommand({
            Bucket: R2_BUCKET,
            Delete: { Objects: objects, Quiet: true },
          })
        );
      }

      if (!listed.IsTruncated) break;
      token = listed.NextContinuationToken;
    }
  } catch {
    // swallow cleanup errors
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 60 * 60 * 1000) {
      jobs.delete(id);
      // fire-and-forget cleanup (best effort)
      deleteJobObjectsFromR2(id);
    }
  }
}, 300_000);

// ====== PAID / READY HELPERS ======
const STRIPE_CHECK_COOLDOWN_MS = 2000;

async function ensurePaid(job) {
  // Day pass counts as paid
  if (job.dayPassUntil && job.dayPassUntil > Date.now()) {
    job.status = "PAID";
    return true;
  }

  if (job.status === "PAID") return true;

  // If we have a session, check Stripe (cooldown to avoid repeated API calls)
  if (job.checkoutSessionId) {
    const now = Date.now();
    if (job.lastStripeCheckAt && now - job.lastStripeCheckAt < STRIPE_CHECK_COOLDOWN_MS) {
      return job.lastStripePaid === true;
    }

    job.lastStripeCheckAt = now;

    const s = await stripe.checkout.sessions.retrieve(job.checkoutSessionId);
    const paid = s.payment_status === "paid";

    job.lastStripePaid = paid;
    if (paid) job.status = "PAID";

    return paid;
  }

  return false;
}

// ====== SECURITY ======
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

// IMPORTANT: Stripe webhook needs raw body BEFORE express.json
app.post("/webhook", express.raw({ type: "application/json" }), webhookHandler);

app.use(express.json({ limit: "1mb" }));

// ====== STATIC ======
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

["/", "/success", "/cancel", "/privacy", "/terms", "/pricing"].forEach((route) => {
  app.get(route, (req, res) =>
    res.sendFile(
      path.join(PUBLIC_DIR, route === "/" ? "index.html" : `${route.slice(1)}.html`)
    )
  );
});

app.get("/health", (_, res) => res.json({ ok: true }));

// ====== API ======
app.post("/api/jobs", (_, res) => {
  const jobId = newId();
  jobs.set(jobId, {
    jobId,
    createdAt: Date.now(),
    status: "CREATED",
    files: [], // [{ key, originalname, mimetype }]
    options: {
      printReady: false,
      keepNames: false,
      emailSafe: false,
      shareLink: false,
      namingPreset: null,
    },
    shareToken: null,
    dayPassUntil: null,

    // Stripe polling guard
    lastStripeCheckAt: null,
    lastStripePaid: false,
  });
  res.json({ jobId });
});

/**
 * NEW: Ask server for a presigned upload URL for R2.
 * Frontend will PUT the bytes to the returned `url`, then call register endpoint below.
 */
app.post("/api/upload-url", async (req, res) => {
  try {
    requireR2Env();

    const { jobId, filename, type } = req.body || {};
    if (!jobId || !filename) throw new Error("Missing jobId/filename");

    // Ensure job exists
    getJob(jobId);

    const safeName = sanitizeName(filename).replace(/\s/g, "_");
    const key = `${jobId}/${Date.now()}_${safeName}`;

    const cmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: type || "application/octet-stream",
    });

    const url = await getSignedUrl(r2, cmd, { expiresIn: 60 });
    res.json({ url, key });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * NEW: Register uploaded files (metadata only).
 * Body:
 * {
 *   files: [{ key, originalname, mimetype }]
 * }
 */
app.post("/api/jobs/:jobId/register", (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    const files = req.body?.files;

    if (!Array.isArray(files) || !files.length) throw new Error("No files");
    if (files.length > PRO_MAX) throw new Error("Too many files");

    // Replace existing files for the job
    job.files = files.map((f) => ({
      key: String(f.key || ""),
      originalname: sanitizeName(f.originalname || "file"),
      mimetype: String(f.mimetype || "application/octet-stream"),
    }));

    // Basic validation
    if (job.files.some((f) => !f.key || !f.key.startsWith(`${job.jobId}/`))) {
      throw new Error("Invalid file key(s)");
    }

    job.status = "UPLOADED";
    res.json({ ok: true, count: job.files.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ====== CHECKOUT ======
app.post("/api/checkout", async (req, res) => {
  try {
    const { jobId, printReady, keepNames, emailSafe, shareLink, namingPreset, dayPass } = req.body;

    const job = getJob(jobId);
    const count = job.files.length;
    if (!count) throw new Error("No files");

    const tier = count > STANDARD_MAX ? "pro" : "standard";

    let total = tier === "pro" ? PRO_PRICE_GBP_PENCE : STANDARD_PRICE_GBP_PENCE;

    if (printReady) total += PRINT_READY_UPSELL_PENCE;
    if (emailSafe) total += EMAIL_SAFE_UPSELL_PENCE;
    if (shareLink) total += SHARE_LINK_UPSELL_PENCE;
    if (dayPass) total = DAY_PASS_PRICE_PENCE;

    job.options = {
      printReady: !!printReady,
      keepNames: !!keepNames,
      emailSafe: !!emailSafe,
      shareLink: !!shareLink,
      namingPreset: namingPreset || null,
    };

    job.dayPassUntil = dayPass ? Date.now() + 24 * 60 * 60 * 1000 : null;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      metadata: {
        jobId,
        tier,
        printReady: String(!!printReady),
        emailSafe: String(!!emailSafe),
        shareLink: String(!!shareLink),
        dayPass: String(!!dayPass),
      },
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
    job.status = "CHECKOUT_CREATED";

    res.json({ url: session.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Paid-only info (legacy; keep if you want)
app.get("/api/job/:jobId", (req, res) => {
  try {
    const job = getJob(req.params.jobId);

    if (job.status !== "PAID") {
      return res.status(403).json({ error: "Not paid" });
    }

    res.json({
      jobId: job.jobId,
      options: job.options,
      shareToken: job.shareToken || null,
    });
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

// ====== READY (fast, no ZIP streaming) ======
app.get("/api/ready/:jobId", async (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    const paid = await ensurePaid(job);

    if (paid && job.options?.shareLink && !job.shareToken) {
      job.shareToken = newShareToken();
    }

    res.json({
      ready: paid,
      paid,
      shareToken: paid ? (job.shareToken || null) : null,
    });
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

// Optional fast probe (no streaming)
app.head("/api/download/:jobId", async (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    const paid = await ensurePaid(job);
    if (!paid) return res.status(402).end();
    return res.status(200).end();
  } catch {
    return res.status(404).end();
  }
});

// ====== DOWNLOAD ======
app.get("/api/download/:jobId", async (req, res) => {
  try {
    requireR2Env();

    const job = getJob(req.params.jobId);

    const paid = await ensurePaid(job);
    if (!paid) return res.status(402).send("Not paid");

    if (job.options.shareLink && !job.shareToken) {
      job.shareToken = newShareToken();
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="zippixel_${Date.now()}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      try {
        res.status(500).send(err.message);
      } catch {}
    });
    archive.pipe(res);

    const usedNames = new Set();

    for (let i = 0; i < job.files.length; i++) {
      const f = job.files[i];
      const isImage = (f.mimetype || "").startsWith("image/");

      if (!f?.key) continue;

      if (isImage) {
        const quality = job.options.printReady ? 95 : job.options.emailSafe ? 70 : 80;

        let name = job.options.keepNames
          ? sanitizeName(f.originalname).replace(/\.[^.]+$/, ".jpg")
          : `image_${String(i + 1).padStart(2, "0")}.jpg`;

        if (job.options.namingPreset === "listing") {
          name = `listing_${String(i + 1).padStart(2, "0")}.jpg`;
        }

        name = makeUniqueName(name, usedNames);

        const obj = await r2.send(
          new GetObjectCommand({
            Bucket: R2_BUCKET,
            Key: f.key,
          })
        );

        // Stream: R2 -> sharp -> zip (no buffering)
        const outStream = sharp()
          .rotate()
          .jpeg({ quality, mozjpeg: true });

        // obj.Body is a readable stream
        obj.Body.pipe(outStream);

        archive.append(outStream, { name });
      } else {
        const desired = sanitizeName(f.originalname);
        const name = makeUniqueName(desired, usedNames);

        const obj = await r2.send(
          new GetObjectCommand({
            Bucket: R2_BUCKET,
            Key: f.key,
          })
        );

        archive.append(obj.Body, { name });
      }
    }

    await archive.finalize();
  } catch (e) {
    res.status(400).send(e.message);
  }
});

// ====== SHARE LINK ======
app.get("/s/:token", async (req, res) => {
  try {
    const job = [...jobs.values()].find((j) => j.shareToken === req.params.token);
    if (!job) return res.status(404).send("Not found");

    const paid = await ensurePaid(job);
    if (!paid) return res.status(404).send("Not found");

    res.redirect(`/api/download/${job.jobId}`);
  } catch {
    res.status(404).send("Not found");
  }
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
      const jobId = event.data.object.metadata?.jobId;
      if (jobId && jobs.has(jobId)) {
        const job = jobs.get(jobId);
        job.status = "PAID";
        job.lastStripePaid = true;
        job.lastStripeCheckAt = Date.now();
        if (job.options.shareLink && !job.shareToken) job.shareToken = newShareToken();
      }
    }

    res.json({ received: true });
  } catch (e) {
    res.status(400).send(e.message);
  }
}

app.listen(PORT, () => console.log(`🚀 ZipPixel running at ${BASE_URL}`));
