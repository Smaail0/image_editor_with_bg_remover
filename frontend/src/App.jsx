import { useState, useRef, useCallback, useEffect } from "react";

const API = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function base64ToBlob(b64, mime = "image/png") {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function dataUrlToBlob(dataUrl) {
  const [meta, payload] = dataUrl.split(",");
  const mime = meta.match(/data:(.*?);base64/)?.[1] || "image/png";
  return base64ToBlob(payload, mime);
}

// ── Job card states ───────────────────────────────────────────────────────────
// idle | processing | done | error

function useJobs() {
  const [jobs, setJobs] = useState([]);

  const addJobs = useCallback((files) => {
    const newJobs = Array.from(files).map((file) => ({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      size: file.size,
      state: "idle",
      outputUrl: null,
      error: null,
      manualCrop: null,
      keepMaskData: null,
      preview: URL.createObjectURL(file),
    }));
    setJobs((prev) => [...prev, ...newJobs]);
    return newJobs;
  }, []);

  const updateJob = useCallback((id, patch) => {
    setJobs((prev) =>
      prev.map((j) => {
        if (j.id !== id) return j;
        // Avoid leaking object URLs when live-updating results
        if (patch?.outputUrl && j.outputUrl && j.outputUrl !== patch.outputUrl) {
          URL.revokeObjectURL(j.outputUrl);
        }
        return { ...j, ...patch };
      })
    );
  }, []);

  const removeJob = useCallback((id) => {
    setJobs((prev) => {
      const j = prev.find((x) => x.id === id);
      if (j?.outputUrl) URL.revokeObjectURL(j.outputUrl);
      if (j?.preview) URL.revokeObjectURL(j.preview);
      return prev.filter((x) => x.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    setJobs((prev) => {
      prev.forEach((j) => {
        if (j.outputUrl) URL.revokeObjectURL(j.outputUrl);
        if (j.preview) URL.revokeObjectURL(j.preview);
      });
      return [];
    });
  }, []);

  return { jobs, addJobs, updateJob, removeJob, clearAll };
}

// ── Settings panel ────────────────────────────────────────────────────────────

function SliderControl({ label, value, displayValue, min, max, step, suffix = "", onChange }) {
  return (
    <label style={styles.sliderRow}>
      <span style={styles.settingLabel}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        style={styles.sliderInput}
      />
      <span style={styles.sliderValue}>
        {displayValue ?? value}
        {suffix}
      </span>
    </label>
  );
}

function SettingsPanel({ settings, onChange }) {
  const s = settings;
  return (
    <div style={{ ...styles.settingsGrid, gap: 14 }}>
      
      {/* Background Removal Toggle */}
      <label style={styles.settingRow}>
        <span style={{...styles.settingLabel, fontWeight: 500, flex: 1}}>Remove Background</span>
        <input
          type="checkbox"
          checked={s.removeBg}
          onChange={(e) => onChange({ removeBg: e.target.checked })}
          style={{ accentColor: "#000", width: 18, height: 18 }}
        />
      </label>
      <label style={{ ...styles.settingRow, opacity: s.removeBg ? 1 : 0.55 }}>
        <span style={styles.settingLabel}>Auto detect subject</span>
        <input
          type="checkbox"
          checked={s.autoSubject}
          disabled={!s.removeBg}
          onChange={(e) => onChange({ autoSubject: e.target.checked })}
          style={{ accentColor: "#000" }}
        />
      </label>

      {/* Show these only if AI removal is active */}
      {s.removeBg && (
        <div style={{ paddingLeft: 12, borderLeft: "2px solid #eee", display: "flex", flexDirection: "column", gap: 10 }}>
          <SliderControl label="Alpha threshold" value={s.alphaThreshold} min={100} max={250} step={1} onChange={(v) => onChange({ alphaThreshold: v })} />
          <SliderControl label="Fill holes" value={s.holeFill} min={0} max={6} step={1} onChange={(v) => onChange({ holeFill: v })} />
          <SliderControl label="Edge grow" value={s.grow} min={0} max={4} step={1} suffix="px" onChange={(v) => onChange({ grow: v })} />
          <SliderControl label="Edge blur" value={s.blur} displayValue={s.blur.toFixed(2)} min={0} max={2} step={0.05} onChange={(v) => onChange({ blur: v })} />
        </div>
      )}

      <hr style={{ border: 0, borderBottom: "1px solid #ebebeb", margin: "4px 0" }} />

      {/* Shape & Border Controls */}
      <label style={styles.settingRow}>
        <span style={styles.settingLabel}>Smart crop</span>
        <input type="checkbox" checked={s.crop} onChange={(e) => onChange({ crop: e.target.checked })} style={{ accentColor: "#000" }}/>
      </label>
      {s.crop && (
        <SliderControl label="Crop padding" value={s.cropPadding} min={0} max={80} step={1} suffix="px" onChange={(v) => onChange({ cropPadding: v })} />
      )}

      <SliderControl label="Corner radius" value={s.cornerRadius} min={0} max={150} step={1} suffix="px" onChange={(v) => onChange({ cornerRadius: v })} />
      
      <SliderControl label="Stroke width" value={s.strokeWidth} min={0} max={30} step={1} suffix="px" onChange={(v) => onChange({ strokeWidth: v })} />

      {s.strokeWidth > 0 && (
        <label style={styles.settingRow}>
          <span style={styles.settingLabel}>Stroke color</span>
          <input 
            type="color" 
            value={s.strokeColor} 
            onChange={(e) => onChange({ strokeColor: e.target.value })} 
            style={{ padding: 0, width: 32, height: 32, border: "none", cursor: "pointer", background: "transparent" }}
          />
        </label>
      )}
    </div>
  );
}

// ── Zoom/compare preview modal ────────────────────────────────────────────────

function PreviewModal({ job, onClose }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modalBox} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{job.name}</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              style={{ ...styles.pill, background: showOriginal ? "#111" : "transparent", color: showOriginal ? "#fff" : "inherit" }}
              onClick={() => setShowOriginal(true)}
            >Original</button>
            <button
              style={{ ...styles.pill, background: !showOriginal ? "#111" : "transparent", color: !showOriginal ? "#fff" : "inherit" }}
              onClick={() => setShowOriginal(false)}
            >Result</button>
            <button style={styles.closeBtn} onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Canvas */}
        <div style={styles.modalCanvas}>
          <div style={{ transform: `scale(${zoom})`, transformOrigin: "top center", transition: "transform 0.15s" }}>
            <img
              src={showOriginal ? job.preview : job.outputUrl}
              alt={job.name}
              style={{
                maxWidth: "100%",
                display: "block",
                background: showOriginal ? "#e8e8e8" : "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='10' height='10' fill='%23ccc'/%3E%3Crect x='10' y='10' width='10' height='10' fill='%23ccc'/%3E%3C/svg%3E\")",
              }}
            />
          </div>
        </div>

        {/* Zoom bar */}
        <div style={styles.modalFooter}>
          <input type="range" min={0.5} max={3} step={0.1} value={zoom} onChange={(e) => setZoom(+e.target.value)} style={{ width: 120 }} />
          <span style={{ fontSize: 12, color: "#888" }}>{Math.round(zoom * 100)}%</span>
          <button style={styles.pillPrimary} onClick={() => {
            const a = document.createElement("a");
            a.href = job.outputUrl;
            a.download = job.name.replace(/\.[^.]+$/, "") + "_nobg.png";
            a.click();
          }}>Download PNG</button>
        </div>
      </div>
    </div>
  );
}

// ── Job card ──────────────────────────────────────────────────────────────────

function JobCard({ job, onRemove, onPreview, removeBgEnabled }) {
  return (
    <div style={styles.jobCard} data-modern-card>
      {/* Thumbnail */}
      <div style={styles.jobThumb}>
        {job.outputUrl ? (
          <div style={{ position: "relative", width: "100%", height: "100%" }}>
            <img src={job.outputUrl} alt="" style={{ ...styles.thumbImg, background: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14'%3E%3Crect width='7' height='7' fill='%23ddd'/%3E%3Crect x='7' y='7' width='7' height='7' fill='%23ddd'/%3E%3C/svg%3E\")" }} />
          </div>
        ) : (
          <img src={job.preview} alt="" style={styles.thumbImg} />
        )}
        {job.state === "processing" && <div style={styles.thumbOverlay}><Spinner /></div>}
        {job.state === "error" && <div style={{ ...styles.thumbOverlay, background: "rgba(255,80,80,0.55)" }}>!</div>}
      </div>

      {/* Info */}
      <div style={styles.jobInfo}>
        <p style={styles.jobName}>{job.name}</p>
        <p style={styles.jobMeta}>{formatBytes(job.size)}</p>
        {job.error && <p style={styles.jobError}>{job.error}</p>}
        {job.state === "processing" && (
          <p style={styles.jobMeta}>
            {removeBgEnabled ? "Removing background…" : "Processing image…"}
          </p>
        )}
        {job.state === "done" && <p style={{ ...styles.jobMeta, color: "#22a05e" }}>Done</p>}
      </div>

      {/* Actions */}
      <div style={styles.jobActions}>
        {job.state === "done" && (
          <button style={styles.iconBtn} title="Preview & zoom" onClick={() => onPreview(job)}>⤢</button>
        )}
        {job.state === "done" && (
          <a
            href={job.outputUrl}
            download={job.name.replace(/\.[^.]+$/, "") + "_nobg.png"}
            style={{ ...styles.iconBtn, textDecoration: "none" }}
            title="Download"
          >↓</a>
        )}
        <button style={styles.iconBtn} title="Remove" onClick={() => onRemove(job.id)}>✕</button>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" style={{ animation: "spin 0.8s linear infinite" }}>
      <circle cx="10" cy="10" r="8" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2.5" />
      <path d="M10 2 A8 8 0 0 1 18 10" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      <style>{`@keyframes spin { to { transform: rotate(360deg); transform-origin: center; } }`}</style>
    </svg>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const { jobs, addJobs, updateJob, removeJob, clearAll } = useJobs();
const [settings, setSettings] = useState({
    removeBg: false, // Default turned off
    crop: true,      // Default on
    cropPadding: 10,
    autoSubject: true,
    alphaThreshold: 190,
    holeFill: 1,
    grow: 1,
    blur: 0.45,
    cornerRadius: 20,     // Default rounded corner
    strokeWidth: 4,       // Default white stroke
    strokeColor: "#ffffff"
  });

  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewJobId, setPreviewJobId] = useState(null);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [cropMode, setCropMode] = useState(false);
  const [cropDraft, setCropDraft] = useState(null);
  const [protectMode, setProtectMode] = useState(false);
  const [brushSize, setBrushSize] = useState(26);
  const fileInput = useRef();
  const liveControllers = useRef(new Map());
  const liveTimer = useRef(null);
  const jobsRef = useRef([]);
  const requestVersionRef = useRef(new Map());
  const panRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });
  const imageRef = useRef(null);
  const surfaceRef = useRef(null);
  const cropStartRef = useRef(null);
  const keepMaskCanvasRef = useRef(null);
  const keepMaskDrawingRef = useRef(false);

  const patchSettings = useCallback((patch) => setSettings((s) => ({ ...s, ...patch })), []);

  // ── Process a batch of new jobs ──────────────────────────────────────────
  const buildParams = useCallback((job) => {
    const params = new URLSearchParams({
      remove_bg: settings.removeBg,
      crop: settings.crop,
      crop_padding: settings.cropPadding,
      auto_subject: settings.autoSubject,
      alpha_threshold: settings.alphaThreshold,
      hole_fill: settings.holeFill,
      grow: settings.grow,
      blur: settings.blur,
      corner_radius: settings.cornerRadius,
      stroke_width: settings.strokeWidth,
      stroke_color: settings.strokeColor,
    });
    if (job?.manualCrop) {
      const { x, y, w, h } = job.manualCrop;
      params.set("manual_crop", `${x},${y},${w},${h}`);
    }
    return params;
  }, [settings]);

  const processOneJob = useCallback(
    async (job, { signal } = {}) => {
      const nextVersion = (requestVersionRef.current.get(job.id) || 0) + 1;
      requestVersionRef.current.set(job.id, nextVersion);
      const params = buildParams(job);
      updateJob(job.id, { state: "processing", error: null });
      const fd = new FormData();
      fd.append("file", job.file);
      if (job.keepMaskData) {
        fd.append("keep_mask", dataUrlToBlob(job.keepMaskData), "keep_mask.png");
      }
      try {
        const res = await fetch(`${API}/remove-bg?${params}`, { method: "POST", body: fd, signal });
        if (requestVersionRef.current.get(job.id) !== nextVersion) return;
        if (!res.ok) {
          const err = await res.json().catch(() => ({ detail: res.statusText }));
          throw new Error(err.detail || "Server error");
        }
        const blob = await res.blob();
        if (requestVersionRef.current.get(job.id) !== nextVersion) return;
        const url = URL.createObjectURL(blob);
        updateJob(job.id, { state: "done", outputUrl: url });
      } catch (e) {
        if (requestVersionRef.current.get(job.id) !== nextVersion) return;
        if (e?.name === "AbortError") return;
        const isNetworkError =
          e instanceof TypeError ||
          String(e?.message || "").toLowerCase().includes("failed to fetch");
        const message = isNetworkError
          ? `Cannot reach API at ${API}. Start backend (uvicorn main:app --reload --port 8000).`
          : e.message;
        updateJob(job.id, { state: "error", error: message });
      }
    },
    [buildParams, updateJob]
  );

  const processJobs = useCallback(
    async (newJobs) => {
      for (const job of newJobs) {
        await processOneJob(job);
      }
    },
    [processOneJob]
  );

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  // Live re-process the image currently open in the preview modal
  useEffect(() => {
    if (!previewJobId) return;
    const job = jobsRef.current.find((j) => j.id === previewJobId);
    if (!job) return;

    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => {
      const existing = liveControllers.current.get(previewJobId);
      if (existing) existing.abort();
      const controller = new AbortController();
      liveControllers.current.set(previewJobId, controller);
      processOneJob(job, { signal: controller.signal });
    }, 250);

    return () => {
      if (liveTimer.current) clearTimeout(liveTimer.current);
    };
  }, [previewJobId, processOneJob, settings]);

  // Cleanup: abort in-flight processing when closing modal or unmounting
  useEffect(() => {
    return () => {
      for (const controller of liveControllers.current.values()) controller.abort();
      liveControllers.current.clear();
    };
  }, []);

  const handleFiles = useCallback(
    (files) => {
      const validFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (!validFiles.length) return;
      const newJobs = addJobs(validFiles);
      processJobs(newJobs);
    },
    [addJobs, processJobs]
  );

  // Paste from clipboard
  useEffect(() => {
    const handler = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageItems = Array.from(items)
        .filter((it) => it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter(Boolean);
      if (imageItems.length) handleFiles(imageItems);
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [handleFiles]);

  // Download all done jobs
  const downloadAll = useCallback(() => {
    jobs.filter((j) => j.state === "done").forEach((j) => {
      const a = document.createElement("a");
      a.href = j.outputUrl;
      a.download = j.name.replace(/\.[^.]+$/, "") + "_nobg.png";
      a.click();
    });
  }, [jobs]);

  const doneCount = jobs.filter((j) => j.state === "done").length;
  const processingCount = jobs.filter((j) => j.state === "processing").length;

  const resetPreviewView = useCallback(() => {
    setPreviewZoom(1);
    setPreviewOffset({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((delta) => {
    setPreviewZoom((z) => Math.min(5, Math.max(0.25, +(z + delta).toFixed(2))));
  }, []);

  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  const paintKeepMask = useCallback((e) => {
    const canvas = keepMaskCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.beginPath();
    ctx.arc(x, y, brushSize, 0, Math.PI * 2);
    ctx.fill();
  }, [brushSize]);

  const syncKeepMaskToJob = useCallback((jobId) => {
    const canvas = keepMaskCanvasRef.current;
    if (!canvas) return;
    const data = canvas.toDataURL("image/png");
    updateJob(jobId, { keepMaskData: data });
  }, [updateJob]);

  useEffect(() => {
    if (!protectMode || !previewJobId) return;
    const job = jobs.find((j) => j.id === previewJobId);
    const canvas = keepMaskCanvasRef.current;
    const img = imageRef.current;
    if (!job || !canvas || !img) return;
    const w = img.naturalWidth || 1;
    const h = img.naturalHeight || 1;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    if (job.keepMaskData) {
      const maskImg = new Image();
      maskImg.onload = () => ctx.drawImage(maskImg, 0, 0, w, h);
      maskImg.src = job.keepMaskData;
    }
  }, [protectMode, previewJobId, jobs]);

  return (
    <div style={styles.root}>
      <style>{globalCss}</style>
      <div style={styles.ambientBg}>
        <div style={styles.blobA} />
        <div style={styles.blobB} />
      </div>

      {/* ── Header ── */}
      <header style={styles.header}>
        <div style={styles.logo}>
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <rect width="22" height="22" rx="6" fill="#111" />
            <path d="M7 15 L11 7 L15 15" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <circle cx="11" cy="15" r="1.5" fill="white" />
          </svg>
          <span style={styles.logoText}>Cutout</span>
        </div>
        <nav style={styles.headerNav}>
          {doneCount > 1 && (
            <button style={styles.navBtn} onClick={downloadAll}>
              Download all ({doneCount})
            </button>
          )}
          {jobs.length > 0 && (
            <button style={styles.navBtn} onClick={clearAll}>Clear</button>
          )}
          <button
            style={{ ...styles.navBtn, background: settingsOpen ? "#f0f0f0" : "transparent" }}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            Settings
          </button>
        </nav>
      </header>

      {/* ── Settings drawer ── */}
      {settingsOpen && (
        <div style={styles.settingsDrawer}>
          <SettingsPanel settings={settings} onChange={patchSettings} />
        </div>
      )}

      {/* ── Drop zone ── */}
      <main style={styles.main}>
        <div
          data-modern-card
          style={{ ...styles.dropZone, ...(dragging ? styles.dropZoneActive : {}) }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInput.current.click()}
        >
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => handleFiles(e.target.files)}
          />
          <div style={styles.dropIcon}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <rect x="3" y="3" width="22" height="22" rx="5" stroke="currentColor" strokeWidth="1.4" strokeDasharray="4 3" />
              <path d="M14 10v8M10 14l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p style={styles.dropTitle}>
            {dragging
              ? settings.removeBg
                ? "Drop to remove backgrounds"
                : "Drop to process images"
              : "Drop images here"}
          </p>
          <p style={styles.dropSub}>or click to browse · paste with Ctrl V · up to 20 images</p>
        </div>

        {/* ── Job list ── */}
        {jobs.length > 0 && (
          <section style={styles.jobList}>
            {processingCount > 0 && (
              <p style={styles.statusBar}>Processing {processingCount} image{processingCount !== 1 ? "s" : ""}…</p>
            )}
            {jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onRemove={removeJob}
                onPreview={(j) => {
                  setPreviewJobId(j.id);
                  setCropMode(false);
                  setProtectMode(false);
                  setCropDraft(null);
                  resetPreviewView();
                }}
                removeBgEnabled={settings.removeBg}
              />
            ))}
          </section>
        )}
      </main>

      {/* ── Preview modal ── */}
      {previewJobId && (() => {
        const job = jobs.find((j) => j.id === previewJobId);
        if (!job) return null;
        return (
          <div style={styles.modalOverlay} onClick={() => { setPreviewJobId(null); setCropMode(false); setProtectMode(false); setCropDraft(null); resetPreviewView(); }}>
            <div style={{ ...styles.modalBox, width: "min(96vw, 1400px)", maxWidth: "none", maxHeight: "94vh" }} onClick={(e) => e.stopPropagation()}>
              <div style={styles.modalHeader}>
                <span style={styles.modalTitle}>{job.name}</span>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    style={{ ...styles.pill, background: cropMode ? "#111" : "transparent", color: cropMode ? "#fff" : "inherit" }}
                    onClick={() => {
                      setCropMode((v) => !v);
                      setProtectMode(false);
                      setCropDraft(null);
                      resetPreviewView();
                    }}
                  >
                    Crop mode
                  </button>
                  <button
                    style={{ ...styles.pill, background: protectMode ? "#111" : "transparent", color: protectMode ? "#fff" : "inherit" }}
                    onClick={() => {
                      setProtectMode((v) => !v);
                      setCropMode(false);
                      resetPreviewView();
                    }}
                  >
                    Protect subject
                  </button>
                  <span style={styles.zoomLabel}>{Math.round(previewZoom * 100)}%</span>
                  <button style={styles.closeBtn} onClick={() => { setPreviewJobId(null); setCropMode(false); setProtectMode(false); setCropDraft(null); resetPreviewView(); }}>✕</button>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 390px", minHeight: 620 }}>
                <div
                  style={{ ...styles.modalCanvas, borderRight: "1px solid #ebebeb", cursor: cropMode || protectMode ? "crosshair" : (panning ? "grabbing" : "grab") }}
                  onWheel={(e) => {
                    if (cropMode || protectMode) return;
                    e.preventDefault();
                    zoomBy(e.deltaY > 0 ? -0.1 : 0.1);
                  }}
                  onMouseDown={(e) => {
                    if (cropMode || protectMode) return;
                    e.preventDefault();
                    panRef.current = {
                      active: true,
                      startX: e.clientX,
                      startY: e.clientY,
                      originX: previewOffset.x,
                      originY: previewOffset.y,
                    };
                    setPanning(true);
                  }}
                  onMouseMove={(e) => {
                    if (cropMode || protectMode) return;
                    if (!panRef.current.active) return;
                    const dx = e.clientX - panRef.current.startX;
                    const dy = e.clientY - panRef.current.startY;
                    setPreviewOffset({ x: panRef.current.originX + dx, y: panRef.current.originY + dy });
                  }}
                  onMouseUp={() => {
                    cropStartRef.current = null;
                    panRef.current.active = false;
                    setPanning(false);
                  }}
                  onMouseLeave={() => {
                    cropStartRef.current = null;
                    panRef.current.active = false;
                    setPanning(false);
                  }}
                >
                  {job.state === "processing" && (
                    <div style={{ ...styles.thumbOverlay, position: "absolute", inset: 0 }}>
                      <Spinner />
                    </div>
                  )}
                  <div ref={surfaceRef} style={{ position: "relative", display: "inline-block", maxWidth: "100%", maxHeight: "100%" }}>
                    <img
                      ref={imageRef}
                      src={job.outputUrl || job.preview}
                      alt={job.name}
                      onLoad={(e) => {
                        const canvas = keepMaskCanvasRef.current;
                        if (!canvas) return;
                        const img = e.currentTarget;
                        const w = img.naturalWidth || 1;
                        const h = img.naturalHeight || 1;
                        canvas.width = w;
                        canvas.height = h;
                        const ctx = canvas.getContext("2d");
                        ctx.clearRect(0, 0, w, h);
                        if (job.keepMaskData) {
                          const maskImg = new Image();
                          maskImg.onload = () => {
                            ctx.drawImage(maskImg, 0, 0, w, h);
                          };
                          maskImg.src = job.keepMaskData;
                        }
                      }}
                      style={{
                        maxWidth: "100%",
                        maxHeight: "100%",
                        display: "block",
                        transform: `translate(${previewOffset.x}px, ${previewOffset.y}px) scale(${previewZoom})`,
                        transformOrigin: "center center",
                        transition: panning ? "none" : "transform 0.12s ease-out",
                        background: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='10' height='10' fill='%23ccc'/%3E%3Crect x='10' y='10' width='10' height='10' fill='%23ccc'/%3E%3C/svg%3E\")",
                      }}
                    />
                    {protectMode && (
                      <canvas
                        ref={keepMaskCanvasRef}
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: "100%",
                          height: "100%",
                          transform: `translate(${previewOffset.x}px, ${previewOffset.y}px) scale(${previewZoom})`,
                          transformOrigin: "center center",
                          transition: panning ? "none" : "transform 0.12s ease-out",
                          pointerEvents: "auto",
                          opacity: 0.45,
                          mixBlendMode: "screen",
                          cursor: "crosshair",
                        }}
                        onMouseDown={(e) => {
                          keepMaskDrawingRef.current = true;
                          paintKeepMask(e);
                        }}
                        onMouseMove={(e) => {
                          if (!keepMaskDrawingRef.current) return;
                          paintKeepMask(e);
                        }}
                        onMouseUp={() => {
                          keepMaskDrawingRef.current = false;
                          syncKeepMaskToJob(job.id);
                        }}
                        onMouseLeave={() => {
                          keepMaskDrawingRef.current = false;
                        }}
                      />
                    )}
                    {cropMode && (
                      <div
                        style={{ position: "absolute", inset: 0, cursor: "crosshair" }}
                        onMouseDown={(e) => {
                          if (!cropMode) return;
                          e.preventDefault();
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          const x = clamp01((e.clientX - rect.left) / rect.width);
                          const y = clamp01((e.clientY - rect.top) / rect.height);
                          cropStartRef.current = { x, y };
                          setCropDraft({ x, y, w: 0, h: 0 });
                        }}
                        onMouseMove={(e) => {
                          if (!cropMode || !cropStartRef.current) return;
                          e.preventDefault();
                          const rect = e.currentTarget.getBoundingClientRect();
                          const x = clamp01((e.clientX - rect.left) / rect.width);
                          const y = clamp01((e.clientY - rect.top) / rect.height);
                          const sx = cropStartRef.current.x;
                          const sy = cropStartRef.current.y;
                          setCropDraft({
                            x: Math.min(sx, x),
                            y: Math.min(sy, y),
                            w: Math.abs(x - sx),
                            h: Math.abs(y - sy),
                          });
                        }}
                        onMouseUp={() => {
                          cropStartRef.current = null;
                        }}
                        onMouseLeave={() => {
                          cropStartRef.current = null;
                        }}
                      >
                      </div>
                    )}
                    {cropMode && (cropDraft || job.manualCrop) && (() => {
                      const activeCrop = cropDraft || job.manualCrop;
                      return (
                        <div
                          style={{
                            position: "absolute",
                            left: `${activeCrop.x * 100}%`,
                            top: `${activeCrop.y * 100}%`,
                            width: `${activeCrop.w * 100}%`,
                            height: `${activeCrop.h * 100}%`,
                            border: "2px solid #2f4cff",
                            background: "rgba(62, 110, 255, 0.2)",
                            boxShadow: "0 0 0 9999px rgba(0,0,0,0.2)",
                            pointerEvents: "none",
                          }}
                        />
                      );
                    })()}
                  </div>
                </div>
                <div style={{ padding: 16, overflow: "auto" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>Live settings</div>
                    <button style={styles.pill} onClick={resetPreviewView}>Reset view</button>
                  </div>
                  {cropMode && (
                    <div style={styles.cropHelp}>
                      Drag on the image to draw a crop rectangle.
                    </div>
                  )}
                  {protectMode && (
                    <div style={styles.cropHelp}>
                      Paint over areas that must stay. Then click "Apply protect mask".
                    </div>
                  )}
                  {protectMode && (
                    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 54px", gap: 8, alignItems: "center", marginBottom: 10 }}>
                      <span style={{ fontSize: 12, color: "#4b5563" }}>Brush size</span>
                      <input
                        type="range"
                        min={6}
                        max={80}
                        step={1}
                        value={brushSize}
                        onChange={(e) => setBrushSize(+e.target.value)}
                      />
                      <span style={{ fontSize: 12, color: "#4b5563", textAlign: "right" }}>{brushSize}</span>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                    <button
                      style={{ ...styles.pill, borderColor: "#cfd7ff", color: "#2f4cff" }}
                      onClick={() => {
                        if (!cropDraft || cropDraft.w < 0.01 || cropDraft.h < 0.01) return;
                        const active = liveControllers.current.get(job.id);
                        if (active) active.abort();
                        // Compose with existing crop so repeated crops are cumulative.
                        const base = job.manualCrop || { x: 0, y: 0, w: 1, h: 1 };
                        const nextCrop = {
                          x: +(base.x + cropDraft.x * base.w).toFixed(4),
                          y: +(base.y + cropDraft.y * base.h).toFixed(4),
                          w: +(base.w * cropDraft.w).toFixed(4),
                          h: +(base.h * cropDraft.h).toFixed(4),
                        };
                        updateJob(job.id, { manualCrop: nextCrop });
                        processOneJob({ ...job, manualCrop: nextCrop });
                        setCropDraft(null);
                        setCropMode(false);
                      }}
                    >
                      Apply crop
                    </button>
                    <button
                      style={styles.pill}
                      onClick={() => {
                        updateJob(job.id, { manualCrop: null });
                        processOneJob({ ...job, manualCrop: null });
                        setCropDraft(null);
                      }}
                    >
                      Clear crop
                    </button>
                  </div>
                  {protectMode && (
                    <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                      <button
                        style={{ ...styles.pill, borderColor: "#cfd7ff", color: "#2f4cff" }}
                        onClick={() => {
                          const canvas = keepMaskCanvasRef.current;
                          if (!canvas) return;
                          const data = canvas.toDataURL("image/png");
                          const nextJob = { ...job, keepMaskData: data };
                          updateJob(job.id, { keepMaskData: data });
                          processOneJob(nextJob);
                          setProtectMode(false);
                        }}
                      >
                        Apply protect mask
                      </button>
                      <button
                        style={styles.pill}
                        onClick={() => {
                          const canvas = keepMaskCanvasRef.current;
                          if (canvas) {
                            const ctx = canvas.getContext("2d");
                            ctx.clearRect(0, 0, canvas.width, canvas.height);
                          }
                          updateJob(job.id, { keepMaskData: null });
                          processOneJob({ ...job, keepMaskData: null });
                        }}
                      >
                        Clear protect mask
                      </button>
                    </div>
                  )}
                  <SettingsPanel settings={settings} onChange={patchSettings} />
                  {job.error && <p style={{ ...styles.jobError, marginTop: 10 }}>{job.error}</p>}
                </div>
              </div>

              <div style={styles.modalFooter}>
                <button
                  style={styles.pillPrimary}
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = job.outputUrl || job.preview;
                    a.download = job.name.replace(/\.[^.]+$/, "") + "_processed.png";
                    a.click();
                  }}
                >
                  Download PNG
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const globalCss = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Inter, -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif;
    background: radial-gradient(1200px 700px at 0% 0%, #eef2ff 0%, #f7f9ff 40%, #f7f7fb 100%);
    color: #111;
  }
  button { cursor: pointer; font: inherit; border: none; background: none; }
  a { color: inherit; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @keyframes floatA { 0%,100% { transform: translate3d(0,0,0); } 50% { transform: translate3d(30px,-20px,0); } }
  @keyframes floatB { 0%,100% { transform: translate3d(0,0,0); } 50% { transform: translate3d(-25px,20px,0); } }
  @keyframes gradientShift { 0% { background-position: 0% 50%; } 100% { background-position: 100% 50%; } }
  [data-modern-card] {
    transition: transform 0.18s ease, box-shadow 0.22s ease, border-color 0.22s ease;
  }
  [data-modern-card]:hover {
    transform: translateY(-1px);
    box-shadow: 0 14px 32px rgba(16, 24, 40, 0.09);
    border-color: rgba(130, 110, 255, 0.35);
  }
`;

const styles = {
  root: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    position: "relative",
    isolation: "isolate",
  },
  ambientBg: {
    position: "fixed",
    inset: 0,
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: -1,
  },
  blobA: {
    position: "absolute",
    width: 460,
    height: 460,
    left: -130,
    top: -120,
    borderRadius: "50%",
    background: "radial-gradient(circle at 30% 30%, rgba(120,92,255,0.35), rgba(120,92,255,0) 65%)",
    filter: "blur(8px)",
    animation: "floatA 14s ease-in-out infinite",
  },
  blobB: {
    position: "absolute",
    width: 420,
    height: 420,
    right: -100,
    top: 140,
    borderRadius: "50%",
    background: "radial-gradient(circle at 30% 30%, rgba(0,201,255,0.28), rgba(0,201,255,0) 68%)",
    filter: "blur(8px)",
    animation: "floatB 16s ease-in-out infinite",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 24px",
    height: 52,
    borderBottom: "1px solid rgba(255,255,255,0.55)",
    background: "rgba(255,255,255,0.65)",
    backdropFilter: "blur(10px)",
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  logo: { display: "flex", alignItems: "center", gap: 9 },
  logoText: { fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" },
  headerNav: { display: "flex", gap: 6, alignItems: "center" },
  navBtn: {
    fontSize: 13,
    fontWeight: 500,
    padding: "5px 12px",
    borderRadius: 7,
    border: "1px solid rgba(154, 163, 184, 0.35)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.9), rgba(255,255,255,0.6))",
    color: "#1d2433",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
  },
  settingsDrawer: {
    borderBottom: "1px solid rgba(226,232,240,0.8)",
    background: "rgba(255,255,255,0.72)",
    backdropFilter: "blur(8px)",
    padding: "14px 24px",
    animation: "fadeUp 0.15s ease",
  },
  settingsGrid: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    maxWidth: 520,
  },
  settingRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    cursor: "pointer",
  },
  sliderRow: {
    display: "grid",
    gridTemplateColumns: "170px 1fr 64px",
    alignItems: "center",
    gap: 10,
  },
  sliderInput: {
    width: "100%",
    accentColor: "#111",
  },
  sliderValue: {
    fontSize: 12,
    color: "#666",
    fontVariantNumeric: "tabular-nums",
    textAlign: "right",
  },
  settingLabel: {
    fontSize: 13,
    color: "#444",
    minWidth: 170,
    display: "flex",
    gap: 6,
    alignItems: "center",
  },
  settingHint: {
    fontStyle: "normal",
    color: "#999",
    fontWeight: 400,
    fontSize: 12,
  },
  main: {
    flex: 1,
    padding: "32px 24px",
    maxWidth: 820,
    margin: "0 auto",
    width: "100%",
  },
  dropZone: {
    border: "1.5px dashed rgba(123, 127, 255, 0.4)",
    borderRadius: 18,
    padding: "40px 24px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    background: "linear-gradient(140deg, rgba(255,255,255,0.94), rgba(246,248,255,0.9))",
    boxShadow: "0 14px 30px rgba(17, 24, 39, 0.06)",
    transition: "border-color 0.18s, background 0.18s, transform 0.18s",
    userSelect: "none",
  },
  dropZoneActive: {
    borderColor: "#615fff",
    background: "linear-gradient(140deg, rgba(243,246,255,0.95), rgba(238,244,255,0.95))",
    transform: "translateY(-1px)",
  },
  dropIcon: { color: "#999", marginBottom: 4 },
  dropTitle: { fontSize: 15, fontWeight: 500, color: "#111" },
  dropSub: { fontSize: 13, color: "#999" },
  jobList: {
    marginTop: 24,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  statusBar: {
    fontSize: 13,
    color: "#888",
    marginBottom: 4,
  },
  jobCard: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "10px 14px",
    background: "linear-gradient(180deg, rgba(255,255,255,0.96), rgba(248,250,255,0.92))",
    border: "1px solid rgba(199, 210, 254, 0.35)",
    borderRadius: 14,
    animation: "fadeUp 0.18s ease",
    boxShadow: "0 8px 24px rgba(17, 24, 39, 0.05)",
  },
  jobThumb: {
    width: 54,
    height: 54,
    borderRadius: 8,
    overflow: "hidden",
    flexShrink: 0,
    position: "relative",
    background: "#f0f0f0",
  },
  thumbImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  thumbOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.35)",
    color: "white",
    fontSize: 13,
    fontWeight: 600,
  },
  jobInfo: { flex: 1, minWidth: 0 },
  jobName: {
    fontSize: 13,
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  jobMeta: { fontSize: 12, color: "#999", marginTop: 2 },
  jobError: { fontSize: 12, color: "#d03030", marginTop: 2 },
  jobActions: { display: "flex", gap: 4, flexShrink: 0 },
  iconBtn: {
    width: 30,
    height: 30,
    borderRadius: 7,
    border: "1px solid #e8e8e8",
    background: "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
    color: "#555",
    cursor: "pointer",
    transition: "background 0.1s",
    textAlign: "center",
    lineHeight: "30px",
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(17,24,39,0.45)",
    backdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
    padding: 20,
  },
  modalBox: {
    background: "linear-gradient(180deg, rgba(255,255,255,0.98), rgba(250,251,255,0.98))",
    borderRadius: 20,
    width: "100%",
    maxWidth: 680,
    maxHeight: "90vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    border: "1px solid rgba(199,210,254,0.42)",
    boxShadow: "0 28px 65px rgba(15, 23, 42, 0.28)",
  },
  modalHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 18px",
    borderBottom: "1px solid #ebebeb",
    flexShrink: 0,
  },
  modalTitle: { fontSize: 14, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "50%" },
  zoomLabel: {
    fontSize: 12,
    color: "#666",
    minWidth: 42,
    textAlign: "center",
    fontVariantNumeric: "tabular-nums",
  },
  cropHelp: {
    fontSize: 12,
    color: "#4b5a7a",
    background: "#eef2ff",
    border: "1px solid #d6dfff",
    borderRadius: 8,
    padding: "8px 10px",
    marginBottom: 10,
  },
  modalCanvas: {
    flex: 1,
    overflow: "auto",
    padding: 20,
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
  },
  modalFooter: {
    borderTop: "1px solid #ebebeb",
    padding: "12px 18px",
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexShrink: 0,
  },
  pill: {
    fontSize: 12,
    fontWeight: 500,
    padding: "4px 11px",
    borderRadius: 20,
    border: "1px solid #ddd",
    background: "#fff",
    color: "#1f1f1f",
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    cursor: "pointer",
    transition: "background 0.1s, color 0.1s",
  },
  pillPrimary: {
    fontSize: 12,
    fontWeight: 500,
    padding: "6px 14px",
    borderRadius: 20,
    border: "none",
    background: "linear-gradient(90deg, #5b5dfd 0%, #7b4dff 50%, #3f8cff 100%)",
    backgroundSize: "200% 200%",
    animation: "gradientShift 4s linear infinite alternate",
    color: "#fff",
    cursor: "pointer",
    marginLeft: "auto",
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: "50%",
    border: "1px solid #e0e0e0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 12,
    cursor: "pointer",
    color: "#555",
  },
};
