import { useEffect, useMemo, useRef, useState } from 'react';
import { EXPORT_PRESETS, estimateBytes, frameCount, outputSize, settingsFromPreset, videoCodecCandidates, type ExportSettings } from '../../core/export/settings';
import { formatTimecode } from '../../core/time';
import { ExportCancelled, exportComposition, type ExportProgress, type ExportResult } from '../../engine/export/Exporter';
import { mediaEngine } from '../../engine/media/MediaEngine';
import { activeComp, editor, useEditor } from '../../state/store';
import { downloadBlob } from '../download';

const fmtBytes = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const comp = useEditor(activeComp);
  const project = useEditor((s) => s.project);
  const [presetId, setPresetId] = useState(comp.height > comp.width ? 'social-1080-30' : 'source');
  const [range, setRange] = useState<'work' | 'comp'>('work');
  const [settings, setSettings] = useState<ExportSettings>(() => settingsFromPreset(EXPORT_PRESETS.find((p) => p.id === presetId)!, comp, range));
  const [support, setSupport] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    setSettings(settingsFromPreset(EXPORT_PRESETS.find((p) => p.id === presetId)!, comp, range));
  }, [presetId, range, comp]);

  // Check codec support for the chosen settings.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (settings.format === 'gif') return setSupport('GIF encoder (built-in)');
      if (typeof VideoEncoder === 'undefined') return setSupport('✕ WebCodecs is not available in this browser');
      for (const codec of videoCodecCandidates(settings.format, settings.width, settings.height, settings.fps)) {
        const r = await VideoEncoder.isConfigSupported({ codec, width: settings.width, height: settings.height, bitrate: settings.videoBitrate, framerate: settings.fps }).catch(() => null);
        if (r?.supported) {
          const note = settings.format === 'mp4' && codec.startsWith('vp09') ? ' (no H.264 encoder in this browser — MP4 will contain VP9)' : '';
          if (alive) setSupport(`✓ ${codec}${note}`);
          return;
        }
      }
      if (alive) setSupport(`✕ no ${settings.format === 'mp4' ? 'H.264' : 'VP9'} encoder for this size/frame rate`);
    })();
    return () => {
      alive = false;
    };
  }, [settings.format, settings.width, settings.height, settings.fps, settings.videoBitrate]);

  const frames = frameCount(settings);
  const est = useMemo(() => estimateBytes(settings), [settings]);
  const running = !!progress && !result && !error;

  const start = async () => {
    setError(null);
    setResult(null);
    const ac = new AbortController();
    abort.current = ac;
    if (editor().playing) editor().pause();
    try {
      const r = await exportComposition(project, comp.id, { ...settings, flowEngine: editor().flowEngine }, mediaEngine, setProgress, ac.signal);
      setResult(r);
      downloadBlob(`${comp.name.replace(/[^\w\- ]+/g, '').trim() || 'luscent'}.${r.extension}`, r.blob);
    } catch (err) {
      if (err instanceof ExportCancelled) {
        setProgress(null);
        editor().toast('Export cancelled');
      } else setError((err as Error).message);
    }
  };

  const setSize = (shortSide: number | null) => setSettings({ ...settings, ...outputSize(comp, shortSide) });

  return (
    <div className="modal-bg" onClick={() => !running && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <h2>Export “{comp.name}”</h2>
        <div className="export-presets">
          {EXPORT_PRESETS.map((p) => (
            <label key={p.id} className={'export-preset' + (presetId === p.id ? ' on' : '')}>
              <input type="radio" name="preset" checked={presetId === p.id} onChange={() => setPresetId(p.id)} disabled={running} />
              <div>
                <div>{p.label}</div>
                <div className="hint">{p.hint}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="export-grid">
          <div className="field">
            <label>Range</label>
            <select value={range} onChange={(e) => setRange(e.target.value as 'work' | 'comp')} disabled={running}>
              <option value="work">
                Work area ({formatTimecode(comp.workArea.start, comp.fps)} – {formatTimecode(comp.workArea.end, comp.fps)})
              </option>
              <option value="comp">Whole composition ({formatTimecode(comp.duration, comp.fps)})</option>
            </select>
          </div>
          <div className="field">
            <label>Size</label>
            <div className="row">
              <select value="" onChange={(e) => setSize(e.target.value === 'comp' ? null : Number(e.target.value))} disabled={running} style={{ width: 120 }}>
                <option value="">
                  {settings.width}×{settings.height}
                </option>
                <option value="comp">Comp size</option>
                <option value={480}>480p</option>
                <option value={720}>720p</option>
                <option value={1080}>1080p</option>
                <option value={1440}>1440p</option>
                <option value={2160}>2160p (4K)</option>
              </select>
            </div>
          </div>
          {settings.format !== 'gif' ? (
            <>
              <div className="field">
                <label>Frame rate</label>
                <select value={settings.fps} onChange={(e) => setSettings({ ...settings, fps: Number(e.target.value) })} disabled={running}>
                  {[24, 25, 30, 50, 60].map((f) => (
                    <option key={f} value={f}>
                      {f} fps
                    </option>
                  ))}
                  {![24, 25, 30, 50, 60].includes(settings.fps) && <option value={settings.fps}>{settings.fps} fps</option>}
                </select>
              </div>
              <div className="field">
                <label>Bitrate</label>
                <select value={settings.videoBitrate} onChange={(e) => setSettings({ ...settings, videoBitrate: Number(e.target.value) })} disabled={running}>
                  {[4, 8, 12, 16, 20, 30, 45, 60, 80].map((m) => (
                    <option key={m} value={m * 1e6}>
                      {m} Mbps
                    </option>
                  ))}
                  {![4, 8, 12, 16, 20, 30, 45, 60, 80].includes(settings.videoBitrate / 1e6) && <option value={settings.videoBitrate}>{settings.videoBitrate / 1e6} Mbps</option>}
                </select>
              </div>
              <div className="field">
                <label>Audio</label>
                <label className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={settings.audio} onChange={(e) => setSettings({ ...settings, audio: e.target.checked })} disabled={running} />
                  <span className="hint">{settings.format === 'mp4' ? 'AAC (Opus fallback)' : 'Opus'} · 48 kHz stereo</span>
                </label>
              </div>
            </>
          ) : (
            <div className="field">
              <label>GIF</label>
              <div className="row">
                <select value={settings.fps} onChange={(e) => setSettings({ ...settings, fps: Number(e.target.value) })} disabled={running}>
                  {[10, 12, 15, 20, 24, 30].map((f) => (
                    <option key={f} value={f}>
                      {f} fps
                    </option>
                  ))}
                </select>
                <select value={settings.gifColors} onChange={(e) => setSettings({ ...settings, gifColors: Number(e.target.value) })} disabled={running}>
                  {[32, 64, 128, 256].map((c) => (
                    <option key={c} value={c}>
                      {c} colours
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
        <div className="hint" style={{ margin: '8px 0' }}>
          {settings.format.toUpperCase()} · {settings.width}×{settings.height} · {settings.fps} fps · {frames} frames · ~{fmtBytes(est)} · {support ?? 'checking encoder…'}
        </div>
        {progress && (
          <div className="export-progress">
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
            </div>
            <div className="hint">
              {progress.phase === 'video' ? `Rendering frame ${progress.frame} / ${progress.frames}` : progress.phase === 'audio' ? 'Encoding audio' : progress.phase === 'finishing' ? 'Finishing file' : 'Preparing'} ·{' '}
              {Math.round(progress.progress * 100)}%{progress.etaSeconds !== null && !result ? ` · ~${Math.ceil(progress.etaSeconds)}s left` : ''}
            </div>
          </div>
        )}
        {result && (
          <div style={{ color: 'var(--ok)', marginTop: 8 }}>
            Done in {result.seconds.toFixed(1)}s · {fmtBytes(result.blob.size)} · {result.videoCodec}
            {result.audioCodec ? ` + ${result.audioCodec}` : ''}.{' '}
            <a
              href="#"
              style={{ color: 'var(--accent-2)' }}
              onClick={(e) => {
                e.preventDefault();
                downloadBlob(`${comp.name || 'luscent'}.${result.extension}`, result.blob);
              }}
            >
              Download again
            </a>
          </div>
        )}
        {error && <div style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          {running ? (
            <button onClick={() => abort.current?.abort()}>Cancel</button>
          ) : (
            <>
              <button onClick={onClose}>Close</button>
              <button className="primary" disabled={!!support?.startsWith('✕')} onClick={start}>
                Export
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
