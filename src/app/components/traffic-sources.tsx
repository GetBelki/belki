import { Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import {
  TRAFFIC_LABELS,
  TRAFFIC_SOURCE_ALIASES,
  TRAFFIC_SOURCES,
  TrafficAliasValueSchema,
  trafficAliases,
  trafficSourceLabel,
  type TrafficAlias,
  type TrafficCustomSource,
} from "../../shared/traffic";
import { Button, Dialog, Input } from "./ui";

function sourceId(label: string, used: Set<string>) {
  const base = label.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || "custom-source";
  let id = base;
  for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
  return id;
}

export function TrafficSources({ customSources, aliases, disabled, onChange }: {
  customSources: TrafficCustomSource[];
  aliases: TrafficAlias[];
  disabled: boolean;
  onChange: (value: { customSources: TrafficCustomSource[]; aliases: TrafficAlias[] }) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newAlias, setNewAlias] = useState("");
  const [newError, setNewError] = useState<string | null>(null);
  const sources = [
    ...TRAFFIC_SOURCES.map((id) => ({ id, label: TRAFFIC_LABELS[id], builtIn: true })),
    ...customSources.map((source) => ({ ...source, builtIn: false })),
  ];
  const recognized = trafficAliases({ customSources, aliases });
  const addAlias = (source: string) => {
    const parsed = TrafficAliasValueSchema.safeParse(drafts[source]);
    if (!parsed.success) {
      setErrors({ ...errors, [source]: "Enter one exact UTM value, without a URL, wildcard or spaces." });
      return;
    }
    const owner = recognized[parsed.data];
    if (owner) {
      const label = trafficSourceLabel(owner, customSources);
      setErrors({ ...errors, [source]: owner === source ? `“${parsed.data}” is already recognized.` : `“${parsed.data}” already belongs to ${label}.` });
      return;
    }
    if (aliases.length >= 100) {
      setErrors({ ...errors, [source]: "You can add up to 100 custom UTM values." });
      return;
    }
    onChange({ customSources, aliases: [...aliases, { alias: parsed.data, source }] });
    setDrafts({ ...drafts, [source]: "" });
    setErrors({ ...errors, [source]: "" });
  };
  const addSource = () => {
    const label = newLabel.trim();
    const parsedAlias = TrafficAliasValueSchema.safeParse(newAlias);
    if (!label || label.length > 50) { setNewError("Enter a source name of up to 50 characters."); return; }
    if (!parsedAlias.success) { setNewError("Enter one exact UTM value, such as iask.ai or my-ai-source."); return; }
    if (sources.some((source) => source.label.toLowerCase() === label.toLowerCase())) { setNewError("A source with this name already exists."); return; }
    if (recognized[parsedAlias.data]) { setNewError(`“${parsedAlias.data}” is already recognized by another source.`); return; }
    if (customSources.length >= 20) { setNewError("You can add up to 20 custom sources."); return; }
    const id = sourceId(label, new Set([...sources.map((source) => source.id), ...Object.keys(recognized)]));
    if (parsedAlias.data !== id && aliases.length >= 100) { setNewError("Remove a custom UTM value before adding another source."); return; }
    const nextSources = [...customSources, { id, label }];
    const nextAliases = parsedAlias.data === id ? aliases : [...aliases, { alias: parsedAlias.data, source: id }];
    onChange({ customSources: nextSources, aliases: nextAliases });
    setNewLabel(""); setNewAlias(""); setNewError(null); setDialogOpen(false);
  };
  return <div className="traffic-sources-manager">
    <div className="traffic-sources-heading">
      <div><h3>Recognized sources</h3><p>Belki records exact, case-insensitive <code>utm_source</code> values. Add aliases to group campaign names and referral domains under the right source.</p></div>
      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setNewError(null); }} title="Add AI source"
        description="Create a source for traffic Belki does not recognize yet. Its first UTM value is required."
        contentClassName="traffic-source-dialog" trigger={<Button type="button" variant="secondary" disabled={disabled || customSources.length >= 20}><Plus size={15} aria-hidden="true" />Add source</Button>}>
        <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); addSource(); }}>
          <label>Source name<Input autoFocus disabled={disabled} value={newLabel} placeholder="iAsk" onChange={(event) => { setNewLabel(event.target.value); setNewError(null); }} /></label>
          <label>First UTM source<Input disabled={disabled} value={newAlias} placeholder="iask.ai" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => { setNewAlias(event.target.value); setNewError(null); }} /></label>
          <p>Use the exact value found after <code>utm_source=</code>. Don’t include <code>https://</code>, paths, wildcards or regex.</p>
          {newError ? <p className="traffic-source-error" role="alert">{newError}</p> : null}
          <div><Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>Cancel</Button><Button type="submit" disabled={disabled}>Add source</Button></div>
        </form>
      </Dialog>
    </div>
    <div className="traffic-source-list">
      {sources.map((source) => {
        const defaults = source.builtIn ? TRAFFIC_SOURCE_ALIASES[source.id as keyof typeof TRAFFIC_SOURCE_ALIASES] : [source.id];
        const added = aliases.filter((alias) => alias.source === source.id);
        return <section className="traffic-source-card" key={source.id} aria-labelledby={`traffic-source-${source.id}`}>
          <header><div><h4 id={`traffic-source-${source.id}`}>{source.label}</h4><span>{source.builtIn ? "Built-in" : "Custom source"}</span></div>
            {!source.builtIn ? <Button type="button" variant="ghost" aria-label={`Remove ${source.label}`} onClick={() => onChange({ customSources: customSources.filter(({ id }) => id !== source.id), aliases: aliases.filter((alias) => alias.source !== source.id) })}><Trash2 size={14} aria-hidden="true" />Remove</Button> : null}
          </header>
          <div className="traffic-source-values" aria-label={`${source.label} recognized UTM values`}>
            {defaults.map((value) => <span className="traffic-source-value traffic-source-value-default" key={value}>{value}</span>)}
            {added.map(({ alias }) => <span className="traffic-source-value" key={alias}>{alias}<button type="button" aria-label={`Remove ${alias} from ${source.label}`} onClick={() => onChange({ customSources, aliases: aliases.filter((value) => value.alias !== alias) })}><X size={13} aria-hidden="true" /></button></span>)}
          </div>
          <div className="traffic-source-alias-entry">
            <Input aria-label={`Add alias to ${source.label}`} value={drafts[source.id] ?? ""} placeholder="Add UTM value…" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              onChange={(event) => { setDrafts({ ...drafts, [source.id]: event.target.value }); setErrors({ ...errors, [source.id]: "" }); }}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addAlias(source.id); } }} />
            <Button type="button" variant="secondary" disabled={disabled || !(drafts[source.id] ?? "").trim()} onClick={() => addAlias(source.id)}><Plus size={14} aria-hidden="true" />Add alias</Button>
          </div>
          {errors[source.id] ? <p className="traffic-source-error" role="alert">{errors[source.id]}</p> : null}
        </section>;
      })}
    </div>
    <p className="traffic-sources-note">Built-in values are maintained by Belki. Custom aliases and sources apply only to this project after you save settings.</p>
  </div>;
}
