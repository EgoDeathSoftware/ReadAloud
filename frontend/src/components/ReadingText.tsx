import { useEffect, useRef } from "react";
import type { Cue } from "src/api/types.ts";

interface ReadingTextProps {
  cues: Cue[];
  activeCueIndex: number | null;
}

export function ReadingText({ cues, activeCueIndex }: ReadingTextProps) {
  const activeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeCueIndex]);

  return (
    <div className="reading-text">
      {cues.map((cue, index) => (
        <span
          key={index}
          ref={index === activeCueIndex ? activeRef : null}
          className={
            index === activeCueIndex
              ? "reading-text__sentence reading-text__sentence--active"
              : "reading-text__sentence"
          }
        >
          {cue.text}{" "}
        </span>
      ))}
    </div>
  );
}
