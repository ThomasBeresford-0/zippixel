// public/app.js — PDFOperations frontend (v17.7 - NO PRICE UNTIL UPLOAD + PAGE-LEVEL PDF MERGE (DRAG PAGES) + ORDER SYNC)
// Matches: index.html + tool pages + server.js routes:
// /api/jobs, /api/upload-url, /api/jobs/:jobId/register, /api/jobs/:jobId/mode, /api/checkout
(() => {
  // ====== YEAR ======
  const y = document.getElementById("y");
  if (y) y.textContent = new Date().getFullYear();

  // ====== LIMITS ======
  const MAX_FILES = 50;
  const MAX_MB_EACH = 25;

  // ====== TOOL PRICING ======

  // ====== PAGE-LEVEL PRICING (MONEY MODE) ======
    const PAGE_PRICING = {
      "/compress-pdf-under-1mb": 3.99,
      "/compress-pdf-under-2mb": 3.49,
      "/compress-pdf-for-job-application": 4.99,
      "/compress-pdf-for-email": 3.49
    };

  const TOOL_PRICING = {
    image_compress: 2.99,
    compress_pdf: 2.99,
    merge_pdf: 2.99,
    split_pdf: 2.99,
    rotate_pdf: 2.99,
    new_tool_name: 3.99,


    watermark_pdf: 3.99,

    sign_pdf: 4.99,
    edit_pdf: 4.99,

    convert: 2.99
  };

  // File count upgrade (large jobs)
  const PRO_FILE_LIMIT = 10;
  const PRO_FILE_PRICE = 9.99;

  // Share link
  const SHARE_LINK_PRICE = 2.49;
  // ZIP tiers (used by getTier + modal labels)
  const TIER_10_LIMIT = 10;
  const TIER_50_LIMIT = 50;
  const TIER_10_PRICE = 2.99;
  const TIER_50_PRICE = 9.99;
  // ====== DOM ======
  const dropzone = document.getElementById("dropzone");
  const filesEl = document.getElementById("files");
  const chooseBtn = document.getElementById("chooseBtn");
  const clearBtn = document.getElementById("clearBtn");

  const uploadBtn = document.getElementById("upload");
  const continueBtn = document.getElementById("continue");
  const unlockBtn = document.getElementById("unlockBtn");

  const statusEl = document.getElementById("status");
  const statusHint = document.getElementById("statusHint");
  const spinner = document.getElementById("spinner");

  const fileMeta = document.getElementById("fileMeta");
  const fileSummary = document.getElementById("fileSummary");
  const fileList = document.getElementById("fileList");

  const progressWrap = document.getElementById("progressWrap");
  const progressFill = document.getElementById("progressFill");
  const progressPct = document.getElementById("progressPct");
  const progressLabel = document.getElementById("progressLabel");
  const progressMeta = document.getElementById("progressMeta");

  // Optional dropzone copy hooks
  const dzTitleEl = document.getElementById("dzTitle");
  const dzSubEl = document.getElementById("dzSub");
  const dzAfterEl = document.getElementById("dzAfter"); // may not exist

  // Modal (may not exist on some tool pages)
  const priceModal = document.getElementById("priceModal"); // overlay
  const modalCloseBtn = document.getElementById("modalCloseBtn");
  const modalBackBtn = document.getElementById("modalBackBtn");
  const modalPayBtn = document.getElementById("modalPayBtn");
  const optShareLink = document.getElementById("optShareLink");

  // Modal: internal pricing grid (HIDE until upload is complete + continue pressed)
  const priceGridEl = priceModal ? priceModal.querySelector(".priceGrid") : null;

  // Legacy IDs (kept)
  const optPrintReady = document.getElementById("optPrintReady");
  const optEmailSafe = document.getElementById("optEmailSafe");
  const optKeepNames = document.getElementById("optKeepNames");
  const optListingNames = document.getElementById("optListingNames");
  const optDayPass = document.getElementById("optDayPass");

  const rowStandard = document.getElementById("rowStandard");
  const rowPro = document.getElementById("rowPro");

  const tierInline = document.getElementById("tierInline");
  const priceInline = document.getElementById("priceInline");
  const countInline = document.getElementById("countInline");
  const priceModalLead = document.getElementById("priceModalLead");
  const priceModalNote = document.getElementById("priceModalNote");

  // Mode UI (exists on index; hidden radios exist on tool pages)
  const modeCompress = document.getElementById("modeCompress");
  const modeCompressPdf = document.getElementById("modeCompressPdf");
  const modeConvert = document.getElementById("modeConvert");
  const modeMergePdf = document.getElementById("modeMergePdf");
  const modeSplitPdf = document.getElementById("modeSplitPdf");

  // NEW (optional) rotate mode radio — safe if missing
  const modeRotatePdf = document.getElementById("modeRotatePdf");
  const modeWatermarkPdf = document.getElementById("modeWatermarkPdf");
  const modeSignPdf = document.getElementById("modeSignPdf");
  const modeEditPdf = document.getElementById("modeEditPdf");

  const convertRow = document.getElementById("convertRow");
  const convertFrom = document.getElementById("convertFrom"); // informational
  const convertTarget = document.getElementById("convertTarget");

  // Compress PDF controls
  const pdfCompressRow = document.getElementById("pdfCompressRow");
  const pdfCompressLevel = document.getElementById("pdfCompressLevel");

  // Presets on compress-pdf page (and can exist elsewhere)
  const presetButtons = Array.from(document.querySelectorAll("[data-preset-level]"));

  // Rotate controls (optional)
  const rotateButtons = Array.from(document.querySelectorAll("[data-rotate-deg]"));
  const rotateSelect = document.getElementById("rotateDegrees"); // optional

  // PDF reorder UI (merge page)
  let pdfPageOrder = [];
  // Split page order (1-based page numbers from split-pdf.html)
  const getSplitPageOrder = () => {
    if (mode !== "split_pdf") return null;
    if (!Array.isArray(window.__PDFOPS_PAGE_ORDER__)) return null;
    if (!window.__PDFOPS_PAGE_ORDER__.length) return null;
    return window.__PDFOPS_PAGE_ORDER__.slice(); // clone
  };

  const pdfReorderWrap = document.getElementById("pdfReorderWrap");
  const pdfThumbGrid = document.getElementById("pdfThumbGrid");

  // Optional elements (if present on your merge page)
  const pdfReorderResetBtn = document.getElementById("pdfReorderReset"); // optional
  const pdfReorderCountEl = document.getElementById("pdfReorderCount"); // optional
  const pdfThumbNoteEl = document.getElementById("pdfThumbNote"); // optional

  // Optional preview modal (if present)
  const pdfPreviewModal = document.getElementById("pdfPreviewModal");
  const pdfPreviewClose = document.getElementById("pdfPreviewClose");
  const pdfPreviewTitle = document.getElementById("pdfPreviewTitle");
  const pdfPreviewCanvas = document.getElementById("pdfPreviewCanvas");

  // Page tool hint (optional)
  const pageTool = (document.body?.dataset?.tool || "").trim(); // e.g. "compress_pdf"
  

    const pageTargetBytesRaw = document.body?.dataset?.targetBytes || "";
  const pageTargetBytes = Number(pageTargetBytesRaw);
  const targetBytes =
    Number.isFinite(pageTargetBytes) && pageTargetBytes > 0
      ? pageTargetBytes
      : null;

  // If this page doesn’t have the tool, bail quietly
  if (!dropzone || !filesEl || !chooseBtn || !uploadBtn || !continueBtn) return;

  // ====== STATE ======
  let jobId = null;
  let creatingJob = false;
  let uploading = false;

  let selected = []; // Array<File>
  const thumbUrls = new Map(); // keyOf(file) -> objectURL (images only)
  let uploadedMeta = []; // [{ key, originalname, mimetype }]
  let compressPreviewState = "idle"; // idle | loading | ready | failed
  let compressPreviewError = "";

  // ====== EXPOSE SELECTION TO TOOL PAGES (rotate preview etc.) ======
  const publishSelected = () => {
    try {
      window.__PDFOPS_SELECTED__ = selected.slice();
      document.dispatchEvent(new CustomEvent("pdfops:selected", {
        detail: { files: window.__PDFOPS_SELECTED__.slice() }
      }));
    } catch {}
  };

  // ====== MODE STATE ======
  // compress | compress_pdf | convert | merge_pdf | split_pdf | rotate_pdf
  let mode = "compress";
  let convertTargetValue = null;

  // Compress PDF level
  let pdfCompressLevelValue = "balanced"; // balanced | light | max

  // Rotate degrees
  let rotateDegreesValue = 90; // 90 | 180 | 270

  // ====== UX MEMORY (localStorage) ======
  const LS = {
    lastMode: "po:lastMode",
    lastTarget: "po:lastTarget",
    lastPdfLevel: "po:lastPdfLevel",
    lastRotateDeg: "po:lastRotateDeg",
    sharePref: "po:sharePref", // "on" | "off"
    shareSeen: "po:shareSeen", // "1" once they've seen the modal
    lastJob: "po:lastJobId",
    lastFilesCount: "po:lastFilesCount",
  };

  // ====== HELPERS ======
  const setStatus = (m) => {
    if (statusEl) statusEl.textContent = m;
  };
  const setHint = (m) => {
    if (statusHint) statusHint.innerHTML = m;
  };
  const setBusy = (on) => {
    if (spinner) spinner.classList.toggle("isOn", !!on);
  };

  const humanMB = (bytes) => (bytes / (1024 * 1024)).toFixed(1) + "MB";
    const humanFileSize = (bytes) => {
    const n = Number(bytes || 0);
    if (!Number.isFinite(n) || n <= 0) return "0 MB";
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  };
  const escapeHtml = (str) =>
    String(str).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const keyOf = (f) => `${f.name}__${f.size}__${f.lastModified}`;

  const isImageFile = (f) => (f?.type || "").startsWith("image/");
  const isPdfFile = (f) => {
    const t = String(f?.type || "").toLowerCase();
    if (t === "application/pdf") return true;
    const name = String(f?.name || "");
    return /\.pdf$/i.test(name);
  };

  const getExt = (name) => {
    const base = String(name || "").trim();
    const idx = base.lastIndexOf(".");
    if (idx <= 0 || idx === base.length - 1) return "";
    return base.slice(idx + 1).toUpperCase();
  };

  const getTypeLabel = (f) => {
    if (isImageFile(f)) return (f.type ? f.type.split("/")[1]?.toUpperCase() : "IMAGE") || "IMAGE";
    if (isPdfFile(f)) return "PDF";
    const ext = getExt(f.name);
    return ext || (f.type ? f.type.toUpperCase() : "FILE");
  };

  const setUploaderEnabled = (enabled) => {
    try {
      filesEl.disabled = !enabled;
    } catch {}
    try {
      chooseBtn.disabled = !enabled;
    } catch {}
    dropzone.setAttribute("aria-disabled", enabled ? "false" : "true");
    dropzone.classList.toggle("isDisabled", !enabled);
  };

  const resetProgress = () => {
    if (!progressWrap) return;
    progressWrap.hidden = true;
    if (progressFill) progressFill.style.width = "0%";
    if (progressPct) progressPct.textContent = "0%";
    if (progressLabel) progressLabel.textContent = "";
    if (progressMeta) progressMeta.textContent = "";
  };

  const revokeRemovedThumbs = (currentKeys) => {
    for (const [k, url] of thumbUrls.entries()) {
      if (!currentKeys.has(k)) {
        URL.revokeObjectURL(url);
        thumbUrls.delete(k);
      }
    }
  };

  const getThumbUrl = (f) => {
    const k = keyOf(f);
    if (thumbUrls.has(k)) return thumbUrls.get(k);
    const url = URL.createObjectURL(f);
    thumbUrls.set(k, url);
    return url;
  };

  const getTier = (count) => {
    const n = Number(count || 0);
    if (!Number.isFinite(n) || n <= 0) return { name: "ZIP", limit: TIER_10_LIMIT, base: TIER_10_PRICE, key: "zip10" };
    if (n <= TIER_10_LIMIT) return { name: "ZIP", limit: TIER_10_LIMIT, base: TIER_10_PRICE, key: "zip10" };
    return { name: "Pro ZIP", limit: TIER_50_LIMIT, base: TIER_50_PRICE, key: "zip50" };
  };

  const calcTotal = () => {
    const fileCount = selected.length;
    const share = !!optShareLink?.checked;

  const pathname = window.location.pathname || "/";
  let base =
    PAGE_PRICING[pathname] ??
    TOOL_PRICING[mode] ??
    2.99;
      // Upgrade large jobs
      if (fileCount > PRO_FILE_LIMIT) {
        base = PRO_FILE_PRICE;
      }

    return base + (share ? SHARE_LINK_PRICE : 0);
  };

  const disableLegacyOptions = () => {
    [optPrintReady, optEmailSafe, optKeepNames, optListingNames, optDayPass].forEach((el) => {
      if (!el) return;
      el.checked = false;
      el.disabled = true;
    });
  };

  const safeLocalSet = (k, v) => {
    try {
      localStorage.setItem(k, String(v));
    } catch {}
  };
  const safeLocalGet = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };

  const hardResetJob = (reason) => {
    jobId = null;
    creatingJob = false;
    uploadedMeta = [];
    compressPreviewState = "idle";
    compressPreviewError = "";
    resetProgress();

    const preview = document.getElementById("resultPreview");
    if (preview) preview.style.display = "none";
    if (continueBtn) continueBtn.style.display = "";

    const originalSizeEl = document.getElementById("originalSize");
    const newSizeEl = document.getElementById("newSize");
    const savingsEl = document.getElementById("savingsPct");

    if (originalSizeEl) originalSizeEl.textContent = "—";
    if (newSizeEl) newSizeEl.textContent = "—";
    if (savingsEl) savingsEl.textContent = "↓ —% smaller";

    if (unlockBtn) {
      unlockBtn.disabled = true;
      unlockBtn.classList.add("isDisabled");
      unlockBtn.textContent = "Unlock Download →";
    }

    if (reason) {
      setStatus("Ready");
      setHint(reason);
    }

    disarmPricingUI();
  };

  // ====== NO PRICE UNTIL UPLOADED: MODAL PRICING GATES ======
  const disarmPricingUI = () => {
    // Keep modal itself usable, but hide any “price surfaces” until Continue is pressed after upload.
    if (priceGridEl) priceGridEl.hidden = true;
    if (priceInline) priceInline.textContent = "—";
    if (tierInline) tierInline.textContent = tierInline.textContent || "—";
  };

  const armPricingUI = () => {
    if (priceGridEl) priceGridEl.hidden = false;
  };

  // Ensure we start in "no price" state on every page load (even if HTML has amounts).
  disarmPricingUI();

  // ====== ROTATE HELPERS ======
  const normalizeRotateDeg = (deg) => {
    const n = Number(deg);
    if (!Number.isFinite(n)) return 90;
    const i = Math.round(n);
    if (i === 180) return 180;
    if (i === 270) return 270;
    return 90;
  };

    // Per-page rotate map (rotate-pdf.html sets this)
  const getRotateMap = () => {
    if (mode !== "rotate_pdf") return null;

    const m = window.__PDFOPS_ROTATE_MAP__;
    if (!Array.isArray(m) || m.length < 2) return null;

    // Validate/sanitize: index = page number (1-based)
    const out = m.slice();
    for (let i = 1; i < out.length; i++) {
      const raw = Number(out[i] || 0);
      if (raw === 0) {
        out[i] = 0;
        continue;
      }
      const v = normalizeRotateDeg(raw);
      out[i] = v;
      if (![90, 180, 270].includes(out[i])) out[i] = 0;
    }

    return out;
  };

  const setRotateActive = (deg) => {
    const wanted = normalizeRotateDeg(deg);
    if (rotateSelect) rotateSelect.value = String(wanted);

    if (!rotateButtons.length) return;
    rotateButtons.forEach((btn) => {
      const b = normalizeRotateDeg(btn.getAttribute("data-rotate-deg"));
      const active = b === wanted;
      btn.classList.toggle("isActive", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  };

  const applyRotateDeg = (deg, reason) => {
    rotateDegreesValue = normalizeRotateDeg(deg);
    safeLocalSet(LS.lastRotateDeg, rotateDegreesValue);
    setRotateActive(rotateDegreesValue);

    if (reason && (uploadedMeta.length || jobId)) {
      hardResetJob(`${reason} — please upload again.`);
    }

    setDropzoneCopy();
    setPrimaryStates();
    renderSelected();
  };

  rotateButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = btn.getAttribute("data-rotate-deg");
      applyRotateDeg(d, "Rotation changed");
    });
  });

  rotateSelect?.addEventListener("change", () => {
    applyRotateDeg(rotateSelect.value, "Rotation changed");
  });

  // ====== SMART COPY (NO PAYMENT MENTIONS) ======
  const setDropzoneCopy = () => {
    if (!dzTitleEl || !dzSubEl) return;

    if (mode === "merge_pdf") {
      dzTitleEl.textContent = "Drop PDFs here";
      dzSubEl.textContent = "PDFs only • 2+ files • Up to 50";
      if (dzAfterEl) dzAfterEl.textContent = "";
      return;
    }

    if (mode === "split_pdf") {
      dzTitleEl.textContent = "Drop a PDF here";
      dzSubEl.textContent = "PDF only • 1 file (replaces the current PDF)";
      if (dzAfterEl) dzAfterEl.textContent = "";
      return;
    }

    if (mode === "compress_pdf") {
      dzTitleEl.textContent =
        targetBytes === 1048576
          ? "Drop a PDF to get under 1MB"
          : "Drop a PDF here";

      dzSubEl.textContent =
        targetBytes === 1048576
          ? "PDF only • 1 file • Strict 1MB limit"
          : targetBytes
            ? `PDF only • 1 file • Target under ${(targetBytes / (1024 * 1024)).toFixed(1)}MB`
            : "PDF only • 1 file • Reduce file size";

      if (dzAfterEl) dzAfterEl.textContent = "";
      return;
    }

    if (mode === "rotate_pdf") {
      dzTitleEl.textContent = "Drop a PDF here";
      dzSubEl.textContent = "PDF only • 1 file • Rotate pages";
      if (dzAfterEl) dzAfterEl.textContent = "";
      return;
    }

  if (mode === "image_compress") {
    dzTitleEl.textContent = "Drop your images here";
    dzSubEl.textContent = "JPG, PNG, WebP • Reduce file size fast";
    if (dzAfterEl) dzAfterEl.textContent = "";
    return;
  }

  if (mode === "convert") {
    dzTitleEl.textContent = "Drop files here";
    dzSubEl.textContent = "Up to 50 files • Drag & drop or select";
    if (dzAfterEl) dzAfterEl.textContent = "";
    return;
  }

  dzTitleEl.textContent = "Drop files here";
  dzSubEl.textContent = "Up to 50 files • Drag & drop or select";
  if (dzAfterEl) dzAfterEl.textContent = "";
  }

  const setFileInputAccept = () => {
    if (!filesEl) return;

    if (mode === "image_compress") {
      filesEl.setAttribute("accept", "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp");
      return;
    }

    if (
      mode === "merge_pdf" ||
      mode === "split_pdf" ||
      mode === "compress_pdf" ||
      mode === "rotate_pdf" ||
      mode === "watermark_pdf" ||
      mode === "sign_pdf" ||
      mode === "edit_pdf"
    ) {
      filesEl.setAttribute("accept", "application/pdf,.pdf");
    } else {
      filesEl.removeAttribute("accept");
    }
  };

  const modeMinFilesSatisfied = () => {
    if (mode === "merge_pdf") return selected.length >= 2;
    if (mode === "split_pdf") return selected.length === 1;
    if (mode === "compress_pdf") return selected.length === 1;
    if (mode === "rotate_pdf") return selected.length === 1;
    if (mode === "watermark_pdf") return selected.length === 1;
    if (mode === "sign_pdf") return selected.length === 1;
    if (mode === "edit_pdf") return selected.length === 1;
    return selected.length >= 1;
  };

  const validateFileBase = (f) => {
    if (!f) return "Invalid file.";
    if (f.size > MAX_MB_EACH * 1024 * 1024) {
      return `“${f.name}” is ${humanMB(f.size)} (max ${MAX_MB_EACH}MB).`;
    }
    return null;
  };

  const validateFileForMode = (f) => {
    const baseErr = validateFileBase(f);
    if (baseErr) return baseErr;

    if (mode === "image_compress" && !isImageFile(f)) {
      return `“${f.name}” isn’t an image. Compress Image only accepts JPG, PNG or WebP files.`;
    }

    const pdfOnly =
      mode === "merge_pdf" ||
      mode === "split_pdf" ||
      mode === "compress_pdf" ||
      mode === "rotate_pdf" ||
      mode === "watermark_pdf" ||
      mode === "sign_pdf" ||
      mode === "edit_pdf";

    if (pdfOnly && !isPdfFile(f)) {
    const label =
      mode === "merge_pdf" ? "Merge PDFs"
      : mode === "split_pdf" ? "Split PDF"
      : mode === "compress_pdf" ? "Compress PDF"
      : mode === "rotate_pdf" ? "Rotate PDF"
      : mode === "watermark_pdf" ? "Watermark PDF"
      : mode === "sign_pdf" ? "Sign PDF"
      : mode === "edit_pdf" ? "Edit PDF"
      : "This tool";
      return `“${f.name}” isn’t a PDF. ${label} only accepts PDF files.`;
    }

    return null;
  };

  // ====== SHARE DEFAULT ======
  const shouldRecommendShare = () => {
    const n = selected.length;
    const totalBytes = selected.reduce((a, f) => a + (f?.size || 0), 0);
    if (mode === "merge_pdf") return true;
    if (mode === "split_pdf") return true;
    if (mode === "compress_pdf") return true;
    if (mode === "rotate_pdf") return true;
    if (n >= 8) return true;
    if (totalBytes >= 20 * 1024 * 1024) return true;
    return false;
  };

  const applyShareDefault = () => {
    if (!optShareLink) return;

    const seen = safeLocalGet(LS.shareSeen) === "1";
    const pref = safeLocalGet(LS.sharePref);

    if (seen) {
      if (pref === "on") {
        optShareLink.checked = true;
        return;
      }
      if (pref === "off") {
        optShareLink.checked = false;
        return;
      }
    }

    optShareLink.checked = shouldRecommendShare();
  };

  const rememberSharePref = () => {
    if (!optShareLink) return;
    safeLocalSet(LS.sharePref, optShareLink.checked ? "on" : "off");
  };

  // ====== BUTTON STATES ======
  const showContinue = (enabled) => {
    const previewVisible =
      mode === "compress_pdf" &&
      document.getElementById("resultPreview") &&
      document.getElementById("resultPreview").style.display !== "none";

    continueBtn.style.display = previewVisible ? "none" : "";
    continueBtn.disabled = !enabled;
    continueBtn.classList.toggle("isDisabled", !enabled);
  };

  const setPrimaryStates = () => {
    const hasFiles = selected.length > 0;
    const hasJob = !!jobId;
    const meetsMin = modeMinFilesSatisfied();

    const canUpload = hasFiles && meetsMin && hasJob && !uploading;
    const pathname = window.location.pathname || "/";
    const isHomepageCompress = pathname === "/" && mode === "compress_pdf";

    if (isHomepageCompress) {
      uploadBtn.style.display = "none";
    } else {
      uploadBtn.style.display = "";
    }

    const canContinue = !!uploadedMeta.length && !uploading;

    uploadBtn.disabled = !canUpload;
    uploadBtn.classList.toggle("isDisabled", !canUpload);

    showContinue(canContinue);

    if (mode === "merge_pdf") {
      uploadBtn.textContent = uploading ? "Uploading…" : uploadedMeta.length ? "Re-upload PDFs" : "Upload PDFs";
    } else if (mode === "split_pdf") {
      uploadBtn.textContent = uploading ? "Uploading…" : uploadedMeta.length ? "Re-upload PDF" : "Upload PDF";
    } else if (mode === "compress_pdf") {
      uploadBtn.textContent = uploading ? "Uploading…" : uploadedMeta.length ? "Re-upload PDF" : "Upload PDF";
    } else if (mode === "rotate_pdf") {
      uploadBtn.textContent = uploading ? "Uploading…" : uploadedMeta.length ? "Re-upload PDF" : "Upload PDF";
    } else if (mode === "image_compress") {
      uploadBtn.textContent = uploading ? "Uploading…" : uploadedMeta.length ? "Re-upload images" : "Upload images";
    } else {
      uploadBtn.textContent = uploading ? "Uploading…" : uploadedMeta.length ? "Re-upload" : "Upload files";
    }

    continueBtn.textContent =
      mode === "image_compress"
        ? "Download smaller images →"
        : mode === "compress_pdf"
          ? "Unlock Download →"
          : "Review & Continue →";

    setUploaderEnabled(!(uploading || creatingJob));

    // unlock button state
    if (unlockBtn) {
      const previewVisible =
        mode === "compress_pdf" &&
        compressPreviewState === "ready" &&
        document.getElementById("resultPreview") &&
        document.getElementById("resultPreview").style.display !== "none";

      unlockBtn.disabled = !previewVisible;
      unlockBtn.classList.toggle("isDisabled", !previewVisible);
    }

    if (!hasFiles) {
      setStatus("Ready");
      setHint(
        mode === "merge_pdf"
          ? "Add <b>2+</b> PDFs to begin."
          : mode === "split_pdf"
            ? "Add <b>1</b> PDF to begin."
            : mode === "compress_pdf"
              ? "Add <b>1</b> PDF to begin."
              : mode === "rotate_pdf"
                ? "Add <b>1</b> PDF to begin."
                : mode === "convert"
                  ? "Choose a target format, then add files."
                  : mode === "image_compress"
                    ? "Add JPG, PNG or WebP images to begin."
                    : "Add up to <b>50</b> files to begin."
      );
      return;
    }

    if (mode === "merge_pdf" && !meetsMin) {
      setStatus("Add one more PDF");
      setHint("Merge PDFs needs <b>2+</b> PDF files.");
      return;
    }

    if (mode === "split_pdf" && !meetsMin) {
      setStatus("Add a PDF");
      setHint("Split PDF accepts <b>1</b> PDF only.");
      return;
    }

    if (mode === "compress_pdf" && !meetsMin) {
      setStatus("Add a PDF");
      setHint("Compress PDF accepts <b>1</b> PDF only.");
      return;
    }

    if (mode === "rotate_pdf" && !meetsMin) {
      setStatus("Add a PDF");
      setHint("Rotate PDF accepts <b>1</b> PDF only.");
      return;
    }

    if (!hasJob) {
      setStatus("Preparing");
      setHint("Setting up a secure upload…");
      return;
    }

    if (uploadedMeta.length) {
      if (mode === "compress_pdf") {
        if (compressPreviewState === "loading") {
          setStatus("Compressing");
          setHint("Preparing your compressed PDF preview…");
          return;
        }

        if (compressPreviewState === "ready") {
          setStatus("Your PDF is ready");
          setHint("Your file has been compressed. Unlock download to get it.");
          return;
        }

        if (compressPreviewState === "failed") {
          setStatus("Preview failed");
          setHint(`Preview failed: ${escapeHtml(compressPreviewError || "Could not prepare preview.")}`);
          return;
        }
      }

      setStatus("Uploaded");
      setHint("Upload complete. Continue when ready.");
      return;
    }

    setStatus("Ready");
    setHint(
      mode === "merge_pdf"
        ? "Upload your PDFs to continue."
        : mode === "split_pdf"
          ? "Upload your PDF to continue."
          : mode === "compress_pdf"
            ? "Upload your PDF to continue."
            : mode === "rotate_pdf"
              ? "Upload your PDF to continue."
              : mode === "convert"
                ? "Upload files to continue."
                : mode === "image_compress"
                  ? "Upload your images to continue."
                  : "Upload your files to continue."
    );
  };

  // ====== MODAL UI ======
  const syncModalTierUI = () => {
    const n = selected.length;
    const tier = getTier(n);

    const tierLabel =
      mode === "merge_pdf"
        ? "Merged PDF"
        : mode === "split_pdf"
          ? "Split PDF"
          : mode === "compress_pdf"
            ? "Compressed PDF"
            : mode === "rotate_pdf"
              ? (getRotateMap() ? "Rotate PDF (per-page)" : `Rotate PDF → ${rotateDegreesValue}°`)
              : mode === "convert"
                ? `Convert → ${(convertTargetValue || "JPG").toUpperCase()}`
                : tier.key === "zip50"
                  ? "Pro ZIP"
                  : "ZIP";

    if (tierInline) tierInline.textContent = tierLabel;
    if (countInline) countInline.textContent = String(n);

    if (rowStandard) rowStandard.classList.toggle("isChosen", tier.key === "zip10");
    if (rowPro) rowPro.classList.toggle("isChosen", tier.key === "zip50");

    if (priceModalLead) {
      if (mode === "merge_pdf") {
        priceModalLead.innerHTML = `You’re merging <b>${n}</b> PDF${n === 1 ? "" : "s"} into a single <b>PDF</b>.`;
      } else if (mode === "split_pdf") {
        priceModalLead.innerHTML = `You’re splitting <b>1</b> PDF into separate <b>pages</b>.`;
      } else if (mode === "compress_pdf") {
        const lvl = pdfCompressLevelValue === "max" ? "Maximum" : pdfCompressLevelValue === "light" ? "Light" : "Balanced";
        priceModalLead.innerHTML = `You’re compressing <b>1</b> PDF at <b>${lvl}</b> level.`;
      } else if (mode === "rotate_pdf") {
        const rm = getRotateMap();
        if (rm) {
          const pages = rm.length - 1;
          let changed = 0;
          for (let i = 1; i <= pages; i++) if ((rm[i] || 0) !== 0) changed++;
          priceModalLead.innerHTML = changed
            ? `You’re rotating <b>${changed}</b> page${changed === 1 ? "" : "s"} inside <b>1</b> PDF.`
            : `You’re rotating pages inside <b>1</b> PDF (no changes yet).`;
        } else {
          priceModalLead.innerHTML = `You’re rotating <b>1</b> PDF by <b>${rotateDegreesValue}°</b>.`;
        }
      } else if (mode === "convert") {
        priceModalLead.innerHTML = `You’re converting <b>${n}</b> file${n === 1 ? "" : "s"} to <b>${escapeHtml(
          (convertTargetValue || "jpg").toUpperCase()
        )}</b>.`;
      } else {
        priceModalLead.innerHTML = `You’re continuing with <b>${n}</b> file${n === 1 ? "" : "s"}.`;
      }
    }  };

  const syncModalTotalUI = () => {
    const total = calcTotal();
    if (priceInline) priceInline.textContent = `£${total.toFixed(2)}`;
  };

  // =========================================================
  // PAGE-LEVEL MERGE (DRAG PAGES) — FRONTEND ENGINE
  // =========================================================

  const hasPdfJs = () => typeof window !== "undefined" && !!window.pdfjsLib && typeof window.pdfjsLib.getDocument === "function";

  const PAGE_MERGE = {
    MAX_THUMBS: 180,
    THUMB_W: 240,
    RENDER_CONCURRENCY: 1,
  };

  let _mergeBuildToken = 0;
  let _mergeBytesByFile = [];
  let _mergeOriginalOrder = [];
  let _mergeDragKey = null;
  let _mergeThrottledModeTimer = null;

  const setPdfOrder = (nextOrder) => {
    pdfPageOrder = Array.isArray(nextOrder) ? nextOrder.slice() : [];
    try {
      window.__pdfopsPageOrder = pdfPageOrder.slice();
    } catch {}

    if (mode === "merge_pdf" && jobId) {
      if (_mergeThrottledModeTimer) clearTimeout(_mergeThrottledModeTimer);
      _mergeThrottledModeTimer = setTimeout(() => {
        setBackendMode().catch(() => {});
      }, 180);
    }
  };

  document.addEventListener("pdfops:pageorder", (e) => {
    const order = e?.detail?.order;
    if (Array.isArray(order) && order.length) setPdfOrder(order);
  });

  const mergeUpdateCount = () => {
    if (!pdfReorderCountEl) return;
    if (!pdfPageOrder.length) {
      pdfReorderCountEl.textContent = "";
      return;
    }
    pdfReorderCountEl.textContent = ` • ${pdfPageOrder.length} page${pdfPageOrder.length === 1 ? "" : "s"}`;
  };

    // Rotate map changes (rotate-pdf.html dispatches this)
  document.addEventListener("pdfops:rotatemap", () => {
    if (mode !== "rotate_pdf") return;

    // If they changed rotations after upload, the backend needs the new plan
    if (uploadedMeta.length || jobId) {
      hardResetJob("Rotation changed — please upload again.");
    }

    setPrimaryStates();
    renderSelected();
  });

  const mergeShowNote = (msg) => {
    if (!pdfThumbNoteEl) return;
    if (!msg) {
      pdfThumbNoteEl.hidden = true;
      pdfThumbNoteEl.textContent = "";
      return;
    }
    pdfThumbNoteEl.hidden = false;
    pdfThumbNoteEl.textContent = msg;
  };

  const mergeClearUI = () => {
    if (pdfThumbGrid) pdfThumbGrid.innerHTML = "";
    if (pdfReorderWrap) pdfReorderWrap.hidden = true;
    _mergeBytesByFile = [];
    _mergeOriginalOrder = [];
    _mergeDragKey = null;
    mergeShowNote("");
    setPdfOrder([]);
    mergeUpdateCount();
  };

  const mergeEnsureModal = () => {
    if (pdfPreviewModal && pdfPreviewCanvas && pdfPreviewClose && pdfPreviewTitle) return true;
    return false;
  };

  const mergeOpenModal = (title) => {
    if (!mergeEnsureModal()) return false;
    pdfPreviewTitle.textContent = title || "Preview";
    pdfPreviewModal.hidden = false;
    pdfPreviewModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    return true;
  };

  const mergeCloseModal = () => {
    if (!mergeEnsureModal()) return;
    pdfPreviewModal.hidden = true;
    pdfPreviewModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  };

  pdfPreviewClose?.addEventListener("click", mergeCloseModal);
  pdfPreviewModal?.addEventListener("click", (e) => {
    if (e.target === pdfPreviewModal) mergeCloseModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pdfPreviewModal && !pdfPreviewModal.hidden) mergeCloseModal();
  });

  const mergeRenderPreview = async (fileIndex, pageNumber1Based, title) => {
    if (!mergeEnsureModal()) return;
    const bytes = _mergeBytesByFile[fileIndex];
    if (!bytes) return;

    mergeOpenModal(title);

    const loadingTask = window.pdfjsLib.getDocument({ data: bytes });
    const pdfDoc = await loadingTask.promise;

    const page = await pdfDoc.getPage(pageNumber1Based);
    const vp0 = page.getViewport({ scale: 1 });

    const maxW = Math.min(920, window.innerWidth * 0.92);
    const scale = Math.min(3.0, maxW / vp0.width);
    const viewport = page.getViewport({ scale });

    const ctx = pdfPreviewCanvas.getContext("2d", { alpha: false });
    pdfPreviewCanvas.width = Math.floor(viewport.width);
    pdfPreviewCanvas.height = Math.floor(viewport.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
  };

  const mergeRenderThumb = async (pdfDoc, pageNumber1Based) => {
    const page = await pdfDoc.getPage(pageNumber1Based);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, PAGE_MERGE.THUMB_W / vp0.width);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.86);
  };

  const mergeMove = (arr, fromIdx, toIdx) => {
    const next = arr.slice();
    const [item] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, item);
    return next;
  };

  const mergeWireDnD = () => {
    if (!pdfThumbGrid) return;

    const items = Array.from(pdfThumbGrid.querySelectorAll(".pdfThumb"));

    items.forEach((node) => {
      const key = node.getAttribute("data-page-key");
      if (!key) return;

      node.addEventListener("dragstart", (e) => {
        _mergeDragKey = key;
        node.classList.add("isDragging");
        e.dataTransfer.effectAllowed = "move";
        try {
          e.dataTransfer.setData("text/plain", key);
        } catch {}
      });

      node.addEventListener("dragend", () => {
        _mergeDragKey = null;
        node.classList.remove("isDragging");
        items.forEach((n) => n.classList.remove("isOver"));
      });

      node.addEventListener("dragover", (e) => {
        e.preventDefault();
        node.classList.add("isOver");
        e.dataTransfer.dropEffect = "move";
      });

      node.addEventListener("dragleave", () => node.classList.remove("isOver"));

      node.addEventListener("drop", (e) => {
        e.preventDefault();
        node.classList.remove("isOver");

        const fromKey =
          _mergeDragKey ||
          (() => {
            try {
              return e.dataTransfer.getData("text/plain");
            } catch {
              return null;
            }
          })();

        const toKey = key;
        if (!fromKey || !toKey || fromKey === toKey) return;

        const fromIdx = pdfPageOrder.indexOf(fromKey);
        const toIdx = pdfPageOrder.indexOf(toKey);
        if (fromIdx === -1 || toIdx === -1) return;

        const next = mergeMove(pdfPageOrder, fromIdx, toIdx);
        setPdfOrder(next);

        const frag = document.createDocumentFragment();
        next.forEach((k) => {
          const el = pdfThumbGrid.querySelector(`[data-page-key="${CSS.escape(k)}"]`);
          if (el) frag.appendChild(el);
        });
        pdfThumbGrid.innerHTML = "";
        pdfThumbGrid.appendChild(frag);

        mergeWireDnD();
        mergeUpdateCount();
      });

      node.addEventListener("click", async () => {
        if (!mergeEnsureModal()) return;
        const [fiStr, pStr] = String(key).split(":");
        const fi = Number(fiStr);
        const p1 = Number(pStr);
        if (!Number.isFinite(fi) || !Number.isFinite(p1)) return;

        const label = node.getAttribute("data-page-label") || `PDF • page ${p1}`;
        try {
          await mergeRenderPreview(fi, p1, label);
        } catch {}
      });
    });
  };

  const mergeBuildPageGrid = async () => {
    if (mode !== "merge_pdf") {
      mergeClearUI();
      return;
    }
    if (!pdfReorderWrap || !pdfThumbGrid) return;
    if (!hasPdfJs()) {
      mergeClearUI();
      return;
    }

    if (!selected.length || selected.some((f) => !isPdfFile(f))) {
      mergeClearUI();
      return;
    }

    const token = ++_mergeBuildToken;

    pdfThumbGrid.innerHTML = "";
    pdfReorderWrap.hidden = false;
    mergeShowNote("");

    try {
      _mergeBytesByFile = await Promise.all(selected.map((f) => f.arrayBuffer()));
    } catch {
      mergeClearUI();
      return;
    }

    const nextOrder = [];
    let totalPagesRendered = 0;
    let clipped = false;

    for (let fi = 0; fi < selected.length; fi++) {
      if (token !== _mergeBuildToken) return;

      const name = selected[fi]?.name || `PDF ${fi + 1}`;
      const bytes = _mergeBytesByFile[fi];

      const loadingTask = window.pdfjsLib.getDocument({ data: bytes });
      let pdfDoc;
      try {
        pdfDoc = await loadingTask.promise;
      } catch {
        continue;
      }

      const pageCount = pdfDoc.numPages || 0;
    for (let p1 = 1; p1 <= pageCount; p1++) {
      if (token !== _mergeBuildToken) return;

      const key = `${fi}:${p1}`;

      // ✅ ALWAYS include the page in the final merge order (even if we don’t render a thumb)
      nextOrder.push(key);

      // If we’ve hit the thumb limit, we stop rendering thumbnails,
      // but we continue collecting keys so pages are never dropped.
      if (totalPagesRendered >= PAGE_MERGE.MAX_THUMBS) {
        clipped = true;
        continue;
      }

      totalPagesRendered++;

      const card = document.createElement("div");
      card.className = "pdfThumb";
      card.draggable = true;
      card.setAttribute("data-page-key", key);
      card.setAttribute("data-page-label", `${name} • page ${p1}`);

      const imgWrap = document.createElement("div");
      imgWrap.className = "pdfThumbImg";
      const img = document.createElement("img");
      img.alt = `${name} page ${p1}`;
      imgWrap.appendChild(img);

      const meta = document.createElement("div");
      meta.className = "pdfThumbMeta";
      const pill1 = document.createElement("div");
      pill1.className = "pdfThumbPill";
      pill1.textContent = `p${p1}`;
      const pill2 = document.createElement("div");
      pill2.className = "pdfThumbPill";
      pill2.textContent = name;
      meta.appendChild(pill1);
      meta.appendChild(pill2);

      card.appendChild(imgWrap);
      card.appendChild(meta);

      pdfThumbGrid.appendChild(card);

      try {
        const url = await mergeRenderThumb(pdfDoc, p1);
        img.src = url;
      } catch {}
    }

      if (clipped) break;
    }

    _mergeOriginalOrder = nextOrder.slice();

    const haveSameKeySet = pdfPageOrder.length === nextOrder.length && pdfPageOrder.every((k, i) => k === nextOrder[i]);

    if (!pdfPageOrder.length || !haveSameKeySet) {
      setPdfOrder(nextOrder);
    }

    if (pdfPageOrder.length) {
      const frag = document.createDocumentFragment();
      pdfPageOrder.forEach((k) => {
        const el = pdfThumbGrid.querySelector(`[data-page-key="${CSS.escape(k)}"]`);
        if (el) frag.appendChild(el);
      });
      pdfThumbGrid.innerHTML = "";
      pdfThumbGrid.appendChild(frag);
    }

    mergeWireDnD();
    mergeUpdateCount();

    if (clipped) {
      mergeShowNote(`Preview limited to ${PAGE_MERGE.MAX_THUMBS} pages for speed. Remaining pages will still be merged in their original relative order.`);
    }
  };

  const mergeResetOrder = () => {
    if (mode !== "merge_pdf") return;
    if (!_mergeOriginalOrder.length) return;
    setPdfOrder(_mergeOriginalOrder);

    if (!pdfThumbGrid) return;
    const frag = document.createDocumentFragment();
    _mergeOriginalOrder.forEach((k) => {
      const el = pdfThumbGrid.querySelector(`[data-page-key="${CSS.escape(k)}"]`);
      if (el) frag.appendChild(el);
    });
    pdfThumbGrid.innerHTML = "";
    pdfThumbGrid.appendChild(frag);
    mergeWireDnD();
    mergeUpdateCount();
  };

  pdfReorderResetBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    mergeResetOrder();
  });

  // ====== RENDER SELECTED ======
  const renderSelected = () => {
    if (!fileMeta || !fileSummary || !fileList) return;

    if (selected.length === 0) {
      fileMeta.hidden = true;
      fileSummary.textContent = "";
      fileList.innerHTML = "";
      uploadedMeta = [];
      resetProgress();
      revokeRemovedThumbs(new Set());

      mergeClearUI();

      disarmPricingUI();

      setStatus("Ready");
      setHint(
        mode === "merge_pdf"
          ? "Add <b>2+</b> PDFs to begin."
          : mode === "split_pdf"
            ? "Add <b>1</b> PDF to begin."
            : mode === "compress_pdf"
              ? "Add <b>1</b> PDF to begin."
              : mode === "rotate_pdf"
                ? "Add <b>1</b> PDF to begin."
                : mode === "convert"
                  ? "Choose a target format, then drop files."
                  : "Drop files to begin."
      );

      setDropzoneCopy();
      setFileInputAccept();
      setPrimaryStates();
      return;
    }

    const totalBytes = selected.reduce((a, f) => a + f.size, 0);
    fileSummary.textContent = `Selected ${selected.length} file(s) • Total ${humanMB(totalBytes)}.`;

    const currentKeys = new Set(selected.map(keyOf));
    revokeRemovedThumbs(currentKeys);

    fileList.innerHTML = selected
      .map((f, idx) => {
        const safe = escapeHtml(f.name);
        const typeLabel = escapeHtml(getTypeLabel(f));

        let thumb = "";
        if (isPdfFile(f)) {
          thumb = `<div class="thumbPdf" aria-hidden="true">PDF</div>`;
        } else if (isImageFile(f)) {
          thumb = `<img class="thumbImg" alt="" src="${getThumbUrl(f)}" loading="lazy" />`;
        } else {
          const badge = getExt(f.name) || "FILE";
          thumb = `<div class="thumbPdf" aria-hidden="true">${escapeHtml(badge)}</div>`;
        }

        const metaLine = `${humanMB(f.size)} • ${typeLabel}`;

        return `
        <li class="fileCard">
          <div class="thumb">${thumb}</div>
          <div class="fileInfo">
            <div class="fileName" title="${safe}">${safe}</div>
            <div class="fileMetaLine">${metaLine}</div>
          </div>
          <button class="iconBtn" type="button" aria-label="Remove ${safe}" data-remove="${idx}">Remove</button>
        </li>
      `;
      })
      .join("");

    fileMeta.hidden = false;

    setDropzoneCopy();
    setFileInputAccept();
    setPrimaryStates();

    // 🔥 broadcast selection for rotate/split/etc preview scripts
    publishSelected();

    // Real preview is loaded after upload via /api/preview/:jobId
    const preview = document.getElementById("resultPreview");
    if (preview && (!uploadedMeta.length || mode !== "compress_pdf")) {
      preview.style.display = "none";
    }

    // Build page-level merge grid whenever selection changes on merge page
    mergeBuildPageGrid().catch(() => {});
  };

  // Remove item
  fileList?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]");
    if (!b) return;
    const idx = Number(b.getAttribute("data-remove"));
    if (!Number.isFinite(idx)) return;

    const removed = selected.splice(idx, 1)[0];
    if (removed) {
      const k = keyOf(removed);
      const url = thumbUrls.get(k);
      if (url) URL.revokeObjectURL(url);
      thumbUrls.delete(k);
    }

    uploadedMeta = [];
    compressPreviewState = "idle";
    compressPreviewError = "";
    resetProgress();
    disarmPricingUI();
    renderSelected();
  });

  // ====== PRESETS (compress PDF page) ======
  const normalizePdfLevel = (lvl) => {
    const v = String(lvl || "").toLowerCase().trim();
    if (v === "max" || v === "maximum") return "max";
    if (v === "light") return "light";
    return "balanced";
  };

  const setPresetActive = (lvl) => {
    if (!presetButtons.length) return;
    const wanted = normalizePdfLevel(lvl);

    presetButtons.forEach((btn) => {
      const bLvl = normalizePdfLevel(btn.getAttribute("data-preset-level"));
      const active = bLvl === wanted;
      btn.classList.toggle("isActive", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  };

  const applyPdfLevel = (lvl, reason) => {
    const next = normalizePdfLevel(lvl);
    pdfCompressLevelValue = next;

    if (pdfCompressLevel) pdfCompressLevel.value = next;
    safeLocalSet(LS.lastPdfLevel, next);
    setPresetActive(next);

    if (reason && (uploadedMeta.length || jobId)) {
      hardResetJob(`${reason} — please upload again.`);
    }

    setDropzoneCopy();
    setPrimaryStates();
    renderSelected();
  };

  presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const lvl = btn.getAttribute("data-preset-level");
      applyPdfLevel(lvl, "Preset changed");
    });
  });

  const enforceModeFromPage = () => {
    if (!pageTool) return;

    if (pageTool === "compress" && modeCompress) modeCompress.checked = true;
    if (pageTool === "compress_pdf" && modeCompressPdf) modeCompressPdf.checked = true;
    if (pageTool === "convert" && modeConvert) modeConvert.checked = true;
    if (pageTool === "merge_pdf" && modeMergePdf) modeMergePdf.checked = true;
    if (pageTool === "split_pdf" && modeSplitPdf) modeSplitPdf.checked = true;
    if (pageTool === "rotate_pdf" && modeRotatePdf) modeRotatePdf.checked = true;
  };

  const syncMode = () => {
    enforceModeFromPage();

    const isCompressPdf = !!modeCompressPdf?.checked;
    const isConvert = !!modeConvert?.checked;
    const isMerge = !!modeMergePdf?.checked;
    const isSplit = !!modeSplitPdf?.checked;
    const isRotate = !!modeRotatePdf?.checked;

    mode =
      pageTool === "image_compress" ? "image_compress"
      : isRotate ? "rotate_pdf"
      : isMerge ? "merge_pdf"
      : isSplit ? "split_pdf"
      : isCompressPdf ? "compress_pdf"
      : isConvert ? "convert"
      : modeWatermarkPdf?.checked ? "watermark_pdf"
      : modeSignPdf?.checked ? "sign_pdf"
      : modeEditPdf?.checked ? "edit_pdf"
      : "compress";
        safeLocalSet(LS.lastMode, mode);

    if (convertRow) convertRow.style.display = mode === "convert" ? "flex" : "none";
    if (pdfCompressRow) pdfCompressRow.style.display = mode === "compress_pdf" ? "flex" : "none";

    if (mode === "convert") {
      convertTargetValue = convertTarget?.value || "jpg";
      safeLocalSet(LS.lastTarget, convertTargetValue);
      setHint("Choose a target format, then add files.");
    } else if (mode === "merge_pdf") {
      convertTargetValue = null;
      setHint("Upload <b>2+</b> PDFs to merge into one file.");
    } else if (mode === "split_pdf") {
      convertTargetValue = null;
      setHint("Upload <b>1</b> PDF to split into separate pages.");
    } else if (mode === "compress_pdf") {
      convertTargetValue = null;
      const lvl = pdfCompressLevelValue === "max" ? "Maximum" : pdfCompressLevelValue === "light" ? "Light" : "Balanced";
      const targetLabel =
        targetBytes === 1048576
          ? " Target: <b>under 1MB</b>."
          : targetBytes
            ? ` Target: <b>under ${(targetBytes / (1024 * 1024)).toFixed(targetBytes % (1024 * 1024) === 0 ? 0 : 1)}MB</b>.`
            : "";
      setHint(`Upload <b>1</b> PDF to compress. Level: <b>${lvl}</b>.${targetLabel}`);
    } else if (mode === "rotate_pdf") {
      convertTargetValue = null;
      setHint(`Upload <b>1</b> PDF to rotate. Click pages to rotate them.`);
    } else {
      convertTargetValue = null;
      setHint("Upload files to create a ZIP.");
    }

    setDropzoneCopy();
    setFileInputAccept();

    if (uploadedMeta.length || jobId) {
      hardResetJob("Mode changed — please upload again.");
    }

    if ((mode === "merge_pdf" || mode === "split_pdf" || mode === "compress_pdf" || mode === "rotate_pdf") && selected.length) {
      const hasNonPdf = selected.some((f) => !isPdfFile(f));
      if (hasNonPdf) {
        selected = [];
        uploadedMeta = [];
        compressPreviewState = "idle";
        compressPreviewError = "";
        resetProgress();
        for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
        thumbUrls.clear();
        setStatus("PDFs only");
        const label = mode === "merge_pdf" ? "Merge PDFs" : mode === "split_pdf" ? "Split PDF" : mode === "compress_pdf" ? "Compress PDF" : "Rotate PDF";
        setHint(`${label} only accepts PDF files.`);
        renderSelected();
        return;
      }
    }

    if ((mode === "split_pdf" || mode === "compress_pdf" || mode === "rotate_pdf") && selected.length > 1) {
      selected = [selected[0]];
      uploadedMeta = [];
      compressPreviewState = "idle";
      compressPreviewError = "";
      resetProgress();
      setStatus("Only one PDF");
      setHint(`${mode === "split_pdf" ? "Split PDF" : mode === "compress_pdf" ? "Compress PDF" : "Rotate PDF"} accepts <b>1</b> PDF only.`);
    }

    if (mode !== "merge_pdf") {
      mergeClearUI();
    } else {
      mergeBuildPageGrid().catch(() => {});
    }

    setPrimaryStates();
    renderSelected();
  };

  if (modeCompress && modeConvert) {
    modeCompress.addEventListener("change", syncMode);
    modeConvert.addEventListener("change", syncMode);
  }
  if (modeCompressPdf) modeCompressPdf.addEventListener("change", syncMode);
  if (modeMergePdf) modeMergePdf.addEventListener("change", syncMode);
  if (modeSplitPdf) modeSplitPdf.addEventListener("change", syncMode);
  if (modeRotatePdf) modeRotatePdf.addEventListener("change", syncMode);

  convertTarget?.addEventListener("change", () => {
    convertTargetValue = convertTarget?.value || "jpg";
    safeLocalSet(LS.lastTarget, convertTargetValue);

    if (uploadedMeta.length || jobId) {
      hardResetJob("Target changed — please upload again.");
    }

    setPrimaryStates();
    renderSelected();
  });

  pdfCompressLevel?.addEventListener("change", () => {
    applyPdfLevel(pdfCompressLevel?.value || "balanced", "Compression level changed");
  });

  const restoreModePrefs = () => {
    const savedMode = safeLocalGet(LS.lastMode);
    const savedTarget = safeLocalGet(LS.lastTarget);
    const savedPdfLevel = safeLocalGet(LS.lastPdfLevel);
    const savedRotateDeg = safeLocalGet(LS.lastRotateDeg);

    if (savedTarget && convertTarget) {
      convertTarget.value = savedTarget;
    }

    if (savedPdfLevel && pdfCompressLevel) {
      pdfCompressLevel.value = savedPdfLevel;
      pdfCompressLevelValue = normalizePdfLevel(savedPdfLevel);
    } else {
      pdfCompressLevelValue = normalizePdfLevel(pdfCompressLevel?.value || "balanced");
    }

    rotateDegreesValue = normalizeRotateDeg(savedRotateDeg || rotateDegreesValue || 90);
    setRotateActive(rotateDegreesValue);

    const pathname = window.location.pathname || "/";
    const isHomepage = pathname === "/";

    const onTabbedIndex =
      !!(modeCompress && modeCompressPdf && modeConvert && modeMergePdf && modeSplitPdf) &&
      !pageTool &&
      !isHomepage;

    if (isHomepage && modeCompressPdf) {
      modeCompressPdf.checked = true;
    } else if (onTabbedIndex && savedMode) {
      if (savedMode === "merge_pdf" && modeMergePdf) modeMergePdf.checked = true;
      else if (savedMode === "split_pdf" && modeSplitPdf) modeSplitPdf.checked = true;
      else if (savedMode === "compress_pdf" && modeCompressPdf) modeCompressPdf.checked = true;
      else if (savedMode === "convert" && modeConvert) modeConvert.checked = true;
      else if (savedMode === "rotate_pdf" && modeRotatePdf) modeRotatePdf.checked = true;
      else if (modeCompress) modeCompress.checked = true;
    }
  };

  restoreModePrefs();
  setPresetActive(pdfCompressLevelValue);
  syncMode();

  // ====== JOB CREATION ======
  const ensureJob = async () => {
    if (jobId) return jobId;

    if (creatingJob) {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          if (jobId) return resolve(jobId);
          if (!creatingJob) return reject(new Error("job create failed"));
          if (Date.now() - start > 15000) return reject(new Error("job create timeout"));
          requestAnimationFrame(tick);
        };
        tick();
      });
    }

    creatingJob = true;
    setBusy(true);
    setStatus("Preparing");
    setHint("Setting up a secure upload…");
    setPrimaryStates();

    try {
      const res = await fetch("/api/jobs", { method: "POST" });
      if (!res.ok) throw new Error("Failed to create job");
      const j = await res.json();
      if (!j?.jobId) throw new Error("No jobId returned");

      jobId = j.jobId;

      safeLocalSet(LS.lastJob, jobId);
      safeLocalSet(LS.lastFilesCount, String(selected.length || 0));

      setPrimaryStates();
      return jobId;
    } catch (err) {
      setStatus("Couldn’t start");
      setHint("Refresh and try again.");
      throw err;
    } finally {
      creatingJob = false;
      setBusy(false);
      setPrimaryStates();
    }
  };

  // ====== ADD FILES ======
  const addFiles = async (incomingFiles) => {
    const arr = [...incomingFiles].filter(Boolean);

    const errors = [];
    const incomingValid = [];

    for (const f of arr) {
      const err = validateFileForMode(f);
      if (err) errors.push(err);
      else incomingValid.push(f);
    }

    if (errors.length) {
      setStatus("Some files were skipped");
      setHint(errors.slice(0, 2).map((e) => escapeHtml(e)).join("<br/>") + (errors.length > 2 ? "<br/>…" : ""));
    }

    // Any new selection invalidates any prior upload + pricing
    uploadedMeta = [];
    compressPreviewState = "idle";
    compressPreviewError = "";
    disarmPricingUI();

    // Single-PDF tools: selecting another PDF REPLACES
    if (
      mode === "split_pdf" ||
      mode === "compress_pdf" ||
      mode === "rotate_pdf" ||
      mode === "watermark_pdf" ||
      mode === "sign_pdf" ||
      mode === "edit_pdf"
    ) {
      if (!incomingValid.length) {
        setPrimaryStates();
        return;
      }

      selected = [incomingValid[0]];
      uploadedMeta = [];
      compressPreviewState = "idle";
      compressPreviewError = "";
      resetProgress();
      renderSelected();

      try {
        await ensureJob();
      } catch {
        setStatus("Couldn’t start");
        setHint("Refresh and try again.");
        return;
      }

      setPrimaryStates();
      return;
    }

    const existingKeys = new Set(selected.map(keyOf));
    for (const f of incomingValid) {
      const k = keyOf(f);
      if (!existingKeys.has(k)) {
        selected.push(f);
        existingKeys.add(k);
      }
    }

    if (selected.length > MAX_FILES) {
      selected = selected.slice(0, MAX_FILES);
      setStatus("Max files reached");
      setHint(`Only the first <b>${MAX_FILES}</b> files were kept.`);
    }

    if (mode === "merge_pdf") {
      const before = selected.length;
      selected = selected.filter(isPdfFile);
      if (selected.length !== before) {
        setStatus("PDFs only");
        setHint("Non-PDF files were removed. Add <b>2+</b> PDFs to merge.");
      }
    }

    resetProgress();
    renderSelected();

    try {
      await ensureJob();
    } catch {
      setStatus("Couldn’t start");
      setHint("Refresh and try again.");
      return;
    }

    setPrimaryStates();
  };

  chooseBtn.addEventListener("click", (e) => {
    e.preventDefault();
    try {
      filesEl.click();
    } catch {}
  });

  filesEl.addEventListener("change", async () => {
    if (!filesEl.files || filesEl.files.length === 0) return;
    await addFiles(filesEl.files);
    filesEl.value = "";

    // 🔥 AUTO UPLOAD
    await autoUploadIfReady();
  });

  // ====== DRAG & DROP ======
  ["dragenter", "dragover"].forEach((evt) =>
    window.addEventListener(
      evt,
      (e) => {
        e.preventDefault();
      },
      { passive: false }
    )
  );
  window.addEventListener(
    "drop",
    (e) => {
      e.preventDefault();
    },
    { passive: false }
  );

  let dragDepth = 0;
  const dragOn = () => dropzone.classList.add("isDrag");
  const dragOff = () => dropzone.classList.remove("isDrag");

  dropzone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth++;
    dragOn();
  });
  dropzone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = clamp(dragDepth - 1, 0, 999);
    if (dragDepth === 0) dragOff();
  });
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragOn();
  });
  dropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    dragOff();
    const dt = e.dataTransfer;
    const files = dt?.files ? [...dt.files] : [];
    if (!files.length) {
      setStatus("Drop files only");
      setHint("Try dragging files from Finder.");
      return;
    }
  await addFiles(files);
  await autoUploadIfReady();
  });

  clearBtn?.addEventListener("click", () => {
    const preview = document.getElementById("resultPreview");
    if (preview) preview.style.display = "none";
    if (continueBtn) continueBtn.style.display = "";
    const originalSizeEl = document.getElementById("originalSize");
    const newSizeEl = document.getElementById("newSize");
    const savingsEl = document.getElementById("savingsPct");

    if (originalSizeEl) originalSizeEl.textContent = "—";
    if (newSizeEl) newSizeEl.textContent = "—";
    if (savingsEl) savingsEl.textContent = "↓ —% smaller";
    if (uploading) return;
    selected = [];
    uploadedMeta = [];
    compressPreviewState = "idle";
    compressPreviewError = "";
    disarmPricingUI();
    for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
    thumbUrls.clear();
    resetProgress();
    renderSelected();
  });

  // ====== UPLOAD (DIRECT TO R2) ======
  const putWithProgress = (url, file, onProgress) => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url, true);

      xhr.upload.onprogress = (evt) => {
        if (!evt.lengthComputable) return;
        onProgress?.(evt.loaded, evt.total);
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(true);
        else reject(new Error(`Upload failed (${xhr.status})`));
      };

      xhr.onerror = () => reject(new Error("Network error"));
      xhr.send(file);
    });
  };

  const makeProgressReporter = (totalBytes) => {
    let uploadedBytes = 0;

    const setOverall = (bytesSoFar) => {
      const pct = totalBytes ? Math.round((bytesSoFar / totalBytes) * 100) : 0;
      if (progressFill) progressFill.style.width = `${pct}%`;
      if (progressPct) progressPct.textContent = `${pct}%`;
      if (progressMeta) progressMeta.textContent = `${humanMB(bytesSoFar)} / ${humanMB(totalBytes)}`;
    };

    setOverall(0);

    return {
      commitFile: (fileSize) => {
        uploadedBytes += fileSize;
        setOverall(uploadedBytes);
      },
      currentFile: (loaded) => {
        setOverall(uploadedBytes + loaded);
      },
      done: () => setOverall(totalBytes),
    };
  };

    const setBackendMode = async () => {
    if (!jobId) return;

    try {
      const payload = {
        mode,
        target: convertTargetValue,
        from: convertFrom?.value || "auto",
      };

      if (mode === "watermark_pdf") {
        payload.watermarkConfig = window.__PDFOPS_WATERMARK_CONFIG__ || null;
      }

      if (mode === "sign_pdf") {
        payload.signMap = window.__PDFOPS_SIGN_MAP__ || null;
      }

      if (mode === "edit_pdf") {
        payload.editMap = window.__PDFOPS_EDIT_MAP__ || null;
      }

      if (mode === "merge_pdf" && Array.isArray(pdfPageOrder) && pdfPageOrder.length) {
        payload.order = pdfPageOrder;
      }

      if (mode === "split_pdf") {
        const splitOrder = getSplitPageOrder();
        if (Array.isArray(splitOrder) && splitOrder.length) {
          payload.splitOrder = splitOrder;
        }
      }

      if (mode === "compress_pdf") {
        payload.level = pdfCompressLevelValue || "balanced";
        if (targetBytes) payload.targetBytes = targetBytes;
      }

      if (mode === "rotate_pdf") {
        const rotateMap = getRotateMap();
        if (rotateMap) {
          payload.rotateMap = rotateMap;
          payload.degrees = 90;
        } else {
          payload.degrees = rotateDegreesValue || 90;
        }
      }

      const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!r.ok) {
        setStatus("Mode error");
        setHint("Couldn’t set mode. Refresh and try again.");
      }
    } catch {
      setStatus("Mode error");
      setHint("Couldn’t set mode. Refresh and try again.");
    }
  };

  const loadCompressPreview = async () => {
    if (!jobId) return;
    if (mode !== "compress_pdf") return;
    if (!uploadedMeta.length) return;

    const preview = document.getElementById("resultPreview");
    const originalSizeEl = document.getElementById("originalSize");
    const newSizeEl = document.getElementById("newSize");
    const savingsEl = document.getElementById("savingsPct");
    const unlockBtnEl = document.getElementById("unlockBtn");

    if (!preview || !originalSizeEl || !newSizeEl) return;

    compressPreviewState = "loading";
    compressPreviewError = "";
    setPrimaryStates();

    preview.style.display = "none";
    originalSizeEl.textContent = "—";
    newSizeEl.textContent = "—";
    if (savingsEl) savingsEl.textContent = "↓ —% smaller";

    if (unlockBtnEl) {
      unlockBtnEl.disabled = true;
      unlockBtnEl.classList.add("isDisabled");
      unlockBtnEl.textContent = "Unlock Download →";
    }

    try {
      setStatus("Compressing");
      setHint("Preparing your compressed PDF preview…");

      const resp = await fetch(`/api/preview/${encodeURIComponent(jobId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });

      const text = await resp.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Preview route returned non-JSON: ${text.slice(0, 160)}`);
      }

      if (!resp.ok || data?.error) {
        throw new Error(data?.error || `Preview failed (${resp.status})`);
      }

      const result = data?.result || {};
      const originalBytes = Number(result.originalBytes || 0);
      const compressedBytes = Number(result.compressedBytes || 0);
      const savedPercent = Number(result.savedPercent || 0);

      if (!originalBytes || !compressedBytes) {
        throw new Error("Preview size data missing");
      }

      originalSizeEl.textContent = humanFileSize(originalBytes);
      newSizeEl.textContent = humanFileSize(compressedBytes);
      if (savingsEl) savingsEl.textContent = `↓ ${savedPercent}% smaller`;

      if (unlockBtnEl) {
        const total = calcTotal();
        unlockBtnEl.textContent = `Unlock Download — £${total.toFixed(2)}`;
      }

      compressPreviewState = "ready";
      compressPreviewError = "";

      if (continueBtn) continueBtn.style.display = "none";
      preview.style.display = "block";

      setPrimaryStates();
      setStatus("Your PDF is ready");
      setHint("Your file has been compressed. Unlock download to get it.");
    } catch (e) {
      compressPreviewState = "failed";
      compressPreviewError = e?.message || "Could not prepare preview.";
      console.error("[compress preview]", e);

      preview.style.display = "none";
      if (continueBtn) continueBtn.style.display = "";

      setPrimaryStates();
      setStatus("Preview failed");
      setHint(`Preview failed: ${escapeHtml(compressPreviewError)}`);
    }
  };

  // AUTO UPLOAD (trigger after file select)
  const autoUploadIfReady = async () => {
    if (uploading) return;
    if (!selected.length) return;
    if (!jobId) return; // 👈 IMPORTANT: do NOT recreate job

    if (
      mode === "edit_pdf" ||
      mode === "watermark_pdf" ||
      mode === "sign_pdf"
    ) return;

    if (!modeMinFilesSatisfied()) return;

    if (uploadedMeta.length) return;

    uploadBtn.click();
  };

  uploadBtn.addEventListener("click", async () => {
    if (uploading) return;
    if (selected.length === 0) return;

    if (!modeMinFilesSatisfied()) {
      if (mode === "merge_pdf") {
        setStatus("Add one more PDF");
        setHint("Merge PDFs needs <b>2+</b> PDF files.");
      } else if (mode === "split_pdf") {
        setStatus("Add a PDF");
        setHint("Split PDF accepts <b>1</b> PDF only.");
      } else if (mode === "compress_pdf") {
        setStatus("Add a PDF");
        setHint("Compress PDF accepts <b>1</b> PDF only.");
      } else if (mode === "rotate_pdf") {
        setStatus("Add a PDF");
        setHint("Rotate PDF accepts <b>1</b> PDF only.");
      }
      return;
    }

    try {
      await ensureJob();
    } catch {
      setStatus("Couldn’t start");
      setHint("Refresh and try again.");
      return;
    }

    uploading = true;
    setBusy(true);
    setPrimaryStates();

    // Upload always resets pricing gates until success
    disarmPricingUI();

    resetProgress();
    if (progressWrap) progressWrap.hidden = false;
    if (progressLabel) progressLabel.textContent = "Uploading…";
    if (progressFill) progressFill.style.width = "0%";
    if (progressPct) progressPct.textContent = "0%";
    if (progressMeta) progressMeta.textContent = "";

    setStatus("Uploading");
    setHint("Keep this tab open.");

    uploadedMeta = [];

    const totalBytes = selected.reduce((a, f) => a + f.size, 0);
    const prog = makeProgressReporter(totalBytes);

    // ✅ IMPORTANT: set mode (and page order) BEFORE upload
    await setBackendMode();

    try {
      for (let i = 0; i < selected.length; i++) {
        const f = selected[i];

        if (progressLabel) progressLabel.textContent = `Uploading ${i + 1}/${selected.length}…`;

        const presignRes = await fetch("/api/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId,
            filename: f.name,
            type: isPdfFile(f) ? "application/pdf" : f.type || "application/octet-stream",
          }),
        });

        const presign = await presignRes.json();
        if (presign?.error) throw new Error(presign.error);
        if (!presign?.url || !presign?.key) throw new Error("Failed to prepare upload");

        await putWithProgress(presign.url, f, (loaded) => prog.currentFile(loaded));

        uploadedMeta.push({
          key: presign.key,
          originalname: f.name,
          mimetype: isPdfFile(f) ? "application/pdf" : f.type || "application/octet-stream",
        });

        prog.commitFile(f.size);
      }

      prog.done();

      const regRes = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: uploadedMeta }),
      });

      const reg = await regRes.json();
      if (reg?.error) throw new Error(reg.error);

      if (progressLabel) progressLabel.textContent = "Uploaded";
      if (progressFill) progressFill.style.width = "100%";
      if (progressPct) progressPct.textContent = "100%";

      if (mode === "compress_pdf") {
        setStatus("Compressing");
        setHint("Preparing your compressed PDF preview…");
        await loadCompressPreview();
      } else {
        setStatus("Uploaded");
        setHint("Upload complete. Continue when ready.");
      }

      setPrimaryStates();
      
      } catch (e) {
        setStatus("Upload failed");
        setHint("Please try again.");

        uploadedMeta = [];
        resetProgress();

        setPrimaryStates();
      } finally {
        uploading = false;
        setBusy(false);
        setPrimaryStates();
      }
    });

  // ====== MODAL ======
  let shareListenerAttached = false;

  const openPriceModal = () => {
    // 🔒 absolute gate: modal cannot be opened unless upload finished
    if (!uploadedMeta.length) {
      setStatus("Upload first");
      setHint("Please upload your files before continuing.");
      return false;
    }
    if (!priceModal) return false;

    disableLegacyOptions();

    // Now (and only now) we allow pricing surfaces to appear
    armPricingUI();

    applyShareDefault();
    safeLocalSet(LS.shareSeen, "1");

    syncModalTierUI();
    syncModalTotalUI();

    if (!shareListenerAttached && optShareLink) {
      optShareLink.addEventListener("change", () => {
        rememberSharePref();
        syncModalTotalUI();
        if (priceModalNote && optShareLink.checked) {
          priceModalNote.textContent = "You’ll be redirected to secure Stripe Checkout. Share link enabled.";
        } else if (priceModalNote) {
        const pathname = window.location.pathname || "";

        if (pathname.includes("1mb")) {
          priceModalNote.textContent =
            "Optimised for strict upload limits (1MB). Download instantly after payment.";
        } else if (pathname.includes("job")) {
          priceModalNote.textContent =
            "Perfect for job application portals. Ensure your file meets upload limits.";
        } else {
          priceModalNote.textContent =
            "Instant download after payment. No signup required.";
        }
        }
      });
      shareListenerAttached = true;
    }

    if (priceModalNote) {
      priceModalNote.textContent = shouldRecommendShare()
        ? "You’ll be redirected to secure Stripe Checkout. Recommended: get a shareable download link to send your file (especially for large uploads)."
        : "You’ll be redirected to secure Stripe Checkout.";
    }

    priceModal.classList.add("isOpen");
    priceModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    modalPayBtn?.focus();
    return true;
  };

  const closePriceModal = () => {
    if (!priceModal) return;
    priceModal.classList.remove("isOpen");
    priceModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    continueBtn?.focus();
  };

  modalCloseBtn?.addEventListener("click", closePriceModal);
  modalBackBtn?.addEventListener("click", closePriceModal);
  priceModal?.addEventListener("click", (e) => {
    if (e.target === priceModal) closePriceModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && priceModal?.classList.contains("isOpen")) closePriceModal();
  });

  // ====== CHECKOUT ======
  const startCheckout = async () => {
    if (!jobId) return;

    const n = selected.length;
    const tier = getTier(n);

    setBusy(true);
    setStatus("Redirecting");
    setHint("Opening secure checkout…");
    continueBtn.disabled = true;

    try {
      const resp = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          mode,
          shareLink: !!optShareLink?.checked,
          fileCount: n
        }),
      }).then((r) => r.json());

      if (resp?.error) throw new Error(resp.error);
      if (!resp?.url) throw new Error("Something went wrong.");

      window.location.href = resp.url;
    } catch (e) {
      setStatus("Couldn’t continue");
      setHint(escapeHtml(e?.message || "Please try again."));
      continueBtn.disabled = false;
    } finally {
      setBusy(false);
      setPrimaryStates();
    }
  };

  // Pay button inside modal -> checkout
  modalPayBtn?.addEventListener("click", async () => {
    // Safety: if anything invalidates upload while modal is open
    if (!uploadedMeta.length) {
      closePriceModal();
      setStatus("Upload first");
      setHint("Please upload your files before continuing.");
      return;
    }
    closePriceModal();
    await startCheckout();
  });

  continueBtn.addEventListener("click", async () => {
    if (typeof gtag === "function") {
      gtag("event", "continue_click", {
        page: window.location.pathname
      });
    }

    if (!jobId) return;

    if (!uploadedMeta.length) {
      setStatus("Upload first");
      setHint("Please upload your files before continuing.");
      return;
    }

    try {
      await setBackendMode();
    } catch {}

    const opened = openPriceModal();
    if (!opened) {
      await startCheckout();
    }
  });

  if (unlockBtn) {
  unlockBtn.addEventListener("click", async () => {
    if (typeof gtag === "function") {
      gtag("event", "unlock_btn_click", {
        page: window.location.pathname
      });
    }

    if (!jobId) return;

    if (!uploadedMeta.length) {
      setStatus("Upload first");
      setHint("Please upload your files before continuing.");
      return;
    }

    try {
      await setBackendMode();
    } catch {}

    const opened = openPriceModal();
    if (!opened) {
      await startCheckout();
    }
  });
}

  // ====== INIT ======
  continueBtn.textContent = mode === "compress_pdf" ? "Unlock Download →" : "Review & Continue →";
  continueBtn.style.display = "";

  pdfCompressLevelValue = normalizePdfLevel(pdfCompressLevel?.value || safeLocalGet(LS.lastPdfLevel) || "balanced");

  rotateDegreesValue = normalizeRotateDeg(safeLocalGet(LS.lastRotateDeg) || rotateDegreesValue || 90);
  setRotateActive(rotateDegreesValue);

  setPresetActive(pdfCompressLevelValue);

  disarmPricingUI();

  setStatus("Ready");
  setHint("Choose a mode and add files.");
  setDropzoneCopy();
  setFileInputAccept();

  if (unlockBtn) {
    unlockBtn.disabled = true;
    unlockBtn.classList.add("isDisabled");
    unlockBtn.textContent = "Unlock Download →";
  }

  renderSelected();
})();