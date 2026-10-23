// One call-recording player for every screen (Call Log, Reports, the agent's
// call log, customer history). Our own controls instead of the browser's:
// the elapsed time / length always run (from the audio's own clock), with a
// seek bar and 1x / 1.5x / 2x speed. When the browser can't tell the length
// (some MP3s, a recording still being written) it falls back to what the
// server knows (`seconds`) or to the downloaded part. A missing file says
// so instead of sitting at 0:00.
import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, Pause, Play, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const SPEEDS = [1, 1.5, 2];

/** 75 -> "1:15", 3725 -> "1:02:05". */
export function clock(total: number) {
  const s = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  const p = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

export function RecordingPlayer({
  src,
  label,
  seconds = null,
  autoPlay = true,
  downloadUrl,
  onClose,
  className,
}: {
  src: string;
  /** e.g. "Recording of call 71" - also the audio element's label. */
  label: string;
  /** The length the server knows (talk time), used until / unless the file tells. */
  seconds?: number | null;
  autoPlay?: boolean;
  downloadUrl?: string;
  onClose?: () => void;
  className?: string;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(autoPlay);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // The length: the file's own, else the downloaded part, else the server's.
  function readLength(a: HTMLAudioElement) {
    if (Number.isFinite(a.duration) && a.duration > 0) return a.duration;
    if (a.seekable.length) {
      const end = a.seekable.end(a.seekable.length - 1);
      if (Number.isFinite(end) && end > 0) return end;
    }
    return null;
  }

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    const onTime = () => {
      setTime(a.currentTime);
      setLength(readLength(a));
    };
    const onMeta = () => {
      setLength(readLength(a));
      setLoading(false);
    };
    const onPlay = () => {
      setPlaying(true);
      setLoading(false);
    };
    const onPause = () => setPlaying(false);
    const onWait = () => setLoading(true);
    const onReady = () => setLoading(false);
    const onEnded = () => {
      setPlaying(false);
      setTime(readLength(a) ?? a.currentTime);
    };
    const onError = () => {
      setLoading(false);
      setPlaying(false);
      setError("Couldn't play this recording - it may have been removed (kept for a limited time).");
      // The audio element hides the server's reason (e.g. "on the telephony
      // server - set an S3 bucket"); ask once more and show it when there is one.
      const url = a.getAttribute('src');
      if (url && typeof fetch === 'function')
        fetch(url, { credentials: 'same-origin' })
          .then((r) => (r.ok ? null : r.json()))
          .then((body: { error?: unknown } | null) => {
            if (body && typeof body.error === 'string') setError(`Couldn't play this recording - ${body.error}.`);
          })
          .catch(() => {});
    };
    const events: [string, () => void][] = [
      ['timeupdate', onTime],
      ['durationchange', onMeta],
      ['loadedmetadata', onMeta],
      ['progress', onTime],
      ['play', onPlay],
      ['playing', onReady],
      ['pause', onPause],
      ['waiting', onWait],
      ['canplay', onReady],
      ['ended', onEnded],
      ['error', onError],
    ];
    for (const [e, fn] of events) a.addEventListener(e, fn);
    return () => {
      for (const [e, fn] of events) a.removeEventListener(e, fn);
    };
  }, []);

  useEffect(() => {
    const a = audio.current;
    if (!a || !autoPlay) return;
    a.play()?.catch(() => setLoading(false)); // autoplay blocked: the Play button still works
  }, [autoPlay]);

  function toggle() {
    const a = audio.current;
    if (!a || error) return;
    if (a.paused) {
      if (a.ended) a.currentTime = 0;
      setLoading(true);
      a.play()?.catch(() => setLoading(false));
    } else a.pause();
  }
  function seek(to: number) {
    const a = audio.current;
    if (!a) return;
    a.currentTime = to;
    setTime(to);
  }
  function nextSpeed() {
    const s = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(s);
    if (audio.current) audio.current.playbackRate = s;
  }

  const total = length ?? (seconds && seconds > 0 ? seconds : null);
  return (
    <div className={cn('flex w-full max-w-xl flex-col gap-1', className)}>
      <div className="flex items-center gap-2 rounded-md border bg-card px-2 py-1">
        <audio ref={audio} src={src} preload="metadata" aria-label={label} />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={toggle}
          disabled={!!error}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {loading && !error ? <LoaderCircle className="animate-spin" /> : playing ? <Pause /> : <Play />}
        </Button>
        <span className="shrink-0 text-xs tabular-nums" aria-label="Elapsed">
          {clock(time)}
        </span>
        <input
          type="range"
          min={0}
          max={total ?? 0}
          step={0.1}
          value={Math.min(time, total ?? time)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!total || !!error}
          aria-label="Position"
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-default"
        />
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" aria-label="Length">
          {total ? clock(total) : '--:--'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-1.5 text-xs tabular-nums"
          onClick={nextSpeed}
          aria-label={`Speed ${speed}x`}
          title="Playback speed"
        >
          {speed}x
        </Button>
        {downloadUrl && (
          <Button variant="ghost" size="icon" className="size-7 shrink-0" asChild>
            <a href={downloadUrl} download aria-label="Download recording" title="Download">
              <Download />
            </a>
          </Button>
        )}
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={onClose}
            aria-label="Close player"
          >
            <X />
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
