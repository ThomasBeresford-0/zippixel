// public/app.js — PDFOperations frontend (v17.5 - PRESET BUTTONS + PAGE-AWARE MODES + CLEAN COPY)
// Matches: index.html + compress-pdf.html IDs + server.js routes:
// /api/jobs, /api/upload-url, /api/jobs/:jobId/register, /api/jobs/:jobId/mode, /api/checkout
(() => {
  // ====== YEAR ======
  const y = document.getElementById("y");
  if (y) y.textContent = new Date().getFullYear();

  // ====== LIMITS ======
  const MAX_FILES = 50;
  const MAX_MB_EACH = 25;

  // ====== PRICING (modal only) ======
  const TIER_10_LIMIT = 10;
  const TIER_10_PRICE = 2.99;
  const TIER_50_LIMIT = 50;
  const TIER_50_PRICE = 9.99;
  const SHARE_LINK_PRICE = 2.49;

  // ====== DOM ======
  const dropzone = document.getElementById("dropzone");
  const filesEl = document.getElementById("files");
  const chooseBtn = document.getElementById("chooseBtn");
  const clearBtn = document.getElementById("clearBtn");

  const uploadBtn = document.getElementById("upload");
  const continueBtn = document.getElementById("continue");

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

  // Modal
  const priceModal = document.getElementById("priceModal");
  const modalCloseBtn = document.getElementById("modalCloseBtn");
  const modalBackBtn = document.getElementById("modalBackBtn");
  const modalPayBtn = document.getElementById("modalPayBtn");
  const optShareLink = document.getElementById("optShareLink");

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

  const convertRow = document.getElementById("convertRow");
  const convertFrom = document.getElementById("convertFrom"); // informational
  const convertTarget = document.getElementById("convertTarget");

  // Compress PDF controls
  const pdfCompressRow = document.getElementById("pdfCompressRow");
  const pdfCompressLevel = document.getElementById("pdfCompressLevel");

  // Presets on compress-pdf page (and can exist elsewhere)
  const presetButtons = Array.from(document.querySelectorAll("[data-preset-level]"));

  // PDF reorder UI
  let pdfPageOrder = [];
  let pdfDocRef = null;
  const pdfReorderWrap = document.getElementById("pdfReorderWrap");
  const pdfThumbGrid = document.getElementById("pdfThumbGrid");

  // Page tool hint (optional)
  const pageTool = (document.body?.dataset?.tool || "").trim(); // e.g. "compress_pdf"

  // If this page doesn’t have the tool, bail quietly
  if (!dropzone || !filesEl || !chooseBtn || !uploadBtn || !continueBtn) return;

  // ====== STATE ======
  let jobId = null;
  let creatingJob = false;
  let uploading = false;

  let selected = [];            // Array<File>
  const thumbUrls = new Map();  // keyOf(file) -> objectURL (images only)
  let uploadedMeta = [];        // [{ key, originalname, mimetype }]

  // ====== MODE STATE ======
  // compress | compress_pdf | convert | merge_pdf | split_pdf
  let mode = "compress";
  let convertTargetValue = null;

  // Compress PDF level
  let pdfCompressLevelValue = "balanced"; // balanced | light | max

  // ====== UX MEMORY (localStorage) ======
  const LS = {
    lastMode: "po:lastMode",
    lastTarget: "po:lastTarget",
    lastPdfLevel: "po:lastPdfLevel",
    sharePref: "po:sharePref",       // "on" | "off"
    shareSeen: "po:shareSeen",       // "1" once they've seen the modal
    lastJob: "po:lastJobId",
    lastFilesCount: "po:lastFilesCount"
  };

  // ====== HELPERS ======
  const setStatus = (m) => { if (statusEl) statusEl.textContent = m; };
  const setHint = (m) => { if (statusHint) statusHint.innerHTML = m; };
  const setBusy = (on) => { if (spinner) spinner.classList.toggle("isOn", !!on); };

  const humanMB = (bytes) => (bytes / (1024 * 1024)).toFixed(1) + "MB";
  const escapeHtml = (str) =>
    String(str).replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
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
    try { filesEl.disabled = !enabled; } catch {}
    try { chooseBtn.disabled = !enabled; } catch {}
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
    const tier = getTier(selected.length);
    const share = !!optShareLink?.checked;
    return tier.base + (share ? SHARE_LINK_PRICE : 0);
  };

  const disableLegacyOptions = () => {
    [optPrintReady, optEmailSafe, optKeepNames, optListingNames, optDayPass].forEach((el) => {
      if (!el) return;
      el.checked = false;
      el.disabled = true;
    });
  };

  const safeLocalSet = (k, v) => {
    try { localStorage.setItem(k, String(v)); } catch {}
  };
  const safeLocalGet = (k) => {
    try { return localStorage.getItem(k); } catch { return null; }
  };

  const hardResetJob = (reason) => {
    jobId = null;
    creatingJob = false;
    uploadedMeta = [];
    resetProgress();
    if (reason) {
      setStatus("Ready");
      setHint(reason);
    }
  };

  // ====== SMART COPY ======
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
      dzTitleEl.textContent = "Drop a PDF here";
      dzSubEl.textContent = "PDF only • 1 file • Reduce file size";
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
  };

  const setFileInputAccept = () => {
    if (!filesEl) return;
    if (mode === "merge_pdf" || mode === "split_pdf" || mode === "compress_pdf") {
      filesEl.setAttribute("accept", "application/pdf,.pdf");
    } else {
      filesEl.removeAttribute("accept");
    }
  };

  const modeMinFilesSatisfied = () => {
    if (mode === "merge_pdf") return selected.length >= 2;
    if (mode === "split_pdf") return selected.length === 1;
    if (mode === "compress_pdf") return selected.length === 1;
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

    if (mode === "merge_pdf" || mode === "split_pdf" || mode === "compress_pdf") {
      if (!isPdfFile(f)) {
        const label =
          mode === "merge_pdf" ? "Merge PDFs" :
          mode === "split_pdf" ? "Split PDF" :
          "Compress PDF";
        return `“${f.name}” isn’t a PDF. ${label} only accepts PDF files.`;
      }
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
    if (n >= 8) return true;
    if (totalBytes >= 20 * 1024 * 1024) return true;
    return false;
  };

  const applyShareDefault = () => {
    if (!optShareLink) return;

    const seen = safeLocalGet(LS.shareSeen) === "1";
    const pref = safeLocalGet(LS.sharePref);

    if (seen) {
      if (pref === "on") { optShareLink.checked = true; return; }
      if (pref === "off") { optShareLink.checked = false; return; }
    }

    optShareLink.checked = shouldRecommendShare();
  };

  const rememberSharePref = () => {
    if (!optShareLink) return;
    safeLocalSet(LS.sharePref, optShareLink.checked ? "on" : "off");
  };

  // ====== BUTTON STATES ======
  const showContinue = (enabled) => {
    continueBtn.style.display = "";
    continueBtn.disabled = !enabled;
    continueBtn.classList.toggle("isDisabled", !enabled);
  };

  const setPrimaryStates = () => {
    const hasFiles = selected.length > 0;
    const hasJob = !!jobId;
    const meetsMin = modeMinFilesSatisfied();

    const canUpload = hasFiles && meetsMin && hasJob && !uploading;
    const canContinue = !!uploadedMeta.length && !uploading;

    uploadBtn.disabled = !canUpload;
    showContinue(canContinue);

    if (mode === "merge_pdf") {
      uploadBtn.textContent = uploading ? "Uploading…" : (uploadedMeta.length ? "Re-upload PDFs" : "Upload PDFs");
    } else if (mode === "split_pdf") {
      uploadBtn.textContent = uploading ? "Uploading…" : (uploadedMeta.length ? "Re-upload PDF" : "Upload PDF");
    } else if (mode === "compress_pdf") {
      uploadBtn.textContent = uploading ? "Uploading…" : (uploadedMeta.length ? "Re-upload PDF" : "Upload PDF");
    } else {
      uploadBtn.textContent = uploading ? "Uploading…" : (uploadedMeta.length ? "Re-upload" : "Upload files");
    }

    continueBtn.textContent = "Continue →";

    setUploaderEnabled(!(uploading || creatingJob));

    if (!hasFiles) {
      setStatus("Ready");
      setHint(
        mode === "merge_pdf"
          ? "Add <b>2+</b> PDFs to merge."
          : (mode === "split_pdf"
              ? "Add <b>1</b> PDF to split into pages."
              : (mode === "compress_pdf"
                  ? "Add <b>1</b> PDF to compress."
                  : (mode === "convert" ? "Choose a target format, then add files." : "Add up to <b>50</b> files to begin.")
                )
            )
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

    if (!hasJob) {
      setStatus("Preparing");
      setHint("Setting up a secure upload…");
      return;
    }

    if (uploadedMeta.length) {
      setStatus("Uploaded");
      setHint("Upload complete. Continue to checkout.");
      return;
    }

    setStatus("Ready");
    setHint(
      mode === "merge_pdf"
        ? "Upload your PDFs to merge."
        : (mode === "split_pdf"
            ? "Upload your PDF to split into pages."
            : (mode === "compress_pdf"
                ? "Upload your PDF to reduce file size."
                : (mode === "convert" ? "Upload files to convert." : "Upload your files to continue.")
              )
          )
    );
  };

  // ====== MODAL UI ======
  const syncModalTierUI = () => {
    const n = selected.length;
    const tier = getTier(n);

    const tierLabel =
      mode === "merge_pdf"
        ? "Merged PDF"
        : (mode === "split_pdf"
            ? "Split PDF"
            : (mode === "compress_pdf"
                ? "Compressed PDF"
                : (mode === "convert"
                    ? `Convert → ${(convertTargetValue || "JPG").toUpperCase()}`
                    : (tier.key === "zip50" ? "Pro ZIP" : "ZIP")
                  )
              )
          );

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
        const lvl =
          pdfCompressLevelValue === "max" ? "Maximum" :
          pdfCompressLevelValue === "light" ? "Light" : "Balanced";
        priceModalLead.innerHTML = `You’re compressing <b>1</b> PDF at <b>${lvl}</b> level.`;
      } else if (mode === "convert") {
        priceModalLead.innerHTML = `You’re converting <b>${n}</b> file${n === 1 ? "" : "s"} to <b>${escapeHtml((convertTargetValue || "jpg").toUpperCase())}</b>.`;
      } else {
        priceModalLead.innerHTML = `You’re about to checkout for <b>${n}</b> file${n === 1 ? "" : "s"}.`;
      }
    }
  };

  const syncModalTotalUI = () => {
    const total = calcTotal();
    if (priceInline) priceInline.textContent = `£${total.toFixed(2)}`;
  };

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

      if (pdfReorderWrap) pdfReorderWrap.hidden = true;
      if (pdfThumbGrid) pdfThumbGrid.innerHTML = "";
      pdfPageOrder = [];

      setStatus("Ready");
      setHint(
        mode === "merge_pdf"
          ? "Add <b>2+</b> PDFs to merge."
          : (mode === "split_pdf"
              ? "Add <b>1</b> PDF to split."
              : (mode === "compress_pdf"
                  ? "Add <b>1</b> PDF to compress."
                  : (mode === "convert" ? "Choose a target format, then drop files." : "Drop files to begin.")
                )
            )
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

    fileList.innerHTML = selected.map((f, idx) => {
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
    }).join("");

    fileMeta.hidden = false;

    setDropzoneCopy();
    setFileInputAccept();
    setPrimaryStates();
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
    resetProgress();
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
      // Only meaningful in compress_pdf mode; ignore elsewhere safely
      const lvl = btn.getAttribute("data-preset-level");
      applyPdfLevel(lvl, "Preset changed");
    });
  });

  // ====== MODE SYNC ======
  const enforceModeFromPage = () => {
    // If the page declares a tool, force the correct hidden radio state.
    // (compress-pdf.html has hidden radios; we keep IDs unchanged)
    if (!pageTool) return;

    if (pageTool === "compress_pdf" && modeCompressPdf) {
      modeCompressPdf.checked = true;
    }
    // If you later add data-tool="merge_pdf" etc., you can extend here.
  };

  const syncMode = () => {
    enforceModeFromPage();

    const isCompressPdf = !!modeCompressPdf?.checked;
    const isConvert = !!modeConvert?.checked;
    const isMerge = !!modeMergePdf?.checked;
    const isSplit = !!modeSplitPdf?.checked;

    mode = isMerge
      ? "merge_pdf"
      : (isSplit
          ? "split_pdf"
          : (isCompressPdf
              ? "compress_pdf"
              : (isConvert ? "convert" : "compress")
            )
        );

    safeLocalSet(LS.lastMode, mode);

    if (convertRow) convertRow.style.display = (mode === "convert") ? "flex" : "none";
    if (pdfCompressRow) pdfCompressRow.style.display = (mode === "compress_pdf") ? "flex" : "none";

    if (mode === "convert") {
      convertTargetValue = convertTarget?.value || "jpg";
      safeLocalSet(LS.lastTarget, convertTargetValue);
      setHint("Choose a target format, then upload files to convert.");
    } else if (mode === "merge_pdf") {
      convertTargetValue = null;
      setHint("Upload <b>2+</b> PDFs to merge into one file.");
    } else if (mode === "split_pdf") {
      convertTargetValue = null;
      setHint("Upload <b>1</b> PDF to split into separate pages.");
    } else if (mode === "compress_pdf") {
      convertTargetValue = null;
      const lvl =
        pdfCompressLevelValue === "max" ? "Maximum" :
        pdfCompressLevelValue === "light" ? "Light" : "Balanced";
      setHint(`Upload <b>1</b> PDF to compress. Level: <b>${lvl}</b>.`);
    } else {
      convertTargetValue = null;
      setHint("Upload files to create a ZIP.");
    }

    setDropzoneCopy();
    setFileInputAccept();

    if (uploadedMeta.length || jobId) {
      hardResetJob("Mode changed — please upload again.");
    }

    if ((mode === "merge_pdf" || mode === "split_pdf" || mode === "compress_pdf") && selected.length) {
      const hasNonPdf = selected.some((f) => !isPdfFile(f));
      if (hasNonPdf) {
        selected = [];
        uploadedMeta = [];
        resetProgress();
        for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
        thumbUrls.clear();
        setStatus("PDFs only");
        const label =
          mode === "merge_pdf" ? "Merge PDFs" :
          mode === "split_pdf" ? "Split PDF" :
          "Compress PDF";
        setHint(`${label} only accepts PDF files.`);
        renderSelected();
        return;
      }
    }

    if ((mode === "split_pdf" || mode === "compress_pdf") && selected.length > 1) {
      selected = [selected[0]];
      uploadedMeta = [];
      resetProgress();
      setStatus("Only one PDF");
      setHint(`${mode === "split_pdf" ? "Split PDF" : "Compress PDF"} accepts <b>1</b> PDF only.`);
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

    if (savedTarget && convertTarget) {
      convertTarget.value = savedTarget;
    }

    if (savedPdfLevel && pdfCompressLevel) {
      pdfCompressLevel.value = savedPdfLevel;
      pdfCompressLevelValue = normalizePdfLevel(savedPdfLevel);
    } else {
      pdfCompressLevelValue = normalizePdfLevel(pdfCompressLevel?.value || "balanced");
    }

    // Only restore lastMode if we're on the index (tabs exist).
    // Tool pages should force their own mode via data-tool.
    const onTabbedIndex =
      !!(modeCompress && modeCompressPdf && modeConvert && modeMergePdf && modeSplitPdf) &&
      !pageTool; // no data-tool on index

    if (onTabbedIndex && savedMode) {
      if (savedMode === "merge_pdf" && modeMergePdf) modeMergePdf.checked = true;
      else if (savedMode === "split_pdf" && modeSplitPdf) modeSplitPdf.checked = true;
      else if (savedMode === "compress_pdf" && modeCompressPdf) modeCompressPdf.checked = true;
      else if (savedMode === "convert" && modeConvert) modeConvert.checked = true;
      else if (modeCompress) modeCompress.checked = true;
    }
  };

  restoreModePrefs();
  // Ensure preset pills show correct active state on load (if present)
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
      setHint(errors.slice(0, 2).map(e => escapeHtml(e)).join("<br/>") + (errors.length > 2 ? "<br/>…" : ""));
    }

    // Split / Compress PDF: selecting another PDF REPLACES
    if (mode === "split_pdf" || mode === "compress_pdf") {
      if (!incomingValid.length) {
        setPrimaryStates();
        return;
      }

      selected = [incomingValid[0]];

      uploadedMeta = [];
      resetProgress();
      renderSelected();

      try { await ensureJob(); } catch {
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

    uploadedMeta = [];
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
    try { filesEl.click(); } catch {}
  });

  filesEl.addEventListener("change", async () => {
    if (!filesEl.files || filesEl.files.length === 0) return;
    await addFiles(filesEl.files);
    filesEl.value = "";
  });

  // ====== DRAG & DROP ======
  ["dragenter","dragover"].forEach(evt =>
    window.addEventListener(evt, (e) => { e.preventDefault(); }, { passive:false })
  );
  window.addEventListener("drop", (e) => { e.preventDefault(); }, { passive:false });

  let dragDepth = 0;
  const dragOn = () => dropzone.classList.add("isDrag");
  const dragOff = () => dropzone.classList.remove("isDrag");

  dropzone.addEventListener("dragenter", (e) => { e.preventDefault(); e.stopPropagation(); dragDepth++; dragOn(); });
  dropzone.addEventListener("dragleave", (e) => {
    e.preventDefault(); e.stopPropagation();
    dragDepth = clamp(dragDepth - 1, 0, 999);
    if (dragDepth === 0) dragOff();
  });
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); dragOn(); });
  dropzone.addEventListener("drop", async (e) => {
    e.preventDefault(); e.stopPropagation();
    dragDepth = 0; dragOff();
    const dt = e.dataTransfer;
    const files = dt?.files ? [...dt.files] : [];
    if (!files.length) {
      setStatus("Drop files only");
      setHint("Try dragging files from Finder.");
      return;
    }
    await addFiles(files);
  });

  clearBtn?.addEventListener("click", () => {
    if (uploading) return;
    selected = [];
    uploadedMeta = [];
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
      commitFile: (fileSize) => { uploadedBytes += fileSize; setOverall(uploadedBytes); },
      currentFile: (loaded) => { setOverall(uploadedBytes + loaded); },
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

      if (mode === "merge_pdf" && pdfPageOrder.length) {
        payload.order = pdfPageOrder;
      }

      if (mode === "compress_pdf") {
        payload.level = pdfCompressLevelValue || "balanced";
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
      }
      return;
    }

    try { await ensureJob(); } catch {
      setStatus("Couldn’t start");
      setHint("Refresh and try again.");
      return;
    }

    uploading = true;
    setBusy(true);
    setPrimaryStates();

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
            type: isPdfFile(f) ? "application/pdf" : (f.type || "application/octet-stream"),
          }),
        });

        const presign = await presignRes.json();
        if (presign?.error) throw new Error(presign.error);
        if (!presign?.url || !presign?.key) throw new Error("Failed to prepare upload");

        await putWithProgress(presign.url, f, (loaded) => prog.currentFile(loaded));

        uploadedMeta.push({
          key: presign.key,
          originalname: f.name,
          mimetype: isPdfFile(f) ? "application/pdf" : (f.type || "application/octet-stream"),
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

      setStatus("Uploaded");
      setHint("Upload complete. Continue to checkout.");

      if (progressLabel) progressLabel.textContent = "Uploaded";
      if (progressFill) progressFill.style.width = "100%";
      if (progressPct) progressPct.textContent = "100%";

      setPrimaryStates();
    } catch (e) {
      setStatus("Upload failed");
      setHint(escapeHtml(e?.message || "Please try again."));
      if (progressLabel) progressLabel.textContent = "Upload failed";
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
    if (!priceModal) return;

    disableLegacyOptions();

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
          priceModalNote.textContent = "You’ll be redirected to secure Stripe Checkout.";
        }
      });
      shareListenerAttached = true;
    }

    if (priceModalNote) {
      priceModalNote.textContent = shouldRecommendShare()
        ? "You’ll be redirected to secure Stripe Checkout. Share link is often useful for sending."
        : "You’ll be redirected to secure Stripe Checkout.";
    }

    priceModal.classList.add("isOpen");
    priceModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    modalPayBtn?.focus();
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
  priceModal?.addEventListener("click", (e) => { if (e.target === priceModal) closePriceModal(); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && priceModal?.classList.contains("isOpen")) closePriceModal();
  });

  continueBtn.addEventListener("click", () => {
    if (!jobId) return;
    if (!uploadedMeta.length) {
      setStatus("Upload first");
      setHint("Please upload your files before continuing.");
      return;
    }
    openPriceModal();
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
          shareLink: !!optShareLink?.checked,
          tier: tier.key,
          fileCount: n,
        }),
      }).then(r => r.json());

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

  modalPayBtn?.addEventListener("click", async () => {
    closePriceModal();
    await startCheckout();
  });

  // ====== INIT ======
  continueBtn.textContent = "Continue →";
  continueBtn.style.display = "";

  pdfCompressLevelValue = normalizePdfLevel(
    pdfCompressLevel?.value ||
    safeLocalGet(LS.lastPdfLevel) ||
    "balanced"
  );

  // Ensure preset highlight matches selected level
  setPresetActive(pdfCompressLevelValue);

  setStatus("Ready");
  setHint("Choose a mode and add files.");
  setDropzoneCopy();
  setFileInputAccept();
  renderSelected();
})();