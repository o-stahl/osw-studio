const VOLUME = 0.176; // base peak gain (80% of 0.22)

let sharedContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (sharedContext && sharedContext.state !== 'closed') return sharedContext;
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  sharedContext = AC ? new AC() : null;
  return sharedContext;
}

export function playTaskCompleteSound() {
  const ac = getContext();
  if (!ac) return;

  const t0 = ac.currentTime;
  const freqs = [523.3, 784];
  const spd = 0.11;
  const sw = 0.080;

  const dly = ac.createDelay(1.0);
  dly.delayTime.value = spd * 1.5;
  const dlyG = ac.createGain();
  dlyG.gain.value = 0.12;
  const fb = ac.createGain();
  fb.gain.value = 0.3;
  dly.connect(dlyG).connect(ac.destination);
  dly.connect(fb).connect(dly);

  freqs.forEach((freq, i) => {
    const t = t0 + i * spd + (i % 2 === 1 ? spd * sw : 0);
    const prev = i > 0 ? freqs[i - 1] : freq;

    const o1 = ac.createOscillator();
    const o2 = ac.createOscillator();
    o1.type = o2.type = 'sine';
    o1.frequency.setValueAtTime(prev, t);
    o1.frequency.exponentialRampToValueAtTime(freq, t + 0.02);
    o2.frequency.setValueAtTime(prev * 1.004, t);
    o2.frequency.exponentialRampToValueAtTime(freq * 1.004, t + 0.02);

    const flt = ac.createBiquadFilter();
    flt.type = 'lowpass';
    flt.Q.value = 1;
    flt.frequency.setValueAtTime(3500, t);
    flt.frequency.exponentialRampToValueAtTime(3000, t + spd + 0.2);

    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(VOLUME, t + 0.015);
    g.gain.setValueAtTime(VOLUME, t + spd * 0.4);
    g.gain.exponentialRampToValueAtTime(0.001, t + spd + 0.2);

    const mx = ac.createGain();
    mx.gain.value = 0.5;
    o1.connect(mx);
    o2.connect(mx);
    mx.connect(flt);
    flt.connect(g).connect(ac.destination);
    g.connect(dly);
    o1.start(t);
    o1.stop(t + spd + 0.2 + 0.1);
    o2.start(t);
    o2.stop(t + spd + 0.2 + 0.1);
  });
}

export function playTaskCompleteSoundSubtle() {
  const ac = getContext();
  if (!ac) return;

  const t0 = ac.currentTime;
  const freq = 784; // G5
  const spd = 0.11;

  const o1 = ac.createOscillator();
  const o2 = ac.createOscillator();
  o1.type = o2.type = 'sine';
  o1.frequency.setValueAtTime(freq, t0);
  o2.frequency.setValueAtTime(freq * 1.004, t0);

  const flt = ac.createBiquadFilter();
  flt.type = 'lowpass';
  flt.Q.value = 1;
  flt.frequency.setValueAtTime(3500, t0);
  flt.frequency.exponentialRampToValueAtTime(3000, t0 + spd + 0.2);

  const g = ac.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(VOLUME, t0 + 0.015);
  g.gain.setValueAtTime(VOLUME, t0 + spd * 0.4);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + spd + 0.2);

  const mx = ac.createGain();
  mx.gain.value = 0.5;
  o1.connect(mx);
  o2.connect(mx);
  mx.connect(flt);
  flt.connect(g).connect(ac.destination);
  o1.start(t0);
  o1.stop(t0 + spd + 0.2 + 0.1);
  o2.start(t0);
  o2.stop(t0 + spd + 0.2 + 0.1);
}
