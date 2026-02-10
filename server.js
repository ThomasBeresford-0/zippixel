// server.js
require("dotenv").config();

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

// ====== SECURITY ======
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));
app.post("/webhook", express.raw({ type: "application/json" }), webhookHandler);
app.use(express.json());

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

// ====== JOB STORAGE ======
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const jobs = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 60 * 60 * 1000) {
      try {
        fs.rmSync(path.join(UPLOAD_DIR, id), { recursive: true, force: true });
      } catch {}
      jobs.delete(id);
    }
  }
}, 300_000);

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

// ====== UPLOAD ======
// Allow ANY file type. Enforce count & size limits.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _, cb) => {
      const dir = path.join(UPLOAD_DIR, req.params.jobId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_, file, cb) => {
      const safe = sanitizeName(file.originalname)
        .replace(/[^a-z0-9.\-_ ]/gi, "_")
        .replace(/\s/g, "_");
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { files: PRO_MAX, fileSize: 25 * 1024 * 1024 },
  fileFilter: (_, __, cb) => cb(null, true),
});

// ====== API ======
app.post("/api/jobs", (_, res) => {
  const jobId = newId();
  jobs.set(jobId, {
    jobId,
    createdAt: Date.now(),
    status: "CREATED",
    files: [],
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

app.post("/api/jobs/:jobId/upload", upload.array("images", PRO_MAX), (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    if (!req.files?.length) throw new Error("No files");

    // Replace existing uploaded files for this job (prevents append-forever)
    if (job.files.length) {
      try {
        const dir = path.join(UPLOAD_DIR, req.params.jobId);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
      job.files = [];
    }

    req.files.forEach((f) =>
      job.files.push({
        path: f.path,
        originalname: sanitizeName(f.originalname),
        mimetype: f.mimetype || "application/octet-stream",
      })
    );

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
      try { res.status(500).send(err.message); } catch {}
    });
    archive.pipe(res);

    const usedNames = new Set();

    for (let i = 0; i < job.files.length; i++) {
      const f = job.files[i];
      const isImage = (f.mimetype || "").startsWith("image/");

      // Skip missing files rather than killing the whole download
      if (!f?.path || !fs.existsSync(f.path)) continue;

      if (isImage) {
        const quality = job.options.printReady ? 95 : job.options.emailSafe ? 70 : 80;

        let name = job.options.keepNames
          ? sanitizeName(f.originalname).replace(/\.[^.]+$/, ".jpg")
          : `image_${String(i + 1).padStart(2, "0")}.jpg`;

        if (job.options.namingPreset === "listing") {
          name = `listing_${String(i + 1).padStart(2, "0")}.jpg`;
        }

        name = makeUniqueName(name, usedNames);

        const buf = await sharp(f.path)
          .rotate()
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();

        archive.append(buf, { name });
      } else {
        const desired = sanitizeName(f.originalname);
        const name = makeUniqueName(desired, usedNames);
        archive.file(f.path, { name });
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
