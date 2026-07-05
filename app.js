(() => {
  "use strict";

  const statusEl      = document.getElementById("status");
  const fileInput     = document.getElementById("fileInput");
  const fileInfo      = document.getElementById("fileInfo");
  const optionsCard   = document.getElementById("optionsCard");

  const speedSlider   = document.getElementById("speedSlider");
  const speedInput    = document.getElementById("speedInput");
  const keepAudio     = document.getElementById("keepAudio");
  const qualitySelect = document.getElementById("qualitySelect");
  const processBtn    = document.getElementById("processBtn");

  const progressWrap  = document.getElementById("progressWrap");
  const progressFill  = document.getElementById("progressFill");
  const progressLabel = document.getElementById("progressLabel");
  const errorBox      = document.getElementById("errorBox");

  const resultCard    = document.getElementById("resultCard");
  const resultVideo   = document.getElementById("resultVideo");
  const downloadLink  = document.getElementById("downloadLink");
  const downloadMeta  = document.getElementById("downloadMeta");

  const CORE_BASE = "vendor/core";

  let currentFile = null;
  let ffmpeg = null;
  let ffmpegReady = false;
  let resultObjectUrl = null;

  // ---------- helpers ----------
  function setStatus(kind, text) {
    statusEl.className = "status" + (kind ? " " + kind : "");
    statusEl.textContent = text;
  }

  function showError(msg) {
    errorBox.hidden = false;
    errorBox.textContent = msg;
  }
  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  function humanSize(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    let i = 0, v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
  }

  function setOptionsEnabled(enabled) {
    optionsCard.classList.toggle("disabled", !enabled);
    speedSlider.disabled = !enabled;
    speedInput.disabled = !enabled;
    keepAudio.disabled = !enabled;
    qualitySelect.disabled = !enabled;
    processBtn.disabled = !enabled;
  }

  // ---------- file selection ----------
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      showError("Il file selezionato non è un video.");
      return;
    }
    clearError();
    currentFile = file;
    fileInfo.textContent = `${file.name} — ${humanSize(file.size)}`;
    setOptionsEnabled(true);
    resultCard.hidden = true;
    progressWrap.hidden = true;
  });

  // ---------- speed sync ----------
  function syncSpeed(value, source) {
    const v = Math.min(4, Math.max(0.25, value));
    if (source !== "slider") speedSlider.value = v;
    if (source !== "input") speedInput.value = v;
  }
  speedSlider.addEventListener("input", () => syncSpeed(parseFloat(speedSlider.value), "slider"));
  speedInput.addEventListener("input", () => {
    const v = parseFloat(speedInput.value);
    if (!isNaN(v)) syncSpeed(v, "input");
  });

  // ---------- ffmpeg load ----------
  async function ensureFfmpegLoaded() {
    if (ffmpegReady) return;

    if (typeof FFmpegWASM === "undefined" || typeof FFmpegUtil === "undefined") {
      throw new Error(
        "Le librerie ffmpeg.wasm non sono state caricate. Verifica che la cartella 'vendor' sia presente accanto a index.html e che la pagina sia servita via http:// (non aperta con doppio click)."
      );
    }

    const { FFmpeg } = FFmpegWASM;
    const { toBlobURL } = FFmpegUtil;

    ffmpeg = new FFmpeg();
    ffmpeg.on("progress", ({ progress }) => {
      const pct = Math.min(100, Math.max(0, progress * 100));
      progressFill.style.width = pct + "%";
      progressLabel.textContent = `Elaborazione: ${pct.toFixed(0)}%`;
    });

    setStatus("busy", "Caricamento motore…");
    progressWrap.hidden = false;
    progressLabel.textContent = "Caricamento motore (una sola volta)…";
    progressFill.style.width = "5%";

    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    });

    ffmpegReady = true;
    setStatus("ready", "Motore pronto");
  }

  // atempo supporta solo il range 0.5–2.0 per stadio: per velocità
  // fuori da questo range si incatenano più stadi mantenendo l'audio naturale.
  function buildAtempoChain(speed) {
    const factors = [];
    let remaining = speed;
    if (remaining >= 0.5 && remaining <= 2.0) {
      factors.push(remaining);
    } else if (remaining > 2.0) {
      while (remaining > 2.0) { factors.push(2.0); remaining /= 2.0; }
      factors.push(remaining);
    } else {
      while (remaining < 0.5) { factors.push(0.5); remaining /= 0.5; }
      factors.push(remaining);
    }
    return factors.map(f => `atempo=${f.toFixed(6)}`).join(",");
  }

  function guessExtension(file) {
    const m = file.name.match(/\.[^.]+$/);
    return m ? m[0] : ".mp4";
  }

  // ---------- process ----------
  async function processVideo() {
    if (!currentFile) return;

    clearError();
    processBtn.disabled = true;
    resultCard.hidden = true;

    try {
      await ensureFfmpegLoaded();

      const { fetchFile } = FFmpegUtil;
      const speed = parseFloat(speedInput.value);
      const crf = qualitySelect.value;
      const inputName = "input_" + Date.now().toString(36) + guessExtension(currentFile);
      const outputName = "output.mp4";

      progressWrap.hidden = false;
      progressFill.style.width = "0%";
      progressLabel.textContent = "Lettura del file…";
      setStatus("busy", "Elaborazione in corso…");

      await ffmpeg.writeFile(inputName, await fetchFile(currentFile));

      const ptsFactor = (1 / speed).toFixed(6);
      let args;

      if (keepAudio.checked) {
        const atempoChain = buildAtempoChain(speed);
        const filterComplex = `[0:v]setpts=${ptsFactor}*PTS[v];[0:a]${atempoChain}[a]`;
        args = [
          "-i", inputName,
          "-filter_complex", filterComplex,
          "-map", "[v]", "-map", "[a]",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", crf,
          "-c:a", "aac", "-b:a", "192k",
          "-movflags", "+faststart",
          outputName,
        ];
      } else {
        args = [
          "-i", inputName,
          "-vf", `setpts=${ptsFactor}*PTS`,
          "-an",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", crf,
          "-movflags", "+faststart",
          outputName,
        ];
      }

      progressLabel.textContent = "Elaborazione: 0%";
      await ffmpeg.exec(args);

      const data = await ffmpeg.readFile(outputName);
      const blob = new Blob([data.buffer], { type: "video/mp4" });

      if (resultObjectUrl) URL.revokeObjectURL(resultObjectUrl);
      resultObjectUrl = URL.createObjectURL(blob);

      resultVideo.src = resultObjectUrl;
      downloadLink.href = resultObjectUrl;
      const baseName = currentFile.name.replace(/\.[^.]+$/, "");
      downloadLink.download = `${baseName}-${speed.toFixed(2)}x.mp4`;
      downloadMeta.textContent = `${humanSize(blob.size)} · ${speed.toFixed(2)}×`;
      resultCard.hidden = false;

      try { await ffmpeg.deleteFile(inputName); await ffmpeg.deleteFile(outputName); } catch (_) {}

      setStatus("ready", "Motore pronto");
      progressLabel.textContent = "Completato.";
      progressFill.style.width = "100%";
      setTimeout(() => { progressWrap.hidden = true; }, 1000);
    } catch (err) {
      console.error(err);
      setStatus("error", "Errore");
      progressWrap.hidden = true;
      showError(
        err && err.message
          ? err.message
          : "Si è verificato un errore durante l'elaborazione. Riprova con un altro file o un'altra velocità."
      );
    } finally {
      processBtn.disabled = false;
    }
  }

  processBtn.addEventListener("click", processVideo);
})();
