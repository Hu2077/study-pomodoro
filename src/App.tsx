import { useEffect, useMemo, useRef, useState } from "react";

type Phase = "study" | "break";
type TimerStatus = "idle" | "running" | "paused";

type SavedSettings = {
  studyMinutes: number;
  breakMinutes: number;
  soundEnabled: boolean;
};

const DEFAULT_STUDY_MINUTES = 60;
const DEFAULT_BREAK_MINUTES = 10;
const SETTINGS_KEY = "study-pomodoro-settings";
const MIN_MINUTES = 1;
const MAX_MINUTES = 240;

const phaseLabels: Record<Phase, string> = {
  study: "学习中",
  break: "休息中",
};

const nextPhaseLabels: Record<Phase, string> = {
  study: "休息",
  break: "学习",
};

function clampMinutes(value: number) {
  if (!Number.isFinite(value)) {
    return MIN_MINUTES;
  }

  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(value)));
}

function loadSettings(): SavedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return {
        studyMinutes: DEFAULT_STUDY_MINUTES,
        breakMinutes: DEFAULT_BREAK_MINUTES,
        soundEnabled: true,
      };
    }

    const parsed = JSON.parse(raw) as Partial<SavedSettings>;

    return {
      studyMinutes: clampMinutes(parsed.studyMinutes ?? DEFAULT_STUDY_MINUTES),
      breakMinutes: clampMinutes(parsed.breakMinutes ?? DEFAULT_BREAK_MINUTES),
      soundEnabled: parsed.soundEnabled ?? true,
    };
  } catch {
    return {
      studyMinutes: DEFAULT_STUDY_MINUTES,
      breakMinutes: DEFAULT_BREAK_MINUTES,
      soundEnabled: true,
    };
  }
}

function formatTime(totalSeconds: number) {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getNotificationPermission() {
  if (!("Notification" in window)) {
    return "unsupported";
  }

  return Notification.permission;
}

function App() {
  const initialSettings = useMemo(loadSettings, []);
  const [studyMinutes, setStudyMinutes] = useState(initialSettings.studyMinutes);
  const [breakMinutes, setBreakMinutes] = useState(initialSettings.breakMinutes);
  const [soundEnabled, setSoundEnabled] = useState(initialSettings.soundEnabled);
  const [phase, setPhase] = useState<Phase>("study");
  const [status, setStatus] = useState<TimerStatus>("idle");
  const [remainingSeconds, setRemainingSeconds] = useState(
    initialSettings.studyMinutes * 60,
  );
  const [currentPhaseDurationSeconds, setCurrentPhaseDurationSeconds] = useState(
    initialSettings.studyMinutes * 60,
  );
  const [completedRounds, setCompletedRounds] = useState(0);
  const [notificationPermission, setNotificationPermission] = useState(
    getNotificationPermission,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextPhaseHandledRef = useRef(false);

  const selectedPhaseDurationSeconds =
    (phase === "study" ? studyMinutes : breakMinutes) * 60;
  const progress =
    currentPhaseDurationSeconds === 0
      ? 0
      : (currentPhaseDurationSeconds - remainingSeconds) / currentPhaseDurationSeconds;
  const progressPercent = Math.min(100, Math.max(0, progress * 100));
  const circumference = 2 * Math.PI * 132;
  const strokeOffset = circumference * (1 - progressPercent / 100);
  const isRunning = status === "running";
  const canPause = status === "running";
  const canResume = status === "paused";
  const canStart = status === "idle";
  const phaseAccent = phase === "study" ? "study" : "break";

  useEffect(() => {
    const settings: SavedSettings = {
      studyMinutes,
      breakMinutes,
      soundEnabled,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [breakMinutes, soundEnabled, studyMinutes]);

  useEffect(() => {
    if (status === "idle") {
      setCurrentPhaseDurationSeconds(selectedPhaseDurationSeconds);
      setRemainingSeconds(selectedPhaseDurationSeconds);
    }
  }, [selectedPhaseDurationSeconds, status]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRemainingSeconds((current) => Math.max(0, current - 1));
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [isRunning]);

  useEffect(() => {
    if (status !== "running" || remainingSeconds > 0) {
      nextPhaseHandledRef.current = false;
      return;
    }

    if (nextPhaseHandledRef.current) {
      return;
    }

    nextPhaseHandledRef.current = true;
    finishCurrentPhase();
  }, [remainingSeconds, status]);

  async function prepareAudio() {
    if (!audioContextRef.current) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        setAudioReady(false);
        return;
      }

      audioContextRef.current = new AudioContextClass();
    }

    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }

    setAudioReady(true);
  }

  async function playReminderSound() {
    if (!soundEnabled) {
      return;
    }

    try {
      await prepareAudio();
      const context = audioContextRef.current;
      if (!context) {
        return;
      }

      const now = context.currentTime;
      const notes = [660, 880, 660];

      notes.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = now + index * 0.22;
        const end = start + 0.16;

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.28, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(start);
        oscillator.stop(end + 0.02);
      });
    } catch {
      setAudioReady(false);
    }
  }

  function notifyPhaseEnd(finishedPhase: Phase) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return;
    }

    const nextLabel = nextPhaseLabels[finishedPhase];
    const message =
      finishedPhase === "study"
        ? "学习阶段结束，可以休息一下了。"
        : "休息结束，准备进入下一轮学习。";

    new Notification(`番茄时钟：进入${nextLabel}`, {
      body: message,
      tag: "study-pomodoro-phase",
    });
  }

  function finishCurrentPhase() {
    const finishedPhase = phase;
    const nextPhase: Phase = finishedPhase === "study" ? "break" : "study";
    const nextDurationSeconds = (nextPhase === "study" ? studyMinutes : breakMinutes) * 60;

    void playReminderSound();
    notifyPhaseEnd(finishedPhase);

    if (finishedPhase === "study") {
      setCompletedRounds((rounds) => rounds + 1);
    }

    setPhase(nextPhase);
    setCurrentPhaseDurationSeconds(nextDurationSeconds);
    setRemainingSeconds(nextDurationSeconds);
    setStatus("running");
  }

  async function handleStart() {
    await prepareAudio().catch(() => setAudioReady(false));
    setStatus("running");
  }

  async function handleResume() {
    await prepareAudio().catch(() => setAudioReady(false));
    setStatus("running");
  }

  function handlePause() {
    setStatus("paused");
  }

  function handleReset() {
    const studyDurationSeconds = studyMinutes * 60;

    setStatus("idle");
    setPhase("study");
    setCurrentPhaseDurationSeconds(studyDurationSeconds);
    setRemainingSeconds(studyDurationSeconds);
    setCompletedRounds(0);
  }

  function handleSkip() {
    const nextPhase: Phase = phase === "study" ? "break" : "study";
    const nextDurationSeconds = (nextPhase === "study" ? studyMinutes : breakMinutes) * 60;

    if (phase === "study") {
      setCompletedRounds((rounds) => rounds + 1);
    }

    setPhase(nextPhase);
    setCurrentPhaseDurationSeconds(nextDurationSeconds);
    setRemainingSeconds(nextDurationSeconds);
  }

  async function requestNotifications() {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      return;
    }

    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
  }

  function handleDurationChange(
    nextValue: string,
    setter: (minutes: number) => void,
  ) {
    setter(clampMinutes(Number(nextValue)));
  }

  return (
    <main className={`app app-${phaseAccent}`}>
      <section className="timer-shell" aria-label="学习番茄时钟">
        <div className="phase-row">
          <span className="phase-pill">{phaseLabels[phase]}</span>
          <span className="status-text">
            {status === "running" && "正在计时"}
            {status === "paused" && "已暂停"}
            {status === "idle" && "准备开始"}
          </span>
        </div>

        <div className="timer-face" aria-live="polite">
          <svg className="progress-ring" viewBox="0 0 300 300" role="img">
            <title>当前阶段进度 {Math.round(progressPercent)}%</title>
            <circle className="progress-track" cx="150" cy="150" r="132" />
            <circle
              className="progress-value"
              cx="150"
              cy="150"
              r="132"
              strokeDasharray={circumference}
              strokeDashoffset={strokeOffset}
            />
          </svg>
          <div className="time-stack">
            <p className="timer-label">{phase === "study" ? "专注学习" : "安心休息"}</p>
            <h1>{formatTime(remainingSeconds)}</h1>
            <p className="next-phase">下一阶段：{nextPhaseLabels[phase]}</p>
          </div>
        </div>

        <div className="stats-grid">
          <div>
            <span>学习轮数</span>
            <strong>{completedRounds}</strong>
          </div>
          <div>
            <span>当前进度</span>
            <strong>{Math.round(progressPercent)}%</strong>
          </div>
          <div>
            <span>提醒声音</span>
            <strong>{soundEnabled ? "开启" : "静音"}</strong>
          </div>
        </div>

        <div className="controls">
          {canStart && (
            <button className="primary" type="button" onClick={() => void handleStart()}>
              开始
            </button>
          )}
          {canPause && (
            <button className="primary" type="button" onClick={handlePause}>
              暂停
            </button>
          )}
          {canResume && (
            <button className="primary" type="button" onClick={() => void handleResume()}>
              继续
            </button>
          )}
          <button type="button" onClick={handleSkip}>
            跳过当前阶段
          </button>
          <button type="button" onClick={handleReset}>
            重置
          </button>
        </div>

        <div className="quick-actions">
          <label className="toggle">
            <input
              checked={soundEnabled}
              type="checkbox"
              onChange={(event) => setSoundEnabled(event.target.checked)}
            />
            <span>{soundEnabled ? "声音开启" : "静音模式"}</span>
          </label>

          <button
            className="link-button"
            type="button"
            onClick={() => void requestNotifications()}
            disabled={
              notificationPermission === "granted" ||
              notificationPermission === "denied" ||
              notificationPermission === "unsupported"
            }
          >
            {notificationPermission === "granted" && "通知已开启"}
            {notificationPermission === "denied" && "通知被浏览器阻止"}
            {notificationPermission === "unsupported" && "浏览器不支持通知"}
            {notificationPermission === "default" && "开启桌面通知"}
          </button>
        </div>

        <section className="settings-panel">
          <button
            className="settings-summary"
            type="button"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <span>计时设置</span>
            <span>{settingsOpen ? "收起" : "展开"}</span>
          </button>

          {settingsOpen && (
            <div className="settings-body">
              <label>
                学习时长（分钟）
                <input
                  min={MIN_MINUTES}
                  max={MAX_MINUTES}
                  type="number"
                  value={studyMinutes}
                  onChange={(event) =>
                    handleDurationChange(event.target.value, setStudyMinutes)
                  }
                />
              </label>

              <label>
                休息时长（分钟）
                <input
                  min={MIN_MINUTES}
                  max={MAX_MINUTES}
                  type="number"
                  value={breakMinutes}
                  onChange={(event) =>
                    handleDurationChange(event.target.value, setBreakMinutes)
                  }
                />
              </label>

              <p className="settings-note">
                计时进行中修改设置会在下一次重置或阶段切换时完整生效。
              </p>
            </div>
          )}
        </section>

        <p className="audio-note">
          {audioReady
            ? "提醒音已就绪，阶段结束会自动播放。"
            : "浏览器通常需要先点击开始，之后才能播放提醒音。"}
        </p>
      </section>
    </main>
  );
}

export default App;
