import React, { useState, useEffect, useRef } from 'react';

export default function FocusLensMVP() {
  const [user] = useState(() => ({ id: 'local_user', name: 'You' }));
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionStart, setSessionStart] = useState(null);
  const [activities, setActivities] = useState(() => {
    try { return JSON.parse(localStorage.getItem('focuslens_activities') || '[]'); } catch { return []; }
  });

  const videoRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const rafRef = useRef(null);
  const simIntervalRef = useRef(null);

  const [micLevel, setMicLevel] = useState(0);
  const [selfFocus, setSelfFocus] = useState(80);
  const [noiseThreshold, setNoiseThreshold] = useState(0.2);
  const [focusHistory, setFocusHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('focuslens_history') || '[]'); } catch { return []; }
  });
  const [focusScore, setFocusScore] = useState(null);
  const [recording, setRecording] = useState(false);
  const [deviceError, setDeviceError] = useState(null);
  const [simulateMode, setSimulateMode] = useState(false);

  useEffect(() => { try { localStorage.setItem('focuslens_activities', JSON.stringify(activities)); } catch {} }, [activities]);
  useEffect(() => { try { localStorage.setItem('focuslens_history', JSON.stringify(focusHistory)); } catch {} }, [focusHistory]);

  useEffect(() => {
    return () => {
      if (rafRef.current) try { cancelAnimationFrame(rafRef.current); } catch {};
      if (simIntervalRef.current) try { clearInterval(simIntervalRef.current); } catch {};
      if (mediaStreamRef.current) try { mediaStreamRef.current.getTracks().forEach(t => t.stop()); } catch {};
      if (audioCtxRef.current) try { audioCtxRef.current.close(); } catch {};
    };
  }, []);

  async function startDevices() {
    setDeviceError(null);
    setSimulateMode(false);
    stopSimulation();

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      setDeviceError('Camera/microphone APIs not available — using simulation.');
      setSimulateMode(true);
      startSimulation();
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      mediaStreamRef.current = stream;
      if (videoRef.current) {
        try { videoRef.current.srcObject = stream; } catch {}
      }

      if (!audioCtxRef.current) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
          setDeviceError('Web Audio not supported — using simulation.');
          setSimulateMode(true);
          startSimulation();
          return false;
        }
        const ctx = new AudioCtx();
        audioCtxRef.current = ctx;
        try { await ctx.resume(); } catch {}
        let source = null;
        try { source = ctx.createMediaStreamSource(stream); } catch (e) { source = null; }
        if (!source) {
          setDeviceError('Could not create audio source — using simulation.');
          setSimulateMode(true);
          startSimulation();
          return false;
        }
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        try { source.connect(analyser); } catch {}
        analyserRef.current = analyser;
        const data = new Uint8Array(analyser.frequencyBinCount);
        const loop = () => {
          try {
            analyserRef.current && analyserRef.current.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const avg = (data.length > 0) ? (sum / data.length / 255) : 0;
            setMicLevel(prev => {
              if (isNaN(avg) || !isFinite(avg)) return prev || 0;
              return Math.max(0, Math.min(1, avg));
            });
          } catch (e) {
            console.error('audio read error', e);
          }
          try { rafRef.current = requestAnimationFrame(loop); } catch {}
        };
        try { rafRef.current = requestAnimationFrame(loop); } catch {}
      }
      return true;
    } catch (e) {
      console.error('device error', e);
      setDeviceError('Unable to access camera/microphone. Grant permissions or use simulation.');
      setSimulateMode(true);
      startSimulation();
      return false;
    }
  }

  function startSimulation() {
    stopSimulation();
    let v = micLevel || 0.2;
    simIntervalRef.current = setInterval(() => {
      v += (Math.random() - 0.5) * 0.05;
      v = Math.max(0, Math.min(1, v));
      setMicLevel(v);
    }, 300);
  }

  function stopSimulation() {
    if (simIntervalRef.current) { try { clearInterval(simIntervalRef.current); } catch {} simIntervalRef.current = null; }
  }

  function stopDevices() {
    if (rafRef.current) { try { cancelAnimationFrame(rafRef.current); } catch {} rafRef.current = null; }
    if (mediaStreamRef.current) {
      try { mediaStreamRef.current.getTracks().forEach(t => t.stop()); } catch {};
      mediaStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {};
      audioCtxRef.current = null;
      analyserRef.current = null;
    }
    stopSimulation();
  }

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
    id: x_${Date.now()}_${Math.random().toString(36).slice(2,6)}, 
    userId: user.id, 
    ...obj 
  };
  setActivities(prev => [entry, ...prev]);
}


  useEffect(() => {
    if (!recording) return;
    const tick = setInterval(() => {
      const noise = Math.min(1, Math.max(0, micLevel || 0));
      const ambientScore = 1 - Math.min(1, noise / Math.max(0.0001, noiseThreshold));
      const self = (Number(selfFocus) || 0) / 100;
      const fused = Math.max(0, Math.min(1, (self * 0.65) + (ambientScore * 0.35)));
      const score = Math.round(fused * 100);
      setFocusScore(score);
      const now = new Date().toISOString();
      setFocusHistory(prev => [{ time: now, score, mic: noise, self: Number(selfFocus) }, ...prev].slice(0, 1000));
    }, 3000);
    return () => clearInterval(tick);
  }, [recording, micLevel, selfFocus, noiseThreshold]);

  function exportCSV() {
    const rows = [['time','score','mic','self']];
    focusHistory.forEach(h => rows.push([h.time, String(h.score), String(h.mic), String(h.self)]));
    const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g,'""') + '"').join(',')).join('\n');
    try {
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'focus_history.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) {
      console.error('export failed', e);
    }
  }

  function clearHistory() { setFocusHistory([]); }

  return (
    <div className="min-h-screen bg-gray-50 p-6 font-sans">
      <div className="max-w-4xl mx-auto bg-white p-6 rounded shadow">
        <h1 className="text-2xl font-bold mb-4">Focus Lens — MVP</h1>

        {deviceError && (
          <div className="mb-4 p-3 rounded bg-yellow-50 border border-yellow-200 text-sm">
            <div className="font-medium">Device warning</div>
            <div className="mt-1">{deviceError}</div>
            <div className="mt-2 flex gap-2">
              <button onClick={() => { setDeviceError(null); setSimulateMode(true); startSimulation(); }} className="px-3 py-1 border rounded">Use Simulation</button>
              <button onClick={() => { setDeviceError(null); }} className="px-3 py-1 border rounded">Dismiss</button>
            </div>
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <div className="mb-2 font-medium">Live Camera</div>
            <div className="border rounded overflow-hidden">
              <video ref={videoRef} autoPlay muted playsInline className="w-full h-64 object-cover bg-black" />
            </div>
            <div className="mt-2 flex gap-2">
              {!sessionActive ? (
                <button onClick={startSession} className="px-3 py-2 bg-green-600 text-white rounded">Start Session</button>
              ) : (
                <button onClick={endSession} className="px-3 py-2 bg-red-600 text-white rounded">End Session</button>
              )}
              <button onClick={startDevices} className="px-3 py-2 border rounded">Enable Devices</button>
              <button onClick={stopDevices} className="px-3 py-2 border rounded">Disable Devices</button>
            </div>

            <div className="mt-4">
              <div className="font-medium">Microphone Level</div>
              <div className="w-full bg-gray-200 rounded h-3 mt-2">
                <div
  style={{ width: ${Math.round((micLevel || 0) * 100)}% }}
  className="h-3 bg-blue-600 rounded"
/>

              </div>
              <div className="text-xs text-gray-500 mt-1">Level: {(micLevel||0).toFixed(2)}</div>
              <div className="mt-2 flex gap-2 items-center">
                <label className="text-sm">Noise Threshold</label>
                <input type="range" min={0.01} max={0.6} step={0.01} value={noiseThreshold} onChange={e => setNoiseThreshold(Number(e.target.value))} />
                <div className="text-sm">{noiseThreshold.toFixed(2)}</div>
              </div>

              <div className="mt-3">
                <label className="font-medium">Self-reported focus</label>
                <div className="flex items-center gap-2 mt-2">
                  <input type="range" min={0} max={100} value={selfFocus} onChange={e => setSelfFocus(Number(e.target.value))} />
                  <div className="text-sm font-semibold">{selfFocus}%</div>
                </div>
              </div>

            </div>
          </div>

          <div>
            <div className="mb-2 font-medium">Live Focus Score</div>
            <div className="p-4 border rounded h-40 flex flex-col justify-center items-center">
              <div className="text-5xl font-bold">{focusScore ?? '--'}</div>
              <div className="text-sm text-gray-500 mt-2">Higher is more focused</div>
            </div>

            <div className="mt-4">
              <div className="font-medium">Recommendations</div>
              <div className="mt-2 text-sm">
                {focusScore === null && <div className="text-gray-500">Start a session to see recommendations.</div>}
                {focusScore !== null && focusScore < 40 && <div className="text-red-600">Focus low — take a 2 minute break or reduce ambient noise.</div>}
                {focusScore !== null && focusScore >= 40 && focusScore < 70 && <div className="text-yellow-600">Moderate focus — try a 5 minute deep-work block.</div>}
                {focusScore !== null && focusScore >= 70 && <div className="text-green-600">Great focus — keep going! Consider scheduling a longer focused block.</div>}
              </div>

              <div className="mt-4">
                <button onClick={() => exportCSV()} className="px-3 py-2 border rounded mr-2">Export Focus History</button>
                <button onClick={() => clearHistory()} className="px-3 py-2 border rounded">Clear History</button>
              </div>
            </div>

            <div className="mt-4">
              <div className="font-medium">Recent Focus Samples</div>
              <div className="mt-2 max-h-64 overflow-auto text-sm border rounded p-2">
                {focusHistory.length === 0 && <div className="text-gray-500">No samples yet.</div>}
                {focusHistory.map(h => (
                  <div key={h.time} className="flex justify-between border-b py-1">
                    <div>{new Date(h.time).toLocaleTimeString()}</div>
                    <div>Score: {h.score}</div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>

        <div className="mt-6">
          <h2 className="text-lg font-semibold">Activity Log</h2>
          <div className="mt-2 max-h-48 overflow-auto border rounded p-2 text-sm">
            {activities.length === 0 && <div className="text-gray-500">No activities yet.</div>}
            {activities.map(a => (
              <div key={a.id} className="flex justify-between py-1 border-b">
                <div>{a.type}</div>
                <div className="text-gray-500">{new Date(a.time).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}