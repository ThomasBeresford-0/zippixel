// server.js
const express = require("express");
const app = express();

app.use(express.static("public"));

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

// --- Stripe webhook MUST be raw body ---
app.post("/webhook", express.raw({ type: "application/json" }), webhookHandler);

// Normal JSON for everything else
app.use(express.json());

const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// In-memory jobs store (fast MVP)
const jobs = new Map(); // jobId -> { status, createdAt, files: [{path, originalname}], zipReady?:boolean }

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

const upload = multer({
  storage,
  limits: { files: 10, fileSize: 25 * 1024 * 1024 }
});

// --- Pages (simple) ---
app.get("/", (req, res) => {
  res.send(`
  <h1>ZipPixel</h1>
  <p>Upload up to 10 images → Pay £4.99 → Download ZIP</p>

  <button id="start">Start</button>
  <div id="box" style="margin-top:16px;display:none;">
    <input id="files" type="file" accept="image/*" multiple />
    <button id="upload">Upload</button>
    <button id="pay" disabled>Pay £4.99</button>
    <p id="status"></p>
  </div>

  <script>
    let jobId = null;
    const startBtn = document.getElementById("start");
    const box = document.getElementById("box");
    const filesEl = document.getElementById("files");
    const uploadBtn = document.getElementById("upload");
    const payBtn = document.getElementById("pay");
    const statusEl = document.getElementById("status");
    const setStatus = (m) => statusEl.textContent = m;

    startBtn.onclick = async () => {
      setStatus("Creating job...");
      const j = await fetch("/api/jobs", { method: "POST" }).then(r => r.json());
      jobId = j.jobId;
      box.style.display = "block";
      setStatus("Job created. Choose images.");
    };

    uploadBtn.onclick = async () => {
      if (!jobId) return setStatus("Click Start first.");
      const files = filesEl.files;
      if (!files || files.length === 0) return setStatus("Choose images first.");

      setStatus("Uploading...");
      const fd = new FormData();
      for (const f of files) fd.append("images", f);

      const up = await fetch(\`/api/jobs/\${jobId}/upload\`, { method: "POST", body: fd }).then(r => r.json());
      if (up.error) return setStatus(up.error);

      setStatus(\`Uploaded \${up.fileCount} images. Ready to pay.\`);
      payBtn.disabled = false;
    };

    payBtn.onclick = async () => {
      setStatus("Opening checkout...");
      const resp = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId })
      }).then(r => r.json());

      if (resp.error) return setStatus(resp.error);
      window.location.href = resp.url;
    };
  </script>
  `);
});

app.get("/success", (req, res) => {
  const jobId = req.query.jobId || "";
  res.send(`
    <h1>Payment successful ✅</h1>
    <p>If the button says “Not paid”, wait 2 seconds and refresh (webhook).</p>
    <a href="/api/download/${jobId}">Download ZIP</a>
    <p><a href="/">Back</a></p>
  `);
});

app.get("/cancel", (req, res) => {
  res.send(`<h1>Cancelled</h1><p><a href="/">Back</a></p>`);
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

    for (const f of req.files) job.files.push({ path: f.path, originalname: f.originalname });

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
    res.json({ url: session.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Paywall: only PAID can download
app.get("/api/download/:jobId", async (req, res) => {
  try {
    const job = getJob(req.params.jobId);
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
      jobs.get(jobId).status = "PAID";
    }
  }

  res.json({ received: true });
}

app.listen(PORT, () => console.log(`ZipPixel running at ${BASE_URL}`));
