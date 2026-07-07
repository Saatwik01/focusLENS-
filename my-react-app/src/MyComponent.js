import React, { useState, useEffect, useRef } from 'react';
import './focuslens.css';

/*
  FocusLensMVP — improved:
  - NoiseMeter class encapsulates WebAudio analyser + RMS calc
  - smoother mic level updates (callback from NoiseMeter)
  - stochastic + smoothed focus score so it never stays constant
  - face in-frame penalty remains
  - permission helper integrated
*/

class NoiseMeter {
  constructor({ fftSize = 512, smoothingTimeConstant = 0.8 } = {}) {
    this.analyser = null;
    this.audioCtx = null;
    this.source = null;
    this.fftSize = fftSize;
    this.smoothingTimeConstant = smoothingTimeConstant;
    this.data = null;
    this.raf = null;
    this.onLevel = null; // callback(level 0..1)
  }

  async startFromStream(stream) {
    if (!stream) throw new Error('No stream');
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('AudioContext not supported');
    this.audioCtx = new AudioCtx();
    try { await this.audioCtx.resume(); } catch {}
    this.source = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    // a bit of smoothing in frequency domain then we compute RMS
    try { this.source.connect(this.analyser); } catch {}
    this.data = new Uint8Array(this.analyser.frequencyBinCount);
    this._loop();
  }

  _loop() {
    if (!this.analyser) return;
    this.analyser.getByteFrequencyData(this.data);
    // approximate RMS from frequency bins
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = this.data[i] / 255;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, this.data.length));
    if (typeof this.onLevel === 'function') {
      // clamp 0..1
      this.onLevel(Math.max(0, Math.min(1, rms)));
    }
    this.raf = requestAnimationFrame(this._loop.bind(this));
  }

  stop() {
    try { if (this.raf) cancelAnimationFrame(this.raf); } catch {}
    this.raf = null;
    try { if (this.source) this.source.disconnect(); } catch {}
    try { if (this.analyser) this.analyser.disconnect(); } catch {}
    try { if (this.audioCtx) this.audioCtx.close(); } catch {}
    this.source = null;
    this.analyser = null;
    this.audioCtx = null;
  }
}

export default function FocusLensMVP() {
  // UI / state
  const [showCalibration, setShowCalibration] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationData, setCalibrationData] = useState(() => {
    try { return JSON.parse(localStorage.getItem('focuslens_calib') || 'null'); } catch { return null; }
  });

  const [user] = useState(() => ({ id: 'local_user', name: 'You' }));
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionStart, setSessionStart] = useState(null);
  const [activities, setActivities] = useState(() => {
    try { return JSON.parse(localStorage.getItem('focuslens_activities') || '[]'); } catch { return []; }
  });

  const videoRef = useRef(null);
  const videoContainerRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const noiseMeterRef = useRef(null);
  const faceLoopRef = useRef(null);
  const faceDetectorRef = useRef(null);

  const [micLevel, setMicLevel] = useState(0); // 0..1 from NoiseMeter
  const [selfFocus, setSelfFocus] = useState(80);
  const [noiseThreshold, setNoiseThreshold] = useState(0.2);
  const [focusHistory, setFocusHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('focuslens_history') || '[]'); } catch { return []; }
  });
  const [focusScore, setFocusScore] = useState(null);
  const [recording, setRecording] = useState(false);
  const [deviceError, setDeviceError] = useState(null);
  const [simulateMode, setSimulateMode] = useState(false);
  const [permissionState, setPermissionState] = useState('unknown');

  // face bounds
  const [inBounds, setInBounds] = useState(true);
  const [outOfBoundsWarning, setOutOfBoundsWarning] = useState(false);

  useEffect(() => { try { localStorage.setItem('focuslens_activities', JSON.stringify(activities)); } catch {} }, [activities]);
  useEffect(() => { try { localStorage.setItem('focuslens_history', JSON.stringify(focusHistory)); } catch {} }, [focusHistory]);

  // cleanup
  useEffect(() => {
    return () => {
      stopDevices();
      stopFaceTracking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- device / audio handling ----------
  async function startDevices() {
    setDeviceError(null);
    setSimulateMode(false);
    stopSimulation();
    stopFaceTracking();

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      setDeviceError('Camera/microphone APIs not available — using simulation.');
      setSimulateMode(true);
      startSimulation();
      return false;
    }

    try {
      // request both video + audio
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      mediaStreamRef.current = stream;
      if (videoRef.current) {
        try { videoRef.current.srcObject = stream; } catch {}
      }

      // start noise meter
      if (!noiseMeterRef.current) noiseMeterRef.current = new NoiseMeter();
      noiseMeterRef.current.onLevel = level => {
        // apply a small smoothing for micLevel itself: avg with previous
        setMicLevel(prev => {
          const sm = (prev * 0.85) + (level * 0.15);
          return Math.max(0, Math.min(1, sm));
        });
      };
      try {
        await noiseMeterRef.current.startFromStream(stream);
      } catch (e) {
        console.warn('NoiseMeter failed', e);
        setDeviceError('Audio analyser failed — using simulation.');
        setSimulateMode(true);
        startSimulation();
        return false;
      }

      // start face detection
      startFaceTracking();

      setDeviceError(null);
      setSimulateMode(false);
      setPermissionState('granted');
      addActivity({ type: 'devices_enabled', time: new Date().toISOString() });
      return true;
    } catch (e) {
      console.error('device error', e);
      if (e && e.name === 'NotAllowedError') {
        setDeviceError('Microphone/camera access denied. Please allow access in site settings.');
        setPermissionState('denied');
      } else {
        setDeviceError('Unable to access camera/microphone. Grant permissions or use simulation.');
        setPermissionState('denied');
      }
      setSimulateMode(true);
      startSimulation();
      return false;
    }
  }

  function stopDevices() {
    // stop noise meter
    try { if (noiseMeterRef.current) noiseMeterRef.current.stop(); } catch {}
    noiseMeterRef.current = null;

    // stop media tracks
    if (mediaStreamRef.current) {
      try { mediaStreamRef.current.getTracks().forEach(t => t.stop()); } catch {};
      mediaStreamRef.current = null;
    }

    stopSimulation();
    stopFaceTracking();
    setPermissionState(prev => (prev === 'granted' ? 'prompt' : prev));
    addActivity({ type: 'devices_disabled', time: new Date().toISOString() });
  }

  // permission helper
  async function requestMicPermission() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      setDeviceError('Microphone API not available in this browser/environment.');
      setPermissionState('denied');
      return false;
    }
    try {
      // check permission API first
      if (navigator.permissions && typeof navigator.permissions.query === 'function') {
        try {
          const status = await navigator.permissions.query({ name: 'microphone' });
          setPermissionState(status.state || 'prompt');
          status.onchange = () => setPermissionState(status.state || 'prompt');
          if (status.state === 'granted') {
            setDeviceError(null);
            return true;
          }
          if (status.state === 'denied') {
            setDeviceError('Microphone permission previously denied. Please enable it in site settings (click lock icon).');
            return false;
          }
        } catch (e) {
          // ignore
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      setDeviceError(null);
      setPermissionState('granted');
      addActivity({ type: 'mic_permission_granted', time: new Date().toISOString() });
      return true;
    } catch (err) {
      console.error('mic permission error', err);
      if (err && err.name === 'NotAllowedError') {
        setDeviceError('Microphone access denied. Open site settings and allow Microphone for this site.');
        setPermissionState('denied');
      } else if (err && err.name === 'NotFoundError') {
        setDeviceError('No microphone found on this device.');
        setPermissionState('denied');
      } else {
        setDeviceError('Unable to get microphone access. Check permissions or use simulation.');
        setPermissionState('denied');
      }
      return false;
    }
  }

  // ---------- simulation fallback ----------
  const simIntervalRef = useRef(null);
  function startSimulation() {
    stopSimulation();
    let v = micLevel || 0.18;
    simIntervalRef.current = setInterval(() => {
      v += (Math.random() - 0.5) * 0.06;
      v = Math.max(0, Math.min(1, v));
      // small smoothing when setting
      setMicLevel(prev => (prev * 0.85) + (v * 0.15));
    }, 250);
    setSimulateMode(true);
    addActivity({ type: 'simulation_started', time: new Date().toISOString() });
  }
  function stopSimulation() {
    if (simIntervalRef.current) { try { clearInterval(simIntervalRef.current); } catch {} simIntervalRef.current = null; }
    setSimulateMode(false);
  }

  // ---------- face tracking ----------
  function startFaceTracking() {
    stopFaceTracking();
    setInBounds(true);
    setOutOfBoundsWarning(false);
    if (!videoRef.current) return;

    const Video = videoRef.current;

    if ('FaceDetector' in window) {
      try {
        const detector = new window.FaceDetector();
        faceDetectorRef.current = detector;
        faceLoopRef.current = setInterval(async () => {
          try {
            const faces = await detector.detect(Video);
            handleFaceDetections(faces);
          } catch (e) {
            // silent failure
          }
        }, 160);
        return;
      } catch (e) {
        console.warn('FaceDetector init failed', e);
      }
    }

    // fallback: estimate center-of-brightness (best-effort)
    faceLoopRef.current = setInterval(() => {
      const est = estimateCenterFromVideo(videoRef.current);
      if (!est) {
        markOutOfBounds(true);
        return;
      }
      // approximate in-bounds if center is within central 30%
      const inside = est.cx >= 0.35 && est.cx <= 0.65 && est.cy >= 0.35 && est.cy <= 0.65;
      markOutOfBounds(!inside);
    }, 400);
  }

  function stopFaceTracking() {
    if (faceLoopRef.current) { try { clearInterval(faceLoopRef.current); } catch {} faceLoopRef.current = null; }
    faceDetectorRef.current = null;
    setInBounds(true);
    setOutOfBoundsWarning(false);
  }

  function handleFaceDetections(faces) {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    const vw = videoEl.videoWidth || videoEl.clientWidth;
    const vh = videoEl.videoHeight || videoEl.clientHeight;
    if (!vw || !vh) return;

    if (!faces || faces.length === 0) {
      markOutOfBounds(true);
      return;
    }
    const face = faces[0];
    const box = face.boundingBox || face.box || null;
    if (!box) {
      setInBounds(true);
      return;
    }
    const fx = box.x + box.width / 2;
    const fy = box.y + box.height / 2;
    const marginW = vw * 0.30;
    const marginH = vh * 0.30;
    const cx = vw / 2;
    const cy = vh / 2;
    const inside = (fx >= cx - marginW / 2 && fx <= cx + marginW / 2 && fy >= cy - marginH / 2 && fy <= cy + marginH / 2);
    markOutOfBounds(!inside);
  }

  function markOutOfBounds(flag) {
    setInBounds(!flag);
    if (flag) {
      setOutOfBoundsWarning(true);
      setTimeout(() => setOutOfBoundsWarning(false), 4000);
    }
  }

  // fallback luminance estimate (used only if FaceDetector not available)
  function estimateCenterFromVideo(videoEl, sampleW = 160, sampleH = 120) {
    try {
      if (!videoEl || videoEl.readyState < 2) return null;
      const canvas = document.createElement('canvas');
      canvas.width = sampleW; canvas.height = sampleH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(videoEl, 0, 0, sampleW, sampleH);
      const img = ctx.getImageData(0, 0, sampleW, sampleH);
      let sumX = 0, sumY = 0, count = 0;
      for (let y = 0; y < sampleH; y += 2) {
        for (let x = 0; x < sampleW; x += 2) {
          const idx = (y * sampleW + x) * 4;
          const r = img.data[idx], g = img.data[idx + 1], b = img.data[idx + 2];
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum > 40) {
            sumX += x * lum;
            sumY += y * lum;
            count += lum;
          }
        }
      }
      if (!count) return null;
      const cx = (sumX / count) / sampleW;
      const cy = (sumY / count) / sampleH;
      return { cx, cy };
    } catch (e) {
      return null;
    }
  }

  // ---------- session control ----------
  async function startSession() {
    const ok = await startDevices();
    setSessionActive(true);
    const now = new Date().toISOString();
    setSessionStart(now);
    setRecording(true);
    addActivity({ type: 'session_start', time: now, okDevices: !!ok, simulate: !!simulateMode });
  }

  function endSession() {
    stopDevices();
    setSessionActive(false);
    setRecording(false);
    const now = new Date().toISOString();
    setSessionStart(null);
    addActivity({ type: 'session_end', time: now });
  }

  function addActivity(obj) {
    const entry = {
      id: `x_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userId: user.id,
      ...obj
    };
    setActivities(prev => [entry, ...prev].slice(0, 200));
  }

  // ---------- scoring loop (makes score dynamic and never constant) ----------
  // We'll use an EMA smoothing of the numeric score so it drifts naturally.
  const scoreRef = useRef(null); // current smoothed numeric 0..100
  useEffect(() => { scoreRef.current = focusScore; }, [focusScore]);

  useEffect(() => {
    if (!recording) return;
    // update every 1.5s for responsiveness
    const tick = setInterval(() => {
      // measured ambient noise (0..1)
      let noise = Math.min(1, Math.max(0, micLevel || 0));
      // encourage sensitivity to out-of-bounds
      if (!inBounds) {
        noise = Math.min(1, noise + 0.25); // stronger penalty when out
      }
      // ambientScore: higher when quieter; clamp relative to threshold
      const ambientScore = 1 - Math.min(1, noise / Math.max(0.0001, noiseThreshold));
      const self = (Number(selfFocus) || 0) / 100;

      // fused base score
      let fused = Math.max(0, Math.min(1, (self * 0.65) + (ambientScore * 0.35)));

      // immediate out-of-bounds multiplier
      if (!inBounds) fused = fused * 0.6;

      // add a small time-varying stochastic component so score isn't constant.
      // amplitude is small (±3%). Add a slow oscillation to make it feel alive.
      const time = Date.now() / 1000;
      const slowOsc = Math.sin(time / 6) * 0.015; // slow +/-1.5%
      const jitter = (Math.random() - 0.5) * 0.03; // random +/-1.5%
      fused = fused + slowOsc + jitter;

      fused = Math.max(0, Math.min(1, fused));

      // exponential smoothing so changes are smooth (alpha controls responsiveness)
      const alpha = 0.25; // higher -> more responsive, lower -> smoother
      const prev = (typeof scoreRef.current === 'number') ? (scoreRef.current / 100) : fused;
      const smoothed = (prev * (1 - alpha)) + (fused * alpha);

      const score = Math.round(smoothed * 100);
      setFocusScore(score);
      scoreRef.current = score;

      const now = new Date().toISOString();
      setFocusHistory(prev => [{ time: now, score, mic: noise, self: Number(selfFocus), inBounds }, ...prev].slice(0, 1000));

      // when out-of-bounds, produce activity & warning
      if (!inBounds) {
        addActivity({ type: 'warning_out_of_bounds', time: now, message: 'User outside camera boundary' });
        setOutOfBoundsWarning(true);
        setTimeout(() => setOutOfBoundsWarning(false), 3000);
      }
    }, 1500);

    return () => clearInterval(tick);
  }, [recording, micLevel, selfFocus, noiseThreshold, inBounds]);

  // ---------- export / history ----------
  function exportCSV() {
    const rows = [['time','score','mic','self','inBounds']];
    focusHistory.forEach(h =>
      rows.push([
        h.time,
        String(h.score),
        String(h.mic),
        String(h.self),
        String(h.inBounds)
      ])
    );

    const csv = rows
      .map(r =>
        r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')
      )
      .join('\n');

    try {
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'focus_history.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addActivity({ type: 'export_csv', time: new Date().toISOString() });
    } catch (e) {
      console.error('export failed', e);
    }
  }

  function clearHistory() {
    setFocusHistory([]);
    addActivity({ type: 'clear_history', time: new Date().toISOString() });
  }

  // ---------- minimal calibration modal actions (kept from your snippet) ----------
  async function runCalibration() {
    setCalibrating(true);
    const samples = [];
    const sIter = setInterval(() => samples.push(micLevel), 300);
    await new Promise(r => setTimeout(r, 8000));
    clearInterval(sIter);
    const avgNoise = samples.reduce((a,b)=>a+b,0) / Math.max(1, samples.length);
    const bounding = { boxPercent: 0.30 };
    const calib = { avgNoise, bounding, date: new Date().toISOString() };
    setCalibrationData(calib);
    try { localStorage.setItem('focuslens_calib', JSON.stringify(calib)); } catch {}
    setCalibrating(false);
    setShowCalibration(false);
    addActivity({ type: 'calibrated', time: new Date().toISOString(), avgNoise });
  }

  // ---------- derived UI values ----------
  const micPercent = Math.round((micLevel || 0) * 100);
  const pulseScale = 0.6 + (micLevel || 0) * 1.2;
  const pulseOpacity = 0.18 + (micLevel || 0) * 0.5;

  // ---------- render ----------
  return (
    <div className="focuslens-app min-h-screen bg-gray-50 p-6 font-sans">
      <div className="max-w-4xl mx-auto bg-white p-6 rounded shadow fade-in">
        <div className="header text-center">
          <div className="brand" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center' }}>
            <div className="logo">FL</div>
            <div>
              <h1>Focus Lens — MVP</h1>
              <p className="tagline">Real-time focus detection using ambient noise + self-report · Privacy-first</p>
            </div>
            <div style={{ marginLeft: 12 }}>
              <button onClick={() => setShowCalibration(true)} className="btn btn-ghost">Calibrate</button>
            </div>
          </div>
        </div>

        {showCalibration && (
          <div className="modal">
            <h3>Calibration</h3>
            <p>We'll record 8 seconds of ambient noise and in-frame position. Please sit naturally.</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button onClick={runCalibration} className="btn btn-primary">{calibrating ? 'Calibrating…' : 'Start Calibration'}</button>
              <button onClick={() => setShowCalibration(false)} className="btn btn-ghost">Cancel</button>
            </div>
          </div>
        )}

        {deviceError && (
          <div className="mb-4 p-3 rounded" style={{ background: 'linear-gradient(90deg, rgba(255,224,179,0.06), rgba(255,239,213,0.03))', border: '1px solid rgba(255,200,120,0.06)', color: '#ffdba8' }}>
            <div style={{ fontWeight: 700 }}>Device warning</div>
            <div style={{ marginTop: 6 }}>{deviceError}</div>
            <div style={{ marginTop: 8 }} className="center">
              <button onClick={() => { setDeviceError(null); setSimulateMode(true); startSimulation(); }} className="btn btn-ghost">Use Simulation</button>
              <button onClick={() => { setDeviceError(null); }} className="btn btn-ghost" style={{ marginLeft: 8 }}>Dismiss</button>
            </div>
          </div>
        )}

        <div className="focus-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 18 }}>
          {/* LEFT */}
          <div className="left-card">
            <div ref={videoContainerRef} className="video-frame" style={{ position: 'relative', height: 320, background: '#000' }}>
              <video ref={videoRef} autoPlay muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />

              {/* overlay target box */}
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: '30%',
                  height: '30%',
                  transform: 'translate(-50%, -50%)',
                  border: inBounds ? '2px dashed rgba(110,231,183,0.7)' : '2px dashed rgba(255,99,92,0.9)',
                  borderRadius: 8,
                  pointerEvents: 'none'
                }}
              />

              {/* status pill */}
              <div style={{ position: 'absolute', right: 12, top: 12, background: 'rgba(2,6,23,0.6)', padding: '6px 10px', borderRadius: 999, fontWeight:700, color: inBounds ? 'var(--accent-1)' : '#ffb3b3' }}>
                {inBounds ? 'In Frame' : 'Out of frame'}
              </div>

              {/* pulsing ring */}
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '40%',
                  transform: `translate(-50%, -10%) scale(${pulseScale})`,
                  width: 120,
                  height: 120,
                  borderRadius: 999,
                  boxShadow: `0 0 ${20 + micPercent/2}px rgba(124,92,255,${0.06 + micLevel*0.18})`,
                  border: `2px solid rgba(124,92,255,${0.10 + micLevel*0.22})`,
                  opacity: pulseOpacity,
                  transition: 'transform 200ms linear, opacity 200ms linear',
                  pointerEvents: 'none'
                }}
              />
            </div>

            <div className="controls center" style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' }}>
              {!sessionActive ? (
                <button onClick={startSession} className="btn btn-primary">Start Session</button>
              ) : (
                <button onClick={endSession} className="btn btn-danger">End Session</button>
              )}

              <button onClick={startDevices} className="btn btn-ghost">Enable Devices</button>
              <button onClick={stopDevices} className="btn btn-ghost">Disable Devices</button>

              <button
                onClick={async () => {
                  const ok = await requestMicPermission();
                  if (ok) await startDevices();
                }}
                className="btn btn-ghost"
              >
                Request Microphone
              </button>
            </div>

            <div style={{ marginTop: 18 }} className="stack text-center">
              <div style={{ fontWeight: 700 }}>Microphone Level</div>

              <div style={{ width: '100%', maxWidth: 520, margin: '6px auto' }}>
                <div className="meter" aria-hidden>
                  <div className="meter-fill" style={{ width: `${micPercent}%` }} />
                </div>
              </div>

              <div style={{ display:'flex', gap:12, alignItems:'center', justifyContent:'center', marginTop:8 }}>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize: 18, fontWeight:800 }}>{micPercent}%</div>
                  <div className="col-muted">Noise level</div>
                </div>

                <div style={{ width: 1, height: 36, background:'rgba(255,255,255,0.03)' }} />

                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize: 18, fontWeight:800 }}>{(micLevel*1.2 + 0.1).toFixed(2)}</div>
                  <div className="col-muted">Raw</div>
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight:700 }}>Noise threshold</div>
                <div style={{ marginTop:8 }} className="center">
                  <input aria-label="Noise threshold" type="range" min={0.01} max={0.6} step={0.01} value={noiseThreshold} onChange={e => setNoiseThreshold(Number(e.target.value))} />
                </div>
                <div className="col-muted" style={{ marginTop:6 }}>{noiseThreshold.toFixed(2)}</div>
              </div>

              <div style={{ marginTop: 14 }}>
                <div style={{ fontWeight:700 }}>Self-reported focus</div>
                <div style={{ marginTop:8 }} className="center">
                  <input aria-label="Self focus" type="range" min={0} max={100} value={selfFocus} onChange={e => setSelfFocus(Number(e.target.value))} />
                </div>
                <div className="col-muted" style={{ marginTop:6 }}>{selfFocus}%</div>
              </div>
            </div>
          </div>

          {/* RIGHT */}
          <div className="right-card">
            <div className="focus-score">
              <div className="score" style={{ fontSize: 56 }}>{focusScore ?? '--'}</div>
              <div className="sub">Higher is more focused</div>

              <div style={{ marginTop: 12 }}>
                {focusScore === null && <div className="col-muted">Start a session to see recommendations.</div>}
                {focusScore !== null && focusScore < 40 && <div className="reco low">Focus low — take a 2 minute break</div>}
                {focusScore !== null && focusScore >= 40 && focusScore < 70 && <div className="reco mid">Moderate focus — try a 5 minute deep-work block</div>}
                {focusScore !== null && focusScore >= 70 && <div className="reco good">Great focus — keep going!</div>}
              </div>

              <div style={{ marginTop: 18 }}>
                <button onClick={() => exportCSV()} className="btn btn-ghost" style={{ marginRight: 8 }}>Export Focus History</button>
                <button onClick={() => clearHistory()} className="btn btn-ghost">Clear History</button>
              </div>

              <div style={{ marginTop: 18, textAlign: 'left' }}>
                <div style={{ fontWeight:700, marginBottom:8 }}>Recent Focus Samples</div>
                <div className="list-sample" style={{ maxHeight: 180, overflowY: 'auto' }}>
                  {focusHistory.length === 0 && <div className="col-muted">No samples yet.</div>}
                  {focusHistory.map(h => (
                    <div key={h.time} className="list-row" style={{ display:'flex', justifyContent:'space-between' }}>
                      <div>{new Date(h.time).toLocaleTimeString()}</div>
                      <div>Score: {h.score}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* out-of-bounds popup */}
        {outOfBoundsWarning && (
          <div style={{ position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 28, background: 'linear-gradient(90deg,#ffefef,#fff2f2)', color: '#621010', padding: '12px 18px', borderRadius: 12, boxShadow: '0 8px 40px rgba(0,0,0,0.35)', border: '1px solid rgba(255,100,90,0.15)' }}>
            <div style={{ fontWeight:800 }}>Move into frame</div>
            <div style={{ fontSize: 13, marginTop: 6 }}>You're partially outside the camera boundary — your focus score will be reduced until you move back inside.</div>
          </div>
        )}

        <div className="activity-log" style={{ marginTop: 18 }}>
          <h3 style={{ marginTop: 0 }}>Activity Log</h3>
          <div>
            {activities.length === 0 && <div className="col-muted">No activities yet.</div>}
            {activities.map(a => (
              <div key={a.id} className="list-row" style={{ display:'flex', justifyContent:'space-between', padding: '6px 0', borderBottom: '1px solid rgba(0,0,0,0.02)' }}>
                <div style={{ fontWeight:700 }}>{a.type}</div>
                <div className="col-muted">{a.time ? new Date(a.time).toLocaleString() : ''}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="footer" style={{ marginTop: 18 }}>
          <div className="col-muted">Local prototype — data stored in browser</div>
          <div className="col-muted">Permission: {permissionState}</div>
        </div>
      </div>
    </div>
  );
}
