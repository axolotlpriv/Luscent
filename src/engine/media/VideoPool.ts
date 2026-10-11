/**
 * Video decoding for preview.
 *
 * Each on-screen video instance gets its own muted HTMLVideoElement (hardware
 * decode, cheap to run in real time). While playing, elements free-run and are
 * nudged back in sync with the transport clock; while paused, scrubbing issues
 * coalesced seeks and asks for a redraw when a seek lands.
 *
 * Frame-exact random access (needed for export and optical-flow effects) will
 * be served by a WebCodecs decoder behind the same `frame()` interface.
 */
import type { Id } from '../../core/model/types';
import type { MediaEngine } from './MediaEngine';

export interface VideoRequest {
  key: string;
  mediaId: Id;
  /** Seconds into the source. */
  time: number;
  /** Source playback speed (time remap derivative); 1 = realtime. */
  speed?: number;
}

interface Slot {
  el: HTMLVideoElement;
  mediaId: Id;
  seeking: boolean;
  /** Latest requested time while a seek is in flight. */
  wanted: number | null;
  /** Target of the seek currently in flight. */
  inflight: number;
  lastUsed: number;
}

const SEEK_TOLERANCE = 1 / 120;
const PLAY_DRIFT_HARD = 0.2;

export class VideoPool {
  private slots = new Map<string, Slot>();

  constructor(
    private readonly media: MediaEngine,
    private readonly onFrame: () => void,
    /** Whether preview should play proxies when available. */
    private readonly useProxies: () => boolean = () => false,
  ) {}

  private create(key: string, mediaId: Id): Slot | null {
    const url = this.media.playbackUrl(mediaId, this.useProxies());
    if (!url) return null;
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.src = url;
    const slot: Slot = { el, mediaId, seeking: false, wanted: null, inflight: 0, lastUsed: performance.now() };
    el.addEventListener('seeked', () => {
      slot.seeking = false;
      if (slot.wanted !== null && Math.abs(slot.wanted - el.currentTime) > SEEK_TOLERANCE) {
        const w = slot.wanted;
        slot.wanted = null;
        this.seek(slot, w);
      } else {
        slot.wanted = null;
      }
      this.onFrame();
    });
    el.addEventListener('loadeddata', () => this.onFrame());
    this.slots.set(key, slot);
    return slot;
  }

  private seek(slot: Slot, t: number): void {
    if (slot.seeking) {
      slot.wanted = t;
      return;
    }
    slot.seeking = true;
    slot.inflight = t;
    slot.el.currentTime = t;
  }

  /** Bring elements in line with the requested instances for this frame. */
  sync(requests: VideoRequest[], playing: boolean): void {
    const now = performance.now();
    const active = new Set<string>();
    for (const r of requests) {
      active.add(r.key);
      let slot = this.slots.get(r.key);
      if (slot && slot.mediaId !== r.mediaId) {
        this.dispose(r.key);
        slot = undefined;
      }
      slot ??= this.create(r.key, r.mediaId) ?? undefined;
      if (!slot) continue;
      slot.lastUsed = now;
      const el = slot.el;
      const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
      const t = Math.min(Math.max(0, r.time), Math.max(0, dur - 0.001));
      const speed = r.speed ?? 1;
      // Very slow, frozen or reversed sources can't free-run: seek per frame.
      const freeRun = speed >= 0.0625 && speed <= 16;
      if (playing && freeRun) {
        if (el.paused) {
          if (Math.abs(el.currentTime - t) > SEEK_TOLERANCE) el.currentTime = t;
          el.play().catch(() => undefined);
        } else {
          const drift = el.currentTime - t;
          if (Math.abs(drift) > PLAY_DRIFT_HARD * Math.max(1, speed)) {
            el.currentTime = t;
            el.playbackRate = speed;
          } else {
            // Gently steer instead of hard seeking (avoids visible hitches).
            el.playbackRate = Math.max(0.0625, speed * (1 - Math.max(-0.08, Math.min(0.08, drift * 2))));
          }
        }
      } else {
        if (!el.paused) el.pause();
        el.playbackRate = 1;
        // Where the element will end up once in-flight seeks settle.
        const settled = slot.seeking ? (slot.wanted ?? slot.inflight) : el.currentTime;
        if (Math.abs(settled - t) > SEEK_TOLERANCE) this.seek(slot, t);
      }
    }
    for (const [key, slot] of this.slots) {
      if (active.has(key)) continue;
      if (!slot.el.paused) slot.el.pause();
      // Keep recently used elements warm for fast re-entry; drop stale ones.
      if (now - slot.lastUsed > 20000) this.dispose(key);
    }
  }

  /** Element if it has a decoded frame to show. */
  frame(key: string): HTMLVideoElement | null {
    const s = this.slots.get(key);
    if (!s || s.el.readyState < 2) return null;
    return s.el;
  }

  /** True while any active element is still seeking (frame may be stale). */
  get busy(): boolean {
    for (const s of this.slots.values()) if (s.seeking) return true;
    return false;
  }

  dispose(key: string): void {
    const s = this.slots.get(key);
    if (!s) return;
    s.el.pause();
    s.el.removeAttribute('src');
    s.el.load();
    this.slots.delete(key);
  }

  disposeAll(): void {
    for (const k of [...this.slots.keys()]) this.dispose(k);
  }
}
