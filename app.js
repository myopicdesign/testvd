// ============================================================
// Tempo — velocizza i video mantenendo l'audio naturale
// Usa ffmpeg.wasm nel browser: il filtro "atempo" ricampiona
// l'audio nel tempo (time-stretch), a differenza di un semplice
// resample che alzerebbe il tono e lo renderebbe robotico.
// ============================================================

(() => {
  "use strict";

  // ---------- DOM references ----------
  const dropzone       = document.getElementById("dropzone");
  const fileInput      = document.getElementById("fileInput");
  const browseBtn      = document.getElementById("browseBtn");
  const dropPanel      = document.getElementById("dropPanel");
  const editorPanel    = document.getElementById("editorPanel");

  const sourceVideo    = document.getElementById("sourceVideo");
  const resultCard     = document.getElementById("resultCard");
  const resultVideo    = document.getElementById("resultVideo");

  const speedSlider     = document.getElementById("speedSlider");
  const speedValueEl    = document.getElementById("speedValue");
  const tapeTrack        = document.getElementById("tapeTrack");
  const speedPresets      = document.getElementById("speedPresets");

  const keepAudio       = document.getElementById("keepAudio");
  const qualitySelect  = document.getElementById("qualitySelect");

  const processBtn      = document.getElementById("processBtn");
  const processBtnLabel = document.getElementById("processBtnLabel");
  const resetBtn         = document.getElementById("resetBtn");

  const progressWrap   = document.getElementById("progressWrap");
  const progressFill   = document.getElementById("progressFill");
  const progressLabel  = document.getElementById("progressLabel");

  const downloadWrap   = document.getElementById("downloadWrap");
  const downloadLink   = document.getElementById("downloadLink");
  const downloadMeta   = document.getElementById("downloadMeta");

  const engineDot        = document.getElementById("engineDot");
  const engineStatusText = document.getElementById("engineStatusText");
  const reelIcon          = document.getElementById("reel");

  // ---------- State ----------
  let currentFile = null;
  let ffmpeg = null;
  let ffmpegReady = false;
  let sourceObjectUrl = null;
  let resultObjectUrl = null;

  const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

  // ---------- Engine status helpers ----------
  function setEngineStatus(state, text) {
    engineDot.classList.remove("ready", "busy", "error");
    if (state) engineDot.classList.add(state);
    engineStatusText.textContent = text;
    reelIcon.classList.toggle("spinning", state === "busy");
  }

  // ---------- File loading ----------
  function humanSize(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    let i = 0, v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
  }

  function loadFile(file) {
    if (!file || !file.type.startsWith("video/")) {
      alert("Seleziona un file video valido.");
      return;
    }
    currentFile = file;

    if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
    sourceObjectUrl = URL.createObjectURL(file);
    sourceVideo.src = sourceObjectUrl;

    // reset any previous result
    resultCard.hidden = true;
    downloadWrap.hidden = true;
    progressWrap.hidden = true;
    if (resultObjectUrl) { URL.revokeObjectURL(resultObjectUrl); resultObjectUrl = null; }
    resultVideo.removeAttribute("src");

    dropPanel.hidden = true;
    editorPanel.hidden = false;
  }

  dropzone.addEventListener("click", () => fileInput.click());
  browseBtn.addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
  });

  ["dragenter", "dragover"].forEach(evt =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach(evt =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  resetBtn.addEventListener("click", () => {
    currentFile = null;
    fileInput.value = "";
    editorPanel.hidden = true;
    dropPanel.hidden = false;
  });

  // ---------- Speed UI ----------
  function updateSpeedUI(speedRaw) {
    const speed = Math.round(speedRaw * 100) / 100;
    speedValueEl.textContent = speed.toFixed(2);

    // Signature tape visual: segment gap + scale shrink as speed rises,
    // so the strip visibly "compresses" the faster it goes.
    const gap = Math.max(1, 10 - speed * 2.2);
    tapeTrack.style.gap = `${gap}px`;
    tapeTrack.querySelectorAll(".tape-seg").forEach((seg, i) => {
      const scaleY = Math.max(0.35, 1 - (speed - 1) * 0.18);
      seg.style.transform = `scaleY(${scaleY})`;
      seg.style.opacity = 0.5 + (i % 3) * 0.15;
    });

    speedPresets.querySelectorAll("button").forEach(btn => {
      btn.classList.toggle("active", Math.abs(parseFloat(btn.dataset.speed) - speed) < 0.001);
    });
  }

  speedSlider.addEventListener("input", () => updateSpeedUI(parseFloat(speedSlider.value)));
  speedPresets.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    speedSlider.value = btn.dataset.speed;
    updateSpeedUI(parseFloat(btn.dataset.speed));
  });
  updateSpeedUI(parseFloat(speedSlider.value));

  // ---------- ffmpeg.wasm setup ----------
  async function ensureFfmpegLoaded() {
    if (ffmpegReady) return;

    const { FFmpeg } = FFmpegWASM;
    const { toBlobURL } = FFmpegUtil;

    ffmpeg = new FFmpeg();

    ffmpeg.on("log", ({ message }) => {
      // Utile per debug in console, non mostrato all'utente.
      console.debug("[ffmpeg]", message);
    });

    ffmpeg.on("progress", ({ progress }) => {
      const pct = Math.min(100, Math.max(0, progress * 100));
      progressFill.style.width = `${pct}%`;
      progressLabel.textContent = `Elaborazione in corso… ${pct.toFixed(0)}%`;
    });

    setEngineStatus("busy", "Caricamento motore ffmpeg…");
    progressWrap.hidden = false;
    progressLabel.textContent = "Caricamento motore ffmpeg (una volta sola, ~30 MB)…";
    progressFill.style.width = "8%";

    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    });

    ffmpegReady = true;
    setEngineStatus("ready", "Motore pronto");
  }

  // Builds a chain of atempo filters, since a single atempo stage
  // only supports factors between 0.5 and 2.0. Chaining stages
  // reaches any overall speed while keeping natural-sounding pitch.
  function buildAtempoChain(speed) {
    const factors = [];
    let remaining = speed;

    if (remaining >= 0.5 && remaining <= 2.0) {
      factors.push(remaining);
    } else if (remaining > 2.0) {
      while (remaining > 2.0) {
        factors.push(2.0);
        remaining /= 2.0;
      }
      factors.push(remaining);
    } else {
      while (remaining < 0.5) {
        factors.push(0.5);
        remaining /= 0.5;
      }
      factors.push(remaining);
    }

    return factors.map(f => `atempo=${f.toFixed(6)}`).join(",");
  }

  // ---------- Processing ----------
  async function processVideo() {
    if (!currentFile) return;

    processBtn.disabled = true;
    processBtnLabel.textContent = "Elaborazione…";
    downloadWrap.hidden = true;
    resultCard.hidden = true;

    try {
      await ensureFfmpegLoaded();

      progressWrap.hidden = false;
      progressFill.style.width = "0%";
      progressLabel.textContent = "Lettura del file…";
      setEngineStatus("busy", "Elaborazione in corso…");

      const { fetchFile } = FFmpegUtil;
      const speed = parseFloat(speedSlider.value);
      const crf = qualitySelect.value;
      const inputName = "input_" + Date.now().toString(36) + guessExtension(currentFile);
      const outputName = "output.mp4";

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

      progressLabel.textContent = "Elaborazione in corso… 0%";
      await ffmpeg.exec(args);

      const data = await ffmpeg.readFile(outputName);
      const blob = new Blob([data.buffer], { type: "video/mp4" });

      if (resultObjectUrl) URL.revokeObjectURL(resultObjectUrl);
      resultObjectUrl = URL.createObjectURL(blob);

      resultVideo.src = resultObjectUrl;
      resultCard.hidden = false;

      downloadLink.href = resultObjectUrl;
      const baseName = currentFile.name.replace(/\.[^.]+$/, "");
      downloadLink.download = `${baseName}-${speed.toFixed(2)}x.mp4`;
      downloadMeta.textContent = `${humanSize(blob.size)} · ${speed.toFixed(2)}× · pronto per il download`;
      downloadWrap.hidden = false;

      progressLabel.textContent = "Completato.";
      progressFill.style.width = "100%";
      setEngineStatus("ready", "Motore pronto");

      // cleanup fs to free memory for next run
      try { await ffmpeg.deleteFile(inputName); await ffmpeg.deleteFile(outputName); } catch (_) {}

      setTimeout(() => { progressWrap.hidden = true; }, 1200);
    } catch (err) {
      console.error(err);
      setEngineStatus("error", "Errore durante l'elaborazione");
      progressLabel.textContent = "Si è verificato un errore. Riprova con un altro file o un'altra velocità.";
    } finally {
      processBtn.disabled = false;
      processBtnLabel.textContent = "Elabora video";
    }
  }

  function guessExtension(file) {
    const m = file.name.match(/\.[^.]+$/);
    return m ? m[0] : ".mp4";
  }

  processBtn.addEventListener("click", processVideo);
})();
