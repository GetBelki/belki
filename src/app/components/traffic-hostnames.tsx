import { Plus, X } from "lucide-react";
import { useId, useRef } from "react";
import { Button } from "./ui";

export function TrafficHostnames({ domains, draft, error, onDraftChange, onAdd, onRemove }: {
  domains: string[];
  draft: string;
  error: string | null;
  onDraftChange: (value: string) => void;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  return <div className="traffic-hostnames">
    <div className="traffic-hostnames-heading">
      <label htmlFor={id}>Authorized hostnames</label>
      <span aria-live="polite">{domains.length} / 20</span>
    </div>
    <div className="traffic-hostnames-control" data-invalid={Boolean(error)}>
      {domains.length ? <ul className="traffic-hostname-tags" aria-label="Added hostnames">
        {domains.map((domain) => <li key={domain}>
          <span>{domain}</span>
          <button type="button" aria-label={`Remove ${domain}`} onClick={() => { onRemove(domain); input.current?.focus(); }}><X size={14} aria-hidden="true" /></button>
        </li>)}
      </ul> : null}
      <div className="traffic-hostname-entry">
        <input ref={input} id={id} className="traffic-hostname-draft" value={draft} placeholder="Add a hostname…" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          aria-invalid={Boolean(error)} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
          onChange={(event) => { const value = event.target.value; if (value.includes(",")) onAdd(value); else onDraftChange(value); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" || event.key === ",") { event.preventDefault(); if (draft.trim()) onAdd(draft); }
            const last = domains.at(-1);
            if (event.key === "Backspace" && !draft && last) { event.preventDefault(); onRemove(last); }
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (!/[\s,]/.test(text)) return;
            event.preventDefault();
            const field = event.currentTarget;
            onAdd(draft.slice(0, field.selectionStart ?? draft.length) + text + draft.slice(field.selectionEnd ?? draft.length));
          }} />
        <Button type="button" variant="ghost" disabled={!draft.trim()} onClick={() => { onAdd(draft); input.current?.focus(); }}><Plus size={14} aria-hidden="true" />Add</Button>
      </div>
    </div>
    <p id={`${id}-hint`}>Press Enter or comma to add, or paste a list. Include each subdomain, without https:// or a path.</p>
    {error ? <p className="traffic-hostnames-error" id={`${id}-error`} role="alert">{error}</p> : null}
  </div>;
}
