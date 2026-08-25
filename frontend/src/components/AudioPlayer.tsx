import { useEffect, useRef, useState } from "react";

interface AudioPlayerProps {
  audioUrl: string | null;
}

const SPEED_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
const SKIP_SECONDS = 15;

export function AudioPlayer({ audioUrl }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (audioUrl && audioRef.current) {
      audioRef.current.load();
      audioRef.current.play().catch(() => {
        // Autoplay may be blocked by browser policy
      });
    }
  }, [audioUrl]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  if (audioUrl === null) return null;

  const skip = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.min(
      Math.max(audio.currentTime + seconds, 0),
      audio.duration || Infinity,
    );
  };

  const togglePlayStop = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      audio.currentTime = 0;
    } else {
      audio.play().catch(() => {
        // Autoplay may be blocked by browser policy
      });
    }
  };

  return (
    <div className="audio-player">
      <audio
        ref={audioRef}
        className="audio-player__element"
        controls
        src={audioUrl}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      />
      <div className="audio-player__transport">
        <button
          className="audio-player__transport-btn"
          onClick={() => skip(-SKIP_SECONDS)}
          aria-label={`Rewind ${SKIP_SECONDS} seconds`}
          title={`Rewind ${SKIP_SECONDS}s`}
        >
          «{SKIP_SECONDS}
        </button>
        <button
          className="audio-player__transport-btn audio-player__transport-btn--primary"
          onClick={togglePlayStop}
          aria-label={isPlaying ? "Stop" : "Play"}
          title={isPlaying ? "Stop" : "Play"}
        >
          {isPlaying ? "■" : "▶"}
        </button>
        <button
          className="audio-player__transport-btn"
          onClick={() => skip(SKIP_SECONDS)}
          aria-label={`Fast forward ${SKIP_SECONDS} seconds`}
          title={`Forward ${SKIP_SECONDS}s`}
        >
          {SKIP_SECONDS}»
        </button>
      </div>
      <div className="audio-player__speed">
        <span className="audio-player__speed-label">Speed</span>
        <div className="audio-player__speed-steps">
          {SPEED_STEPS.map((step) => (
            <button
              key={step}
              className={`audio-player__speed-btn${playbackRate === step ? " audio-player__speed-btn--active" : ""}`}
              onClick={() => setPlaybackRate(step)}
            >
              {step === 1.0 ? "1×" : `${step}×`}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
