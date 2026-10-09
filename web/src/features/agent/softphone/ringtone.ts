// Ringtone generated with Web Audio (Indian ring: 400 + 450 Hz, two 0.4 s
// bursts every 3 s), so there's no sound file to load. Browsers allow audio
// only after the user has interacted with the page, so the audio context is
// unlocked on the first click or key (agents always click Connect or a
// status before a call can arrive).
type Ctx = AudioContext;

let ctx: Ctx | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let oscillators: OscillatorNode[] = [];

export function unlockRingtone() {
  try {
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!ctx && AC) ctx = new AC();
    if (ctx?.state === 'suspended') void ctx.resume();
  } catch {
    // No Web Audio - the incoming-call popup still shows, just silently.
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', unlockRingtone);
  document.addEventListener('keydown', unlockRingtone);
}

function burst(c: Ctx, at: number, seconds: number) {
  const gain = c.createGain();
  gain.gain.value = 0.08;
  gain.connect(c.destination);
  for (const freq of [400, 450]) {
    const osc = c.createOscillator();
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(at);
    osc.stop(at + seconds);
    oscillators.push(osc);
  }
}

export function startRingtone() {
  stopRingtone();
  unlockRingtone();
  const c = ctx;
  if (!c) return;
  const cycle = () => {
    oscillators = oscillators.slice(-8); // older bursts have finished
    const t = c.currentTime + 0.05;
    burst(c, t, 0.4);
    burst(c, t + 0.6, 0.4);
  };
  cycle();
  timer = setInterval(cycle, 3000);
}

export function stopRingtone() {
  if (timer) clearInterval(timer);
  timer = null;
  for (const o of oscillators) {
    try {
      o.stop();
    } catch {
      // already stopped
    }
  }
  oscillators = [];
}
