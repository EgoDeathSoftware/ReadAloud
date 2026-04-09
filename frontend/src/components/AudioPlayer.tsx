import { useEffect, useRef, useState } from "react";

interface AudioPlayerProps {
  audioUrl: string | null;
}

const SPEED_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

export function AudioPlayer({ audioUrl }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playbackRate, setPlaybackRate] = useState(1.0);

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

  return (
    <div className="audio-player">
      <audio
        ref={audioRef}
        className="audio-player__element"
        controls
        src={audioUrl}
      />
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
