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
const RECORDED_REMINDER_AUDIO_URL = `${import.meta.env.BASE_URL}audio/canon-reminder.mp3`;
const CANON_BEAT_SECONDS = 0.28;
const CANON_REMINDER_MOTIF = [
  587.33, // D5
  440.0, // A4
  493.88, // B4
  369.99, // F#4
  392.0, // G4
  293.66, // D4
  392.0, // G4
  440.0, // A4
] as const;
const CANON_REMINDER_BASS = [
  146.83, // D3
  110.0, // A2
  123.47, // B2
  92.5, // F#2
  98.0, // G2
  146.83, // D3
  98.0, // G2
  110.0, // A2
] as const;

const phaseLabels: Record<Phase, string> = {
  study: "学习中",
  break: "休息中",
};

const nextPhaseLabels: Record<Phase, string> = {
  study: "休息",
  break: "学习",
};

function getPhaseDurationSeconds(
  phase: Phase,
  studyMinutes: number,
  breakMinutes: number,
) {
  return (phase === "study" ? studyMinutes : breakMinutes) * 60;
}

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
  const recordedReminderBufferRef = useRef<AudioBuffer | null>(null);
  const recordedReminderLoadPromiseRef = useRef<Promise<AudioBuffer> | null>(null);
  const phaseEndsAtRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>("study");
  const statusRef = useRef<TimerStatus>("idle");

  const selectedPhaseDurationSeconds = getPhaseDurationSeconds(
    phase,
    studyMinutes,
    breakMinutes,
  );
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
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (status === "idle") {
      phaseEndsAtRef.current = null;
      setCurrentPhaseDurationSeconds(selectedPhaseDurationSeconds);
      setRemainingSeconds(selectedPhaseDurationSeconds);
    }
  }, [selectedPhaseDurationSeconds, status]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    syncTimerToClock();

    const intervalId = window.setInterval(syncTimerToClock, 1000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        syncTimerToClock();
      }
    };
    const handleFocus = () => syncTimerToClock();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [breakMinutes, isRunning, soundEnabled, studyMinutes]);

  function getAudioContext() {
    if (!audioContextRef.current) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;

      if (!AudioContextClass) {
        return null;
      }

      audioContextRef.current = new AudioContextClass();
    }

    return audioContextRef.current;
  }

  async function loadRecordedReminderSound(context: AudioContext) {
    if (recordedReminderBufferRef.current) {
      return recordedReminderBufferRef.current;
    }

    recordedReminderLoadPromiseRef.current ??= fetch(RECORDED_REMINDER_AUDIO_URL)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Reminder audio failed to load.");
        }

        return response.arrayBuffer();
      })
      .then((arrayBuffer) => context.decodeAudioData(arrayBuffer))
      .then((buffer) => {
        recordedReminderBufferRef.current = buffer;
        return buffer;
      });

    return recordedReminderLoadPromiseRef.current;
  }

  async function prepareAudio() {
    const context = getAudioContext();
    if (!context) {
      setAudioReady(false);
      return;
    }

    if (context.state === "suspended") {
      await context.resume();
    }

    void loadRecordedReminderSound(context)
      .then(() => setAudioReady(true))
      .catch(() => setAudioReady(context.state === "running"));

    setAudioReady(context.state === "running");
  }

  function playGeneratedCanonSound(context: AudioContext) {
    const now = context.currentTime + 0.04;
    const masterGain = context.createGain();
    masterGain.gain.setValueAtTime(0.72, now);
    masterGain.connect(context.destination);

    const scheduleTone = (
      frequency: number,
      start: number,
      duration: number,
      volume: number,
      type: OscillatorType,
    ) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const end = start + duration;
      const sustainStart = Math.min(start + 0.03, end - 0.02);
      const releaseStart = Math.max(sustainStart, end - 0.06);

      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, sustainStart);
      gain.gain.setValueAtTime(volume, releaseStart);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain);
      gain.connect(masterGain);
      oscillator.start(start);
      oscillator.stop(end + 0.04);
    };

    CANON_REMINDER_MOTIF.forEach((frequency, index) => {
      const start = now + index * CANON_BEAT_SECONDS;
      scheduleTone(
        frequency,
        start,
        CANON_BEAT_SECONDS * 0.88,
        0.16,
        "triangle",
      );

      if (index < CANON_REMINDER_MOTIF.length - 2) {
        scheduleTone(
          frequency * 0.5,
          start + CANON_BEAT_SECONDS * 2,
          CANON_BEAT_SECONDS * 0.82,
          0.08,
          "sine",
        );
      }
    });

    CANON_REMINDER_BASS.forEach((frequency, index) => {
      scheduleTone(
        frequency,
        now + index * CANON_BEAT_SECONDS,
        CANON_BEAT_SECONDS * 1.55,
        0.055,
        "sine",
      );
    });

    window.setTimeout(
      () => masterGain.disconnect(),
      (CANON_REMINDER_MOTIF.length + 3) * CANON_BEAT_SECONDS * 1000,
    );
  }

  function playRecordedReminderSound(context: AudioContext, buffer: AudioBuffer) {
    const source = context.createBufferSource();
    const gain = context.createGain();

    source.buffer = buffer;
    gain.gain.setValueAtTime(0.9, context.currentTime);
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
  }

  async function playReminderSound() {
    if (!soundEnabled) {
      return;
    }

    const context = getAudioContext();
    if (!context) {
      setAudioReady(false);
      return;
    }

    if (context.state === "suspended") {
      await context.resume();
    }

    try {
      const buffer = await loadRecordedReminderSound(context);
      playRecordedReminderSound(context, buffer);
      setAudioReady(true);
      return;
    } catch {
      playGeneratedCanonSound(context);
      setAudioReady(true);
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

  function syncTimerToClock(now = Date.now()) {
    if (statusRef.current !== "running" || phaseEndsAtRef.current === null) {
      return;
    }

    if (now < phaseEndsAtRef.current) {
      setRemainingSeconds(
        Math.max(0, Math.ceil((phaseEndsAtRef.current - now) / 1000)),
      );
      return;
    }

    let nextPhase = phaseRef.current;
    let nextPhaseEndsAt = phaseEndsAtRef.current;
    let completedStudyRounds = 0;
    let lastFinishedPhase: Phase | null = null;
    let transitions = 0;

    while (now >= nextPhaseEndsAt && transitions < 20000) {
      lastFinishedPhase = nextPhase;

      if (nextPhase === "study") {
        completedStudyRounds += 1;
      }

      nextPhase = nextPhase === "study" ? "break" : "study";
      nextPhaseEndsAt += getPhaseDurationSeconds(
        nextPhase,
        studyMinutes,
        breakMinutes,
      ) * 1000;
      transitions += 1;
    }

    const nextDurationSeconds = getPhaseDurationSeconds(
      nextPhase,
      studyMinutes,
      breakMinutes,
    );
    const nextRemainingSeconds =
      now >= nextPhaseEndsAt
        ? nextDurationSeconds
        : Math.max(0, Math.ceil((nextPhaseEndsAt - now) / 1000));

    phaseRef.current = nextPhase;
    phaseEndsAtRef.current = nextPhaseEndsAt;
    setPhase(nextPhase);
    setCurrentPhaseDurationSeconds(nextDurationSeconds);
    setRemainingSeconds(nextRemainingSeconds);

    if (completedStudyRounds > 0) {
      setCompletedRounds((rounds) => rounds + completedStudyRounds);
    }

    if (lastFinishedPhase) {
      void playReminderSound();
      notifyPhaseEnd(lastFinishedPhase);
    }
  }

  async function handleStart() {
    await prepareAudio().catch(() => setAudioReady(false));
    phaseEndsAtRef.current = Date.now() + remainingSeconds * 1000;
    statusRef.current = "running";
    setStatus("running");
  }

  async function handleResume() {
    await prepareAudio().catch(() => setAudioReady(false));
    phaseEndsAtRef.current = Date.now() + remainingSeconds * 1000;
    statusRef.current = "running";
    setStatus("running");
  }

  function handlePause() {
    syncTimerToClock();

    if (phaseEndsAtRef.current !== null) {
      setRemainingSeconds(
        Math.max(0, Math.ceil((phaseEndsAtRef.current - Date.now()) / 1000)),
      );
    }

    phaseEndsAtRef.current = null;
    statusRef.current = "paused";
    setStatus("paused");
  }

  function handleReset() {
    const studyDurationSeconds = studyMinutes * 60;

    phaseEndsAtRef.current = null;
    phaseRef.current = "study";
    statusRef.current = "idle";
    setStatus("idle");
    setPhase("study");
    setCurrentPhaseDurationSeconds(studyDurationSeconds);
    setRemainingSeconds(studyDurationSeconds);
    setCompletedRounds(0);
  }

  function handleSkip() {
    const nextPhase: Phase = phase === "study" ? "break" : "study";
    const nextDurationSeconds = getPhaseDurationSeconds(
      nextPhase,
      studyMinutes,
      breakMinutes,
    );

    if (phase === "study") {
      setCompletedRounds((rounds) => rounds + 1);
    }

    phaseRef.current = nextPhase;
    phaseEndsAtRef.current =
      status === "running" ? Date.now() + nextDurationSeconds * 1000 : null;
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
