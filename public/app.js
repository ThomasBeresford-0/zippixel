const startBtn = document.getElementById("start");
const box = document.getElementById("box");
const filesInput = document.getElementById("files");
const uploadBtn = document.getElementById("upload");
const payBtn = document.getElementById("pay");
const status = document.getElementById("status");

let jobId = null;

startBtn.onclick = async () => {
  startBtn.style.display = "none";
  box.style.display = "block";

  const res = await fetch("/create-job", { method: "POST" });
  const data = await res.json();
  jobId = data.jobId;
  status.textContent = "Job created. Choose images.";
};

uploadBtn.onclick = async () => {
  const files = filesInput.files;
  if (!files.length) return alert("Choose images");

  const form = new FormData();
  for (const file of files) form.append("images", file);
  form.append("jobId", jobId);

  status.textContent = "Uploading images...";

  await fetch("/upload", {
    method: "POST",
    body: form,
  });

  status.textContent = "Upload complete. Ready to pay.";
  payBtn.disabled = false;
};

payBtn.onclick = async () => {
  const plan = document.querySelector("input[name='plan']:checked").value;

  const res = await fetch("/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, plan }),
  });

  const data = await res.json();
  window.location.href = data.url;
};
