import React, { useEffect, useRef, useState } from "react";
import "./App.css";

const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const SESSIONS_KEY = "lf_sessions";
const MAX_SESSIONS = 500;

const saveSession = (entry) => {
  try {
    const arr = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
    arr.push(entry);
    if (arr.length > MAX_SESSIONS) arr.splice(0, arr.length - MAX_SESSIONS);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(arr));
  } catch {}
};

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const yesterdayKey = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dayKey(d);
};

const loadStats = () => {
  try {
    const s = JSON.parse(localStorage.getItem("lf_stats"));
    const today = dayKey();
    if (!s) return { todayDate: today, todayPomos: 0, todayFocusSec: 0, streak: 0, lastDay: null };
    if (s.todayDate !== today) return { ...s, todayDate: today, todayPomos: 0, todayFocusSec: 0 };
    return s;
  } catch {
    return { todayDate: dayKey(), todayPomos: 0, todayFocusSec: 0, streak: 0, lastDay: null };
  }
};
const saveStats = (s) => localStorage.setItem("lf_stats", JSON.stringify(s));

const PROXY = import.meta.env.VITE_PROXY_URL || "http://localhost:5174";

// Simple JSON fetch wrapper
async function getJson(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

export default function App() {
  // Constants for default lengths (minutes)
  const DEFAULT_FOCUS_MIN = 25;
  const DEFAULT_BREAK_MIN = 5;

  // UI state 
  const [activeTab, setActiveTab] = useState("timer"); // "timer" | "ui"
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Timer state 
  const [mode, setMode] = useState("focus"); // "focus" | "break"
  const [focusLenSec] = useState(DEFAULT_FOCUS_MIN * 60);
  const [breakLenSec] = useState(DEFAULT_BREAK_MIN * 60);
  const [time, setTime] = useState(DEFAULT_FOCUS_MIN * 60);
  const [sessionTotalSec, setSessionTotalSec] = useState(DEFAULT_FOCUS_MIN * 60);
  const [isRunning, setIsRunning] = useState(false);

  // Stats/session bookkeeping 
  const [stats, setStats] = useState(loadStats);
  const endedRef = useRef(false);             // guards double-firing when time hits 0
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [sessionStartISO, setSessionStartISO] = useState(null);

  // Notion "next task"
  const [nextTask, setNextTask] = useState(null); // {id?, title, lengthMin, plannedStartISO}
  const [showNextPopup, setShowNextPopup] = useState(false);
  const autostartRef = useRef(null); // holds timeout id for plannedStart

  // Inline minute editing
  const [editingMin, setEditingMin] = useState(false);
  const [editMinValue, setEditMinValue] = useState("");

  // Tick once per second while running
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setTime((t) => (t > 0 ? t - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  // When time hits zero, end current mode once
  useEffect(() => {
    if (isRunning && time === 0 && !endedRef.current) handleTimerEnd();
  }, [time, isRunning]);
  useEffect(() => {
    endedRef.current = false;
  }, [mode, sessionTotalSec]);

  // Initial data: pull next task once, set ESC to close modal
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try { await refreshNextTask(ctrl.signal); } catch (e) { console.error(e); }
    })();

    const onKey = (e) => { if (e.key === "Escape") setShowNextPopup(false); };
    window.addEventListener("keydown", onKey);

    return () => {
      ctrl.abort();
      window.removeEventListener("keydown", onKey);
      if (autostartRef.current) clearTimeout(autostartRef.current);
    };
  }, []);

  // Load the next Notion task 
  async function refreshNextTask(signal) {
    try {
      const data = await getJson(`${PROXY}/tasks/next`, signal);
      const candidate = data?.next ?? data ?? null;   // proxy may return {next} or direct
      if (candidate) {
        setNextTask(candidate);
        setShowNextPopup(true);
      } else {
        setNextTask(null);
        setShowNextPopup(false);
      }
    } catch (e) {
      console.error("Failed to fetch next task:", e);
      setNextTask(null);
      setShowNextPopup(false);
    }
  }

  // Start/Pause
  function handleStartPause() {
    setIsRunning((running) => {
      if (!running && !currentSessionId) {
        setCurrentSessionId(genId());
        setSessionStartISO(new Date().toISOString());
      }
      return !running;
    });
  }

  // End of countdown: record session, advance mode, update streaks
  function handleTimerEnd() {
    if (endedRef.current) return;
    endedRef.current = true;
    setIsRunning(false);

    const endDate = new Date();
    const elapsedSec = sessionStartISO
      ? Math.max(1, Math.round((endDate - new Date(sessionStartISO)) / 1000))
      : sessionTotalSec;

    saveSession({
      id: currentSessionId || genId(),
      mode,
      startISO: sessionStartISO || new Date(Date.now() - sessionTotalSec * 1000).toISOString(),
      endISO: endDate.toISOString(),
      durationSec: elapsedSec,
      taskId: nextTask?.id || null,
      taskLabel: nextTask?.title || null,
    });
    setCurrentSessionId(null);
    setSessionStartISO(null);

    if (mode === "focus") {
      // Streak rule: same day -> hold; yesterday -> +1; otherwise reset to 1 
      setStats((prev) => {
        const today = dayKey();
        let streak = prev.streak || 0;
        if (prev.lastDay === today) streak = prev.streak || 1;
        else if (prev.lastDay === yesterdayKey()) streak = (prev.streak || 0) + 1;
        else streak = 1;

        const next = {
          todayDate: today,
          todayPomos: (prev.todayPomos || 0) + 1,
          todayFocusSec: (prev.todayFocusSec || 0) + elapsedSec,
          streak,
          lastDay: today,
        };
        saveStats(next);
        return next;
      });

      setMode("break");
      setTime(breakLenSec);
      setSessionTotalSec(breakLenSec);
    } else {
      setMode("focus");
      setTime(focusLenSec);
      setSessionTotalSec(focusLenSec);
    }
  }

  // Reset current mode timer 
  function handleReset() {
    setIsRunning(false);
    if (mode === "focus") {
      setTime(focusLenSec);
      setSessionTotalSec(focusLenSec);
    } else {
      setTime(breakLenSec);
      setSessionTotalSec(breakLenSec);
    }
    setCurrentSessionId(null);
    setSessionStartISO(null);
    endedRef.current = false;
  }

  // Skip break and jump back to focus
  function skipBreak() {
    if (mode !== "break") return;
    setIsRunning(false);
    setMode("focus");
    setTime(focusLenSec);
    setSessionTotalSec(focusLenSec);
    setCurrentSessionId(null);
    setSessionStartISO(null);
    endedRef.current = false;
  }

  // Apply next task length to timer; optional autostart at plannedStart 
  function applyNextTask() {
    if (!nextTask) return;
    const secs = Math.max(60, Math.round(Number(nextTask.lengthMin || 25)) * 60);
    setIsRunning(false);
    setMode("focus");
    setTime(secs);
    setSessionTotalSec(secs);

    if (autostartRef.current) clearTimeout(autostartRef.current);
    if (nextTask.plannedStartISO) {
      const ms = new Date(nextTask.plannedStartISO).getTime() - Date.now();
      autostartRef.current = setTimeout(() => setIsRunning(true), Math.max(0, ms));
    }
    setShowNextPopup(false);
  }

  // Inline minutes editing 
  const minutesNow = Math.floor(time / 60);
  const secondsNow = time % 60;

  function startEditMinutes() {
    setEditingMin(true);
    setEditMinValue(String(minutesNow));
  }
  function commitMinutes(next) {
    const n = Math.max(1, Math.min(999, Number(next)));
    if (Number.isFinite(n)) {
      const newTotal = n * 60 + secondsNow;
      setTime(newTotal);
      setSessionTotalSec(newTotal);
      endedRef.current = false;
    }
    setEditingMin(false);
  }

  // Small subcomponents
  function SideNav({ activeTab, setActiveTab, onRefresh, onHelp }) {
    return (
      <aside className="sidenav" aria-label="App navigation">
        <div className="nav-group">
          <div className="avatar" title="Logged-in user (temp)">P</div>
        </div>

        <div className="nav-group" role="tablist" aria-orientation="vertical">
          <button
            className={`nav-btn ${activeTab === "timer" ? "active" : ""}`}
            onClick={() => setActiveTab("timer")}
            role="tab" aria-selected={activeTab === "timer"}
            title="Pomodoro"
          >⏱️</button>
          <button
            className={`nav-btn ${activeTab === "ui" ? "active" : ""}`}
            onClick={() => setActiveTab("ui")}
            role="tab" aria-selected={activeTab === "ui"}
            title="UI / Insights"
          >📊</button>
        </div>

        <div className="space-grow" />

        <div className="nav-group" aria-label="Utilities">
          <button className="nav-btn" onClick={onRefresh} title="Refresh tasks">🔄</button>
          <button className="nav-btn" title="Notifications (coming soon)">🔔</button>
          <button className="nav-btn" title="Settings (coming soon)">⚙️</button>
          <button className="nav-btn" onClick={onHelp} title="Help / Submit ticket">❓</button>
        </div>
      </aside>
    );
  }

  function TasksDrawer({ open, onClose }) {
    return (
      <>
        <div className={`drawer-backdrop ${open ? "open" : ""}`} onClick={onClose} />
        <aside className={`drawer ${open ? "open" : ""}`} aria-label="Tasks drawer">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <h3>Tasks</h3>
            <button className="btn tiny" onClick={onClose} aria-label="Close drawer">✕</button>
          </div>

          <div className="section-title">Today • Calendar order</div>
          <div className="task-item">Deep Work — Write spec <span className="timechip">9:00 • 45m</span></div>
          <div className="task-item">Email sweep <span className="timechip">10:00 • 15m</span></div>

          <div className="section-title">Unsorted</div>
          <div className="task-item">Plan gym routine</div>
          <div className="task-item">Read chapter 3</div>
        </aside>
      </>
    );
  }

  // Format helpers for UI only 
  const pad = (n) => n.toString().padStart(2, "0");
  const fmtDate = (iso) =>
    iso
      ? new Date(iso).toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "—";

  // Render
  return (
    <div className="page">
      <SideNav
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onRefresh={() => refreshNextTask()}
        onHelp={() => window.open("https://github.com/Mastermind-Network/life-forge/issues/new", "_blank")}
      />

      <div className="main">
        {!drawerOpen && (
          <button
            className="btn tiny tasks-toggle"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open tasks drawer"
          >
            🗂 Tasks
          </button>
        )}

        {activeTab === "timer" ? (
          <div className="card">
            <div className="header">
              <h1>Pomodoro</h1>
              <div className="right">
                <button
                  className="btn ghost"
                  onClick={() => refreshNextTask()}
                  title="Refresh next task"
                  aria-label="Refresh next task"
                >
                  ↻
                </button>
                <span className={`badge ${mode === "focus" ? "focus" : "break"}`}>{mode.toUpperCase()}</span>
              </div>
            </div>

            {nextTask && (
              <div className="nextline">
                <strong>Next:</strong> {nextTask.title} · {fmtDate(nextTask.plannedStartISO)} ·{" "}
                {Math.round(nextTask.lengthMin)}m
                <button className="btn tiny" onClick={() => setShowNextPopup(true)} aria-label="Show next task details">
                  details
                </button>
              </div>
            )}

            {/* TIME */}
            <div className="time" role="timer" aria-live="polite">
              {editingMin ? (
                <input
                  className="time-min-input"
                  value={editMinValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (/^\d{0,3}$/.test(v)) setEditMinValue(v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitMinutes(editMinValue);
                    if (e.key === "Escape") setEditingMin(false);
                  }}
                  onBlur={() => commitMinutes(editMinValue)}
                  autoFocus
                  inputMode="numeric"
                  pattern="[0-9]*"
                  aria-label="Edit minutes"
                />
              ) : (
                <span className="time-min" onClick={startEditMinutes} title="Click to edit minutes" aria-label="Minutes value; click to edit">
                  {pad(minutesNow)}
                </span>
              )}
              <span className="colon">:</span>
              <span className="sec">{pad(secondsNow)}</span>
            </div>

            <div className="controls">
              <button className="btn primary" onClick={handleStartPause} aria-label={isRunning ? "Pause timer" : "Start timer"}>
                {isRunning ? "Pause" : "Start"}
              </button>
              <button className="btn ghost" onClick={handleReset} aria-label={mode === "break" ? "Reset break" : "Reset focus"}>
                {mode === "break" ? "Reset Break" : "Reset Focus"}
              </button>
              {mode === "break" && (
                <button className="btn ghost" onClick={skipBreak} aria-label="Skip break">
                  Skip Break
                </button>
              )}
            </div>

            <div className="footer">
              <div className="summary"><span>Today</span><strong>{Math.floor(stats.todayFocusSec / 60)}m</strong><span>focus</span></div>
              <div className="summary"><span>Pomodoros</span><strong>{stats.todayPomos}</strong></div>
              <div className="summary"><span>Streak</span><strong>{stats.streak}</strong><span>days</span></div>
            </div>
          </div>
        ) : (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Insights / Settings</h2>
            <p style={{ color: "var(--muted)" }}>Lightweight second tab. Add stats or preferences here later.</p>
          </div>
        )}
      </div>

      {showNextPopup && nextTask && (
        <div className="modal-backdrop" onClick={() => setShowNextPopup(false)} role="presentation">
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Upcoming task details">
            <h3>Upcoming Task</h3>
            <div className="modal-body">
              <div className="row"><span className="k">Title</span><span className="v">{nextTask.title || "Untitled"}</span></div>
              <div className="row"><span className="k">Start</span><span className="v">{fmtDate(nextTask.plannedStartISO)}</span></div>
              <div className="row"><span className="k">Length</span><span className="v">{Math.round(nextTask.lengthMin)} min</span></div>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setShowNextPopup(false)} aria-label="Close dialog">Close</button>
              <button className="btn primary" onClick={applyNextTask} aria-label="Use this task">Use This Task</button>
            </div>
          </div>
        </div>
      )}

      <TasksDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}
