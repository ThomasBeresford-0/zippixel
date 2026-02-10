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
const nodemailer = require("nodemailer");

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});


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
    res.sendFile(path.join(PUBLIC_DIR, route === "/" ? "index.html" : `${route.slice(1)}.html`))
  );
});

app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/api/test-email", async (req, res) => {
  try {
    await mailer.sendMail({
      from: `"ZipPixel" <${process.env.SMTP_USER}>`,
      to: process.env.SMTP_USER,
      subject: "ZipPixel email test",
      text: "If you received this, email is working.",
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


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

// ====== UPLOAD ======
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

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _, cb) => {
      const dir = path.join(UPLOAD_DIR, req.params.jobId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_, file, cb) => {
      const safe = file.originalname.replace(/[^a-z0-9.\-_]/gi, "_");
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { files: PRO_MAX, fileSize: 25 * 1024 * 1024 },
  fileFilter: (_, file, cb) =>
    allowedMimes.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Invalid file type")),
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
  });
  res.json({ jobId });
});

app.post("/api/jobs/:jobId/upload", upload.array("images", PRO_MAX), (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    if (!req.files?.length) throw new Error("No files");

    req.files.forEach((f) =>
      job.files.push({
        path: f.path,
        originalname: f.originalname,
        mimetype: f.mimetype,
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
    const {
      jobId,
      printReady,
      keepNames,
      emailSafe,
      shareLink,
      namingPreset,
      dayPass,
    } = req.body;

    const job = getJob(jobId);
    const count = job.files.length;
    if (!count) throw new Error("No files");

    const tier = count > STANDARD_MAX ? "pro" : "standard";

    let total =
      tier === "pro" ? PRO_PRICE_GBP_PENCE : STANDARD_PRICE_GBP_PENCE;

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

    job.dayPassUntil = dayPass
      ? Date.now() + 24 * 60 * 60 * 1000
      : null;

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
  } catch (e) {
    res.status(404).json({ error: "Not found" });
  }
});


// ====== DOWNLOAD ======
app.get("/api/download/:jobId", async (req, res) => {
  try {
    const job = getJob(req.params.jobId);

    if (job.dayPassUntil && job.dayPassUntil > Date.now()) {
      job.status = "PAID";
    }

    if (job.status !== "PAID" && job.checkoutSessionId) {
      const s = await stripe.checkout.sessions.retrieve(job.checkoutSessionId);
      if (s.payment_status === "paid") job.status = "PAID";
    }

    if (job.status !== "PAID") return res.status(402).send("Not paid");

    if (job.options.shareLink && !job.shareToken) {
      job.shareToken = newShareToken();
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="zippixel_${Date.now()}.zip"`
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);

    for (let i = 0; i < job.files.length; i++) {
      const f = job.files[i];

      if (f.mimetype.startsWith("image/")) {
        const quality = job.options.printReady
          ? 95
          : job.options.emailSafe
          ? 70
          : 80;

        let name = job.options.keepNames
          ? f.originalname.replace(/\.[^.]+$/, ".jpg")
          : `image_${String(i + 1).padStart(2, "0")}.jpg`;

        if (job.options.namingPreset === "listing") {
          name = `listing_${String(i + 1).padStart(2, "0")}.jpg`;
        }

        const buf = await sharp(f.path)
          .rotate()
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();

        archive.append(buf, { name });
      } else {
        archive.file(f.path, { name: f.originalname });
      }
    }

    await archive.finalize();
  } catch (e) {
    res.status(400).send(e.message);
  }
});

// ====== SHARE LINK ======
app.get("/s/:token", (req, res) => {
  const job = [...jobs.values()].find((j) => j.shareToken === req.params.token);
  if (!job || job.status !== "PAID") return res.status(404).send("Not found");
  res.redirect(`/api/download/${job.jobId}`);
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
        // Send download email
      (async () => {
        try {
          if (!process.env.SMTP_USER) return;

          const downloadLink = `${BASE_URL}/success?jobId=${job.jobId}`;
          const shareLink =
            job.shareToken ? `${BASE_URL}/s/${job.shareToken}` : null;

          await mailer.sendMail({
            from: "ZipPixel <support@zippixel.it.com>",
            to: event.data.object.customer_details?.email,
            subject: "Your ZipPixel download is ready",
            html: `
              <h2>Your ZIP is ready</h2>
              <p>Download your files here:</p>
              <p><a href="${downloadLink}">${downloadLink}</a></p>
              ${
                shareLink
                  ? `<p><strong>Shareable link:</strong><br/><a href="${shareLink}">${shareLink}</a></p>`
                  : ""
              }
              <p style="margin-top:24px;font-size:13px;color:#666;">
                Files are auto-deleted after a short time.
              </p>
            `,
          });
        } catch (err) {
          console.error("Email send failed:", err.message);
        }
      })();
        if (job.options.shareLink) job.shareToken = newShareToken();
      }
    }

    res.json({ received: true });
  } catch (e) {
    res.status(400).send(e.message);
  }
}

app.listen(PORT, () =>
  console.log(`🚀 ZipPixel running at ${BASE_URL}`)
);
