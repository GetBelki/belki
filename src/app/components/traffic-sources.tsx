import { Pencil, Plus, Trash2, X } from "lucide-react";
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
  const [editingSource, setEditingSource] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
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
    const parsed = TrafficAliasValueSchema.safeParse(editDraft);
    if (!parsed.success) {
      setEditError("Enter one exact UTM value, without a URL, wildcard or spaces.");
      return;
    }
    const owner = recognized[parsed.data];
    if (owner) {
      const label = trafficSourceLabel(owner, customSources);
      setEditError(owner === source ? `“${parsed.data}” is already recognized.` : `“${parsed.data}” already belongs to ${label}.`);
      return;
    }
    if (aliases.length >= 100) {
      setEditError("You can add up to 100 custom UTM values.");
      return;
    }
    onChange({ customSources, aliases: [...aliases, { alias: parsed.data, source }] });
    setEditDraft("");
    setEditError(null);
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
  const selectedSource = sources.find((source) => source.id === editingSource);
  const closeEditor = () => {
    setEditingSource(null);
    setEditDraft("");
    setEditError(null);
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
    <div className="traffic-source-count">{sources.length} sources</div>
    <ul className="traffic-source-list">
      {sources.map((source) => {
        const defaults = source.builtIn ? TRAFFIC_SOURCE_ALIASES[source.id as keyof typeof TRAFFIC_SOURCE_ALIASES] : [source.id];
        const added = aliases.filter((alias) => alias.source === source.id);
        const total = defaults.length + added.length;
        return <li className="traffic-source-row" key={source.id} aria-label={source.label}>
          <div className="traffic-source-row-copy">
            <div><h4>{source.label}</h4><span>{source.builtIn ? "Built-in" : "Custom source"}</span></div>
            <p>{total} recognized {total === 1 ? "value" : "values"}{added.length ? ` · ${added.length} project ${added.length === 1 ? "alias" : "aliases"}` : ""}</p>
          </div>
          <Button type="button" variant="secondary" aria-label={`Edit ${source.label}`} disabled={disabled} onClick={() => { setEditingSource(source.id); setEditDraft(""); setEditError(null); }}><Pencil size={14} aria-hidden="true" />Edit</Button>
        </li>;
      })}
    </ul>
    {selectedSource ? <Dialog open onOpenChange={(open) => { if (!open) closeEditor(); }} title={`Edit ${selectedSource.label}`}
      description={`${selectedSource.builtIn ? "Built-in" : "Custom"} source. Matching is exact and case-insensitive.`}
      contentClassName="traffic-source-dialog traffic-source-edit-dialog">
      <div className="traffic-source-edit-body">
        <section>
          <div className="traffic-source-edit-heading"><h4>Recognized UTM values</h4><span>{(selectedSource.builtIn ? TRAFFIC_SOURCE_ALIASES[selectedSource.id as keyof typeof TRAFFIC_SOURCE_ALIASES].length : 1) + aliases.filter((alias) => alias.source === selectedSource.id).length}</span></div>
          <div className="traffic-source-values" aria-label={`${selectedSource.label} recognized UTM values`}>
            {(selectedSource.builtIn ? TRAFFIC_SOURCE_ALIASES[selectedSource.id as keyof typeof TRAFFIC_SOURCE_ALIASES] : [selectedSource.id]).map((value) => <span className="traffic-source-value traffic-source-value-default" key={value}>{value}</span>)}
            {aliases.filter((alias) => alias.source === selectedSource.id).map(({ alias }) => <span className="traffic-source-value" key={alias}>{alias}<button type="button" disabled={disabled} aria-label={`Remove ${alias} from ${selectedSource.label}`} onClick={() => onChange({ customSources, aliases: aliases.filter((value) => value.alias !== alias) })}><X size={13} aria-hidden="true" /></button></span>)}
          </div>
        </section>
        <section>
          <label htmlFor={`traffic-source-alias-${selectedSource.id}`}>Add a UTM value</label>
          <div className="traffic-source-alias-entry">
            <Input id={`traffic-source-alias-${selectedSource.id}`} value={editDraft} placeholder="my-ai-campaign" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              onChange={(event) => { setEditDraft(event.target.value); setEditError(null); }}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addAlias(selectedSource.id); } }} />
            <Button type="button" variant="secondary" disabled={disabled || !editDraft.trim()} onClick={() => addAlias(selectedSource.id)}><Plus size={14} aria-hidden="true" />Add alias</Button>
          </div>
          <p>Use the exact value found after <code>utm_source=</code>.</p>
          {editError ? <p className="traffic-source-error" role="alert">{editError}</p> : null}
        </section>
        <div className={`traffic-source-edit-actions${selectedSource.builtIn ? " traffic-source-edit-actions-single" : ""}`}>
          {!selectedSource.builtIn ? <Button type="button" variant="danger" disabled={disabled} onClick={() => { onChange({ customSources: customSources.filter(({ id }) => id !== selectedSource.id), aliases: aliases.filter((alias) => alias.source !== selectedSource.id) }); closeEditor(); }}><Trash2 size={14} aria-hidden="true" />Remove source</Button> : null}
          <Button type="button" onClick={closeEditor}>Done</Button>
        </div>
      </div>
    </Dialog> : null}
    <p className="traffic-sources-note">Built-in values are maintained by Belki. Custom aliases and sources apply only to this project after you save settings.</p>
  </div>;
}
