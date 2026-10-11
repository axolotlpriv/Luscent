let ctx: AudioContext | null = null;

/** Shared AudioContext (created lazily; resumed on the first user gesture). */
export function getAudioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

export async function resumeAudio(): Promise<void> {
  const c = getAudioContext();
  if (c.state !== 'running') await c.resume().catch(() => undefined);
}

export function dbToGain(db: number): number {
  return db <= -60 ? 0 : Math.pow(10, db / 20);
}
