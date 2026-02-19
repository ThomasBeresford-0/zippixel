// public/app.js — ZipPixel frontend (v15.3 - PREMIUM RAMBO UX, PRICE HIDDEN UNTIL MODAL)
// Matches: v19 index.html IDs + server.js v15 routes:
// /api/jobs, /api/upload-url, /api/jobs/:jobId/register, /api/checkout
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

  // If this page doesn’t have the tool, bail quietly
  if (!dropzone || !filesEl || !chooseBtn || !uploadBtn || !continueBtn) return;

  // ====== STATE ======
  let jobId = null;
  let creatingJob = false;
  let uploading = false;

  // ====== MODE STATE ======
// ====== MODE STATE (UPGRADED) ======
let mode = "compress";
let convertTargetValue = null;

const modeCompress = document.getElementById("modeCompress");
const modeConvert = document.getElementById("modeConvert");
const convertRow = document.getElementById("convertRow");
const convertFrom = document.getElementById("convertFrom");
const convertTarget = document.getElementById("convertTarget");

const syncMode = () => {
  if (modeConvert?.checked) {
    mode = "convert";
    if (convertRow) convertRow.style.display = "flex";
    convertTargetValue = convertTarget?.value || "jpg";

    setHint("Upload files to convert.");
  } else {
    mode = "compress";
    if (convertRow) convertRow.style.display = "none";
    convertTargetValue = null;

    setHint("Upload files to create a ZIP.");
  }
};

modeCompress?.addEventListener("change", syncMode);
modeConvert?.addEventListener("change", syncMode);
convertTarget?.addEventListener("change", () => {
  convertTargetValue = convertTarget?.value || "jpg";
});

syncMode();

  modeCompress?.addEventListener("change", syncMode);
  modeConvert?.addEventListener("change", syncMode);
  convertTarget?.addEventListener("change", syncMode);

  syncMode();

  let selected = [];            // Array<File>
  const thumbUrls = new Map();  // keyOf(file) -> objectURL (images only)
  let uploadedMeta = [];        // [{ key, originalname, mimetype }]

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
  const isPdfFile = (f) => (f?.type || "") === "application/pdf";

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

  const validateFile = (f) => {
    if (!f) return "Invalid file.";
    if (f.size > MAX_MB_EACH * 1024 * 1024) {
      return `“${f.name}” is ${humanMB(f.size)} (max ${MAX_MB_EACH}MB).`;
    }
    return null;
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

  // ====== PREMIUM UX: continue always visible (no “where’s pay?”) ======
  const showContinue = (enabled) => {
    continueBtn.style.display = "";
    continueBtn.disabled = !enabled;
    continueBtn.classList.toggle("isDisabled", !enabled);
  };

  const setPrimaryStates = () => {
    const hasFiles = selected.length > 0;
    const hasJob = !!jobId;
    const canUpload = hasFiles && hasJob && !uploading;
    const canContinue = !!uploadedMeta.length && !uploading;

    uploadBtn.disabled = !canUpload;

    // Continue is ALWAYS visible
    showContinue(canContinue);
    continueBtn.textContent = "Continue →";

    // Button labels + hints
    if (!hasFiles) {
      uploadBtn.textContent = "Upload files";
      setStatus("Ready");
      setHint("Add up to <b>50</b> files. Then upload.");
      return;
    }

    if (!hasJob) {
      uploadBtn.textContent = "Preparing…";
      return;
    }

    if (uploading) {
      uploadBtn.textContent = "Uploading…";
      return;
    }

    if (uploadedMeta.length) {
      uploadBtn.textContent = "Re-upload";
      return;
    }

    uploadBtn.textContent = "Upload files";
  };

  const syncModalTierUI = () => {
    const n = selected.length;
    const tier = getTier(n);

    if (tierInline) tierInline.textContent = tier.key === "zip50" ? "Pro ZIP" : "ZIP";
    if (countInline) countInline.textContent = String(n);

    if (rowStandard) rowStandard.classList.toggle("isChosen", tier.key === "zip10");
    if (rowPro) rowPro.classList.toggle("isChosen", tier.key === "zip50");

    if (priceModalLead) {
      priceModalLead.innerHTML = `You’re about to checkout for <b>${n}</b> file${n === 1 ? "" : "s"}.`;
    }
  };

  const syncModalTotalUI = () => {
    const total = calcTotal();
    if (priceInline) priceInline.textContent = `£${total.toFixed(2)}`;
  };

  const renderSelected = () => {
    if (!fileMeta || !fileSummary || !fileList) return;

    if (selected.length === 0) {
      fileMeta.hidden = true;
      fileSummary.textContent = "";
      fileList.innerHTML = "";
      uploadedMeta = [];
      resetProgress();
      revokeRemovedThumbs(new Set());

      setStatus("Ready");
      setHint("Drop files to begin.");
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

    // Premium hints
    if (jobId) {
      setStatus(uploadedMeta.length ? "Uploaded" : "Ready");
      setHint(uploadedMeta.length ? "Continue to checkout." : "Upload your files to continue.");
    } else {
      setStatus("Preparing");
      setHint("Setting up a secure upload…");
    }

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
      setStatus(selected.length ? "Ready" : "Ready");
      setHint(selected.length ? "Upload your files to continue." : "Drop files to begin.");
      renderSelected();
      return jobId;
    } catch (err) {
      setStatus("Couldn’t start");
      setHint("Refresh and try again.");
      renderSelected();
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
      const err = validateFile(f);
      if (err) errors.push(err);
      else incomingValid.push(f);
    }

    if (errors.length) {
      setStatus("Some files were skipped");
      setHint(errors.slice(0, 2).map(e => escapeHtml(e)).join("<br/>") + (errors.length > 2 ? "<br/>…" : ""));
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
    filesEl.click();
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
      commitFile: (fileSize) => {
        uploadedBytes += fileSize;
        setOverall(uploadedBytes);
      },
      currentFile: (loaded, total) => {
        const bytesSoFar = uploadedBytes + loaded;
        setOverall(bytesSoFar);
      },
      done: () => setOverall(totalBytes),
    };
  };

  uploadBtn.addEventListener("click", async () => {
    if (uploading) return;
    if (selected.length === 0) return;

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

    // Tell backend what mode we're using
    await fetch(`/api/jobs/${jobId}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        target: convertTargetValue
      })
    });

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
            type: f.type || "application/octet-stream",
          }),
        });

        const presign = await presignRes.json();
        if (presign?.error) throw new Error(presign.error);
        if (!presign?.url || !presign?.key) throw new Error("Failed to prepare upload");

        await putWithProgress(presign.url, f, (loaded, total) => prog.currentFile(loaded, total));

        uploadedMeta.push({
          key: presign.key,
          originalname: f.name,
          mimetype: f.type || "application/octet-stream",
        });

        prog.commitFile(f.size);
      }

      prog.done();

      const regRes = await fetch(`/api/jobs/${jobId}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: uploadedMeta }),
      });

      const reg = await regRes.json();
      if (reg?.error) throw new Error(reg.error);

      setStatus("Uploaded");
      setHint(`Upload complete. Continue to checkout.<br/><span style="color: rgba(11,18,32,.56)">Optional: add a share link at checkout.</span>`);

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

    // Default share link OFF (trust-first). Flip true if you want higher AOV.
    if (optShareLink) optShareLink.checked = false;

    syncModalTierUI();
    syncModalTotalUI();

    if (!shareListenerAttached && optShareLink) {
      optShareLink.addEventListener("change", syncModalTotalUI);
      shareListenerAttached = true;
    }

    if (priceModalNote) {
      priceModalNote.textContent = "You’ll be redirected to secure Stripe Checkout.";
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
    if (selected.length === 0) return;

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
          tier: tier.key,     // informational (backend can ignore)
          fileCount: n,       // informational
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
  continueBtn.style.display = "";   // never hidden
  setStatus("Ready");
  setHint("Drop files to begin.");
  renderSelected();
})();