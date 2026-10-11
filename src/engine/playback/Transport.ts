/**
 * Playback transport: drives the playhead from the audio clock while
 * `playing` is true, loops the work area, and reschedules audio when the
 * project changes mid-playback.
 */
import { activeComp, editor, useEditor } from '../../state/store';
import { mediaEngine } from '../media/MediaEngine';
import { resumeAudio } from '../media/audioContext';
import { AudioEngine } from './AudioEngine';

export const audioEngine = new AudioEngine(mediaEngine);

let raf = 0;
let range: { start: number; end: number } = { start: 0, end: 0 };
let token = 0;

/** Where playback starts, where it wraps to, and where it ends. */
function playRange() {
  const s = editor();
  const comp = activeComp(s);
  const f = 1 / comp.fps;
  if (s.loop) {
    const { start, end } = comp.workArea;
    const inside = s.playhead >= start - f / 2 && s.playhead < end - f / 2;
    return { from: inside ? s.playhead : start, loopStart: start, end, loop: true };
  }
  return { from: s.playhead >= comp.duration - f ? 0 : s.playhead, loopStart: 0, end: comp.duration, loop: false };
}

async function start() {
  const my = ++token;
  await resumeAudio();
  if (my !== token || !editor().playing) return;
  const s = editor();
  const r = playRange();
  range = { start: r.loopStart, end: r.end };
  audioEngine.start(s.project, s.activeCompId, r.from, r.end);
  const loop = r.loop;
  const tick = () => {
    if (my !== token) return;
    const st = editor();
    let t = audioEngine.now();
    if (t >= range.end) {
      if (loop) {
        t = range.start;
        audioEngine.start(st.project, st.activeCompId, t, range.end);
      } else {
        useEditor.setState({ playing: false });
        st.setPlayhead(range.end - 1 / activeComp(st).fps);
        return;
      }
    }
    useEditor.setState({ playhead: t });
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function stop() {
  token++;
  cancelAnimationFrame(raf);
  audioEngine.stop();
}

let installed = false;

export function installTransport(): void {
  if (installed) return;
  installed = true;
  useEditor.subscribe((s, prev) => {
    if (s.playing && !prev.playing) void start();
    else if (!s.playing && prev.playing) stop();
    else if (s.playing && s.activeCompId !== prev.activeCompId) {
      stop();
      useEditor.setState({ playing: false });
    } else if (s.playing && s.project !== prev.project) {
      // Edits while playing: reschedule audio from the current position.
      audioEngine.start(s.project, s.activeCompId, audioEngine.now(), range.end);
    }
  });
}

/** Audible feedback while dragging the playhead. */
export function scrubAudio(t: number): void {
  const s = editor();
  if (s.playing) return;
  void resumeAudio().then(() => audioEngine.scrub(s.project, s.activeCompId, t));
}
