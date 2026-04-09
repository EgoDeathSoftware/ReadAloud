interface GenerationProgressProps {
  progress: number;
  chunksCompleted: number;
  chunksTotal: number;
  visible: boolean;
}

export function GenerationProgress({
  progress,
  chunksCompleted,
  chunksTotal,
  visible,
}: GenerationProgressProps) {
  if (!visible) return null;

  const percent = Math.round(progress * 100);

  return (
    <div className="generation-progress">
      <div className="generation-progress__bar-track">
        <div
          className="generation-progress__bar-fill"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="generation-progress__text">
        Generating... {chunksCompleted}/{chunksTotal} chunks
      </div>
    </div>
  );
}
