import { useEffect, useState } from "react";
import { formatDecisionMinutesLabel } from "@paperclipai/shared";
import { Input } from "./ui/input";

/**
 * Shows the stored minute label. The number input writes that same stored
 * integer back. A card with no stored number renders nothing, including no
 * zero.
 */
export function DecisionMinutesControl({
  minutes,
  editable = false,
  busy = false,
  errorMessage = null,
  onCommit,
}: {
  minutes: number | null;
  editable?: boolean;
  busy?: boolean;
  errorMessage?: string | null;
  onCommit?: (minutes: number) => void;
}) {
  const label = formatDecisionMinutesLabel(minutes);
  const [draft, setDraft] = useState(minutes == null ? "" : String(minutes));

  useEffect(() => {
    setDraft(minutes == null ? "" : String(minutes));
  }, [minutes]);

  if (!label || minutes == null) return null;

  const commit = () => {
    if (!editable || !onCommit || busy) return;
    const next = Number(draft);
    if (!Number.isInteger(next) || next < 1 || next > 30 || next === minutes) {
      setDraft(String(minutes));
      return;
    }
    onCommit(next);
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="decision-minutes">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {editable && onCommit ? (
        <Input
          type="number"
          min={1}
          max={30}
          step={1}
          inputMode="numeric"
          aria-label="Minuty"
          value={draft}
          disabled={busy}
          className="h-7 w-16 px-2 text-sm"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
      ) : null}
      {errorMessage ? <span className="text-xs text-destructive">{errorMessage}</span> : null}
    </div>
  );
}
