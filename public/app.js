// public/app.js — ZipPixel frontend (v13)
// Matches: v13 index.html IDs + UPDATED server.js routes:
// /api/jobs, /api/upload-url, /api/jobs/:jobId/register, /api/checkout

(() => {
  // ====== YEAR ======
  const y = document.getElementById("y");
  if (y) y.textContent = new Date().getFullYear();

  // ====== PRICING (must match backend logic) ======
  const STANDARD_MAX = 5;
  const PRO_MAX = 10;

  const STANDARD_PRICE = 2.99;
  const PRO_PRICE = 4.99;

  const PRINT_READY_PRICE = 1.99;
  const EMAIL_SAFE_PRICE = 1.49;
  const SHARE_LINK_PRICE = 2.49;
  const DAY_PASS_PRICE = 9.99;

  const MAX_FILES = PRO_MAX;
  const MAX_MB_EACH = 25;

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

  const optPrintReady = document.getElementById("optPrintReady");
  const optKeepNames = document.getElementById("optKeepNames");
  const optEmailSafe = document.getElementById("optEmailSafe");
  const optListingNames = document.getElementById("optListingNames");
  const optShareLink = document.getElementById("optShareLink");
  const optDayPass = document.getElementById("optDayPass");

  const priceModalLead = document.getElementById("priceModalLead");
  const priceModalNote = document.getElementById("priceModalNote");
  const rowStandard = document.getElementById("rowStandard");
  const rowPro = document.getElementById("rowPro");
  const tierInline = document.getElementById("tierInline");
  const priceInline = document.getElementById("priceInline");
  const countInline = document.getElementById("countInline");

  // If this page doesn’t have the tool, bail quietly
  if (!dropzone || !filesEl || !chooseBtn || !uploadBtn || !continueBtn) return;

  // ====== STATE ======
  let jobId = null;
  let creatingJob = false;
  let uploading = false;
  let selected = [];            // Array<File>
  const thumbUrls = new Map();  // keyOf(file) -> objectURL (images only)

  // New: store uploaded metadata for register call
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

  // Allow ANY file type; only enforce size limit
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

  const getTier = () => (selected.length > STANDARD_MAX ? "pro" : "standard");
  const getTierLabel = () => (getTier() === "pro" ? "Pro ZIP" : "Standard ZIP");
  const setChosen = (el, chosen) => el && el.classList.toggle("isChosen", !!chosen);

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

  const renderSelected = () => {
    if (!fileMeta || !fileSummary || !fileList) return;

    if (selected.length === 0) {
      fileMeta.hidden = true;
      fileSummary.textContent = "";
      fileList.innerHTML = "";
      uploadBtn.disabled = true;
      continueBtn.disabled = true;
      resetProgress();
      setStatus("Ready.");
      setHint("Drop files to begin.");
      revokeRemovedThumbs(new Set());
      return;
    }

    const total = selected.reduce((a, f) => a + f.size, 0);
    fileSummary.textContent = `Selected ${selected.length} file(s) • Total ${humanMB(total)}.`;

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

    uploadBtn.disabled = !jobId || uploading;
    continueBtn.disabled = true;

    if (jobId) {
      setStatus("Ready.");
      setHint("Upload your files to continue.");
    } else {
      setStatus("Starting…");
      setHint("Creating a job…");
    }
  };

  // Remove item
  fileList?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (!btn) return;
    const idx = Number(btn.getAttribute("data-remove"));
    if (!Number.isFinite(idx)) return;

    const removed = selected.splice(idx, 1)[0];
    if (removed) {
      const k = keyOf(removed);
      const url = thumbUrls.get(k);
      if (url) URL.revokeObjectURL(url);
      thumbUrls.delete(k);
    }

    // Any selection change invalidates previous upload metadata
    uploadedMeta = [];
    continueBtn.disabled = true;

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
    setStatus("Starting…");
    setHint("Creating a job…");
    renderSelected();

    try {
      const res = await fetch("/api/jobs", { method: "POST" });
      if (!res.ok) throw new Error("Failed to create job");
      const j = await res.json();
      if (!j?.jobId) throw new Error("No jobId returned");

      jobId = j.jobId;
      setStatus("Ready.");
      setHint(selected.length ? "Upload your files to continue." : "Drop files to begin.");
      renderSelected();
      return jobId;
    } catch (err) {
      setStatus("Couldn’t start.");
      setHint("Refresh and try again.");
      renderSelected();
      throw err;
    } finally {
      creatingJob = false;
      setBusy(false);
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
      setStatus("Some files were skipped.");
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
      setStatus("Max reached.");
      setHint(`Only the first <b>${MAX_FILES}</b> files were kept.`);
    }

    // Any selection change invalidates previous upload metadata
    uploadedMeta = [];
    continueBtn.disabled = true;

    renderSelected();

    try {
      await ensureJob();
    } catch {
      setStatus("Couldn’t start.");
      setHint("Refresh and try again.");
      return;
    }

    uploadBtn.disabled = uploading || selected.length === 0;
  };

  // Choose files button
  chooseBtn.addEventListener("click", (e) => {
    e.preventDefault();
    filesEl.click();
  });

  // File picker changed
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
      setStatus("Drop files only.");
      setHint("Try dragging files from Finder.");
      return;
    }
    await addFiles(files);
  });

  // Clear
  clearBtn?.addEventListener("click", () => {
    if (uploading) return;
    selected = [];
    uploadedMeta = [];
    for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
    thumbUrls.clear();
    renderSelected();
  });

  // ====== UPLOAD (DIRECT TO R2) ======
  // Uses /api/upload-url (get presigned PUT URL) then PUT file bytes to R2
  const putWithProgress = (url, file, onProgress) => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url, true);

      xhr.upload.onprogress = (evt) => {
        if (!evt.lengthComputable) return;
        onProgress?.(evt.loaded, evt.total);
      };

      xhr.onload = () => {
        // R2 PUT usually returns 200/201 with empty body
        if (xhr.status >= 200 && xhr.status < 300) resolve(true);
        else reject(new Error(`Upload failed (${xhr.status})`));
      };

      xhr.onerror = () => reject(new Error("Network error"));
      xhr.send(file);
    });
  };

  // Weighted progress across many files (by total bytes)
  const makeProgressReporter = (totalBytes) => {
    let uploadedBytes = 0;

    const setOverall = (bytesSoFar) => {
      const pct = totalBytes ? Math.round((bytesSoFar / totalBytes) * 100) : 0;
      if (progressFill) progressFill.style.width = `${pct}%`;
      if (progressPct) progressPct.textContent = `${pct}%`;
      if (progressMeta) progressMeta.textContent = `${humanMB(bytesSoFar)} / ${humanMB(totalBytes)}`;
    };

    // Initialize
    setOverall(0);

    return {
      // call between files to “commit” completed file bytes
      commitFile: (fileSize) => {
        uploadedBytes += fileSize;
        setOverall(uploadedBytes);
      },
      // call during current file upload
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
      setStatus("Couldn’t start.");
      setHint("Refresh and try again.");
      return;
    }

    uploading = true;
    setBusy(true);
    uploadBtn.disabled = true;
    continueBtn.disabled = true;

    resetProgress();
    if (progressWrap) progressWrap.hidden = false;
    if (progressLabel) progressLabel.textContent = "Uploading…";
    if (progressFill) progressFill.style.width = "0%";
    if (progressPct) progressPct.textContent = "0%";
    if (progressMeta) progressMeta.textContent = "";

    setStatus("Uploading…");
    setHint("Keep this tab open.");

    // If you re-upload (same job) we just overwrite metadata; server-side can cleanup old objects later
    uploadedMeta = [];

    const totalBytes = selected.reduce((a, f) => a + f.size, 0);
    const prog = makeProgressReporter(totalBytes);

    try {
      // Upload sequentially (simple + reliable). If you want, we can add parallel 3-at-a-time later.
      for (let i = 0; i < selected.length; i++) {
        const f = selected[i];

        if (progressLabel) {
          progressLabel.textContent = `Uploading ${i + 1}/${selected.length}…`;
        }

        // 1) Get presigned URL for this file
        const presign = await fetch("/api/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId,
            filename: f.name,
            type: f.type || "application/octet-stream",
          }),
        }).then((r) => r.json());

        if (presign?.error) throw new Error(presign.error);
        if (!presign?.url || !presign?.key) throw new Error("Failed to prepare upload");

        // 2) PUT the bytes directly to R2
        await putWithProgress(presign.url, f, (loaded, total) => {
          prog.currentFile(loaded, total);
        });

        // 3) Record metadata for register step
        uploadedMeta.push({
          key: presign.key,
          originalname: f.name,
          mimetype: f.type || "application/octet-stream",
        });

        // commit this file’s bytes as done
        prog.commitFile(f.size);
      }

      prog.done();

      // 4) Tell server “these are the uploaded files for this job”
      const reg = await fetch(`/api/jobs/${jobId}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: uploadedMeta }),
      }).then((r) => r.json());

      if (reg?.error) throw new Error(reg.error);

      setStatus("Uploaded.");
      setHint(
        `Uploaded. Continue to confirm and proceed to payment.<br/><span style="color: rgba(11,18,32,.56)">Tip: add a shareable link at checkout to send this to a client.</span>`
      );
      if (progressLabel) progressLabel.textContent = "Uploaded";
      if (progressFill) progressFill.style.width = "100%";
      if (progressPct) progressPct.textContent = "100%";
      continueBtn.disabled = false;
    } catch (e) {
      setStatus("Upload failed.");
      setHint(escapeHtml(e?.message || "Please try again."));
      uploadBtn.disabled = false;
      if (progressLabel) progressLabel.textContent = "Upload failed";
    } finally {
      uploading = false;
      setBusy(false);
    }
  });

  // ====== MODAL ======
  const openPriceModal = () => {
    if (!priceModal) return;

    const tier = getTier();
    const n = selected.length;

    if (priceModalLead) priceModalLead.innerHTML = `You’ve uploaded <b>${n}</b> file${n === 1 ? "" : "s"}.`;
    if (tierInline) tierInline.textContent = getTierLabel();
    if (countInline) countInline.textContent = String(n);

    setChosen(rowStandard, tier === "standard");
    setChosen(rowPro, tier === "pro");

    const updateTotal = () => {
      // Day pass overrides totals
      if (optDayPass?.checked) {
        if (priceInline) priceInline.textContent = `£${DAY_PASS_PRICE.toFixed(2)}`;
        return;
      }

      let base = (tier === "pro" ? PRO_PRICE : STANDARD_PRICE);
      let total = base;

      if (optPrintReady?.checked) total += PRINT_READY_PRICE;
      if (optEmailSafe?.checked) total += EMAIL_SAFE_PRICE;
      if (optShareLink?.checked) total += SHARE_LINK_PRICE;

      if (priceInline) priceInline.textContent = `£${total.toFixed(2)}`;
    };

    // Defaults (money lever): Share link ON by default
    if (optPrintReady) optPrintReady.checked = false;
    if (optEmailSafe) optEmailSafe.checked = false;
    if (optShareLink) optShareLink.checked = true;
    if (optKeepNames) optKeepNames.checked = false;
    if (optListingNames) optListingNames.checked = false;
    if (optDayPass) optDayPass.checked = false;

    // Mutually exclusive naming (avoid “keep names didn’t work” confusion)
    const normalizeNaming = () => {
      if (optListingNames?.checked) {
        if (optKeepNames) optKeepNames.checked = false;
      }
      if (optKeepNames?.checked) {
        if (optListingNames) optListingNames.checked = false;
      }
    };

    // Day pass: disable other paid toggles (UX clarity)
    const setPaidDisabled = (disabled) => {
      [optPrintReady, optEmailSafe, optShareLink].forEach((el) => {
        if (!el) return;
        el.disabled = disabled;
      });
    };

    // If day pass is checked, auto-uncheck other paid add-ons (keeps totals clean)
    const normalizePaidOptions = () => {
      if (!optDayPass) return;
      const on = !!optDayPass.checked;

      setPaidDisabled(on);

      if (on) {
        if (optPrintReady) optPrintReady.checked = false;
        if (optEmailSafe) optEmailSafe.checked = false;
        if (optShareLink) optShareLink.checked = true; // keep share link on (it’s the point)
      }
    };

    normalizeNaming();
    normalizePaidOptions();
    updateTotal();

    // Bind change handlers
    [optPrintReady, optEmailSafe, optShareLink, optDayPass].forEach((el) => {
      if (!el) return;
      el.onchange = () => {
        normalizePaidOptions();
        updateTotal();
      };
    });

    [optKeepNames, optListingNames].forEach((el) => {
      if (!el) return;
      el.onchange = () => {
        normalizeNaming();
      };
    });

    if (priceModalNote) {
      priceModalNote.textContent =
        tier === "pro"
          ? "Pro selected automatically for 6+ files."
          : "You’ll be redirected to secure Stripe Checkout.";
    }

    priceModal.classList.add("isOpen");
    document.body.style.overflow = "hidden";
    modalPayBtn?.focus();
  };

  const closePriceModal = () => {
    if (!priceModal) return;
    priceModal.classList.remove("isOpen");
    document.body.style.overflow = "";
    continueBtn?.focus();
  };

  modalCloseBtn?.addEventListener("click", closePriceModal);
  modalBackBtn?.addEventListener("click", closePriceModal);
  priceModal?.addEventListener("click", (e) => { if (e.target === priceModal) closePriceModal(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && priceModal?.classList.contains("isOpen")) closePriceModal(); });

  // Continue => open modal
  continueBtn.addEventListener("click", async () => {
    if (!jobId) return;
    if (selected.length === 0) return;

    // Require an upload to have completed for current selection
    if (!uploadedMeta.length) {
      setStatus("Upload first.");
      setHint("Please upload your files before continuing.");
      return;
    }

    openPriceModal();
  });

  // ====== CHECKOUT ======
  const startCheckout = async () => {
    if (!jobId) return;

    setBusy(true);
    setStatus("Redirecting…");
    setHint("Opening secure checkout…");
    continueBtn.disabled = true;

    try {
      const resp = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          printReady: !!optPrintReady?.checked,
          keepNames: !!optKeepNames?.checked,
          emailSafe: !!optEmailSafe?.checked,
          shareLink: !!optShareLink?.checked,
          namingPreset: optListingNames?.checked ? "listing" : null,
          dayPass: !!optDayPass?.checked
        })
      }).then(r => r.json());

      if (resp?.error) throw new Error(resp.error);
      if (!resp?.url) throw new Error("Something went wrong.");
      window.location.href = resp.url;
    } catch (e) {
      setStatus("Couldn’t continue.");
      setHint(escapeHtml(e?.message || "Please try again."));
      continueBtn.disabled = false;
    } finally {
      setBusy(false);
    }
  };

  modalPayBtn?.addEventListener("click", async () => {
    closePriceModal();
    await startCheckout();
  });

  // ====== INIT ======
  renderSelected();
})();
