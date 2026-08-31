import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Search,
} from "lucide-react";
import {
  useMemo,
  useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { NoProject, PageHeader } from "../components/layout";
import {
  TagChip,
  TagPicker,
  tagForName,
  type PromptTag,
} from "../components/prompt-tags";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Label,
  Select,
  Skeleton,
} from "../components/ui";
import { useApp } from "../context";
import { api, post } from "../lib/api";
import {
  LOCATION_OPTIONS,
  languagesForLocation,
  localeEntry,
} from "../lib/locale-catalog";
import {
  PROMPT_LIBRARY,
  PROMPT_LIBRARY_GROUPS,
  renderPromptTemplate,
  unresolvedPromptPlaceholders,
  type PromptLibraryTemplate,
} from "../lib/prompt-library";
import {
  MAX_PROMPT_TAGS,
  promptTagKey,
  uniquePromptTagNames,
} from "../../shared/prompt-tags";

interface ProjectBrand {
  id: string;
  kind: "owned" | "competitor";
  name: string;
  aliases: string[];
  domains: string[];
}

interface ProjectDetail {
  project: {
    id: string;
    name: string;
    primary_domain: string | null;
  };
  brands: ProjectBrand[];
}

interface PromptDraft {
  templateId: string;
  queryText: string;
  tags: string[];
}

interface CreatePromptsResult {
  ids: string[];
  createdCount: number;
  skippedCount: number;
}

type DialogStep = "configure" | "review" | "success";

const DEFAULT_LOCATION = "2840";
const DEFAULT_LANGUAGE = "en";

function toggleName(
  values: string[],
  name: string,
  selected: boolean,
): string[] {
  return selected
    ? uniquePromptTagNames([...values, name])
    : values.filter((value) => promptTagKey(value) !== promptTagKey(name));
}

function TemplateText({
  text,
  values,
}: {
  text: string;
  values: Record<string, string>;
}) {
  const rendered = renderPromptTemplate(text, values);
  const parts = rendered.split(/(\{[a-z0-9_]+\})/giu);
  return (
    <>
      {parts.map((part, index) =>
        /^\{[a-z0-9_]+\}$/iu.test(part) ? (
          <mark className="prompt-library-placeholder" key={`${part}-${index}`}>
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

export default function PromptLibraryPage() {
  const { projectId, currentProject, session } = useApp();
  const canEdit = session.user.role !== "viewer";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("all");
  const [category, setCategory] = useState("all");
  const [availability, setAvailability] = useState("all");
  const [selection, setSelection] = useState<{
    projectId: string | null;
    ids: Set<string>;
  }>({ projectId: null, ids: new Set() });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogProjectId, setDialogProjectId] = useState<string | null>(null);
  const [dialogStep, setDialogStep] = useState<DialogStep>("configure");
  const [configurationIds, setConfigurationIds] = useState<string[]>([]);
  const [locationCode, setLocationCode] = useState(DEFAULT_LOCATION);
  const [languageCode, setLanguageCode] = useState(DEFAULT_LANGUAGE);
  const [cadence, setCadence] = useState<"daily" | "weekly">("daily");
  const [weekday, setWeekday] = useState("1");
  const [time, setTime] = useState("06:00");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [sharedTags, setSharedTags] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<PromptDraft[]>([]);
  const [error, setError] = useState("");
  const [creationResult, setCreationResult] =
    useState<CreatePromptsResult | null>(null);

  const details = useQuery({
    queryKey: ["project-detail", projectId],
    queryFn: () => api<ProjectDetail>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const tags = useQuery({
    queryKey: ["prompt-tags", projectId],
    queryFn: () => api<PromptTag[]>(`/projects/${projectId}/tags`),
    enabled: Boolean(projectId),
  });

  const ownedBrand =
    details.data?.brands.find((brand) => brand.kind === "owned")?.name ??
    currentProject?.name ??
    "";
  const countryName =
    localeEntry(Number(locationCode), languageCode)?.locationName ??
    localeEntry(Number(locationCode))?.locationName ??
    "";
  const automaticValues = useMemo(
    () => ({
      brand: ownedBrand,
      domain:
        details.data?.project.primary_domain ??
        currentProject?.primary_domain ??
        "",
      country: countryName,
    }),
    [
      countryName,
      currentProject?.primary_domain,
      details.data?.project.primary_domain,
      ownedBrand,
    ],
  );

  const categories = useMemo(
    () =>
      [...new Set(
        PROMPT_LIBRARY.filter(
          (template) => group === "all" || template.group === group,
        ).map((template) => template.category),
      )].sort((left, right) => left.localeCompare(right)),
    [group],
  );
  const activeCategory =
    category === "all" || categories.includes(category) ? category : "all";
  const selectedIds = useMemo(
    () =>
      selection.projectId === projectId ? selection.ids : new Set<string>(),
    [projectId, selection],
  );
  const setSelectedIds = (
    value: Set<string> | ((current: Set<string>) => Set<string>),
  ) => {
    setSelection((current) => {
      const currentIds =
        current.projectId === projectId ? current.ids : new Set<string>();
      return {
        projectId,
        ids: typeof value === "function" ? value(currentIds) : value,
      };
    });
  };

  const visibleTemplates = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return PROMPT_LIBRARY.filter((template) => {
      if (group !== "all" && template.group !== group) return false;
      if (activeCategory !== "all" && template.category !== activeCategory) {
        return false;
      }
      if (
        needle &&
        !`${template.text} ${template.category} ${template.group}`
          .toLocaleLowerCase()
          .includes(needle)
      ) {
        return false;
      }
      const ready =
        unresolvedPromptPlaceholders(
          renderPromptTemplate(template.text, automaticValues),
        ).length === 0;
      if (availability === "ready" && !ready) return false;
      if (availability === "needs-input" && ready) return false;
      return true;
    });
  }, [activeCategory, automaticValues, availability, group, search]);

  const selectedTemplates = useMemo(() => {
    const byId = new Map(PROMPT_LIBRARY.map((template) => [template.id, template]));
    return [...selectedIds]
      .map((id) => byId.get(id))
      .filter((template): template is PromptLibraryTemplate => Boolean(template));
  }, [selectedIds]);
  const configuredTemplates = useMemo(() => {
    const byId = new Map(PROMPT_LIBRARY.map((template) => [template.id, template]));
    return configurationIds
      .map((id) => byId.get(id))
      .filter((template): template is PromptLibraryTemplate => Boolean(template));
  }, [configurationIds]);
  const requiredVariables = useMemo(
    () =>
      [...new Set(configuredTemplates.flatMap((template) => template.placeholders))]
        .sort((left, right) => {
          const priority = ["brand", "domain", "country"];
          const leftIndex = priority.indexOf(left);
          const rightIndex = priority.indexOf(right);
          if (leftIndex !== -1 || rightIndex !== -1) {
            return (leftIndex === -1 ? 99 : leftIndex) -
              (rightIndex === -1 ? 99 : rightIndex);
          }
          return left.localeCompare(right);
        }),
    [configuredTemplates],
  );

  const createPrompts = useMutation({
    mutationFn: () =>
      post<CreatePromptsResult>(`/projects/${projectId}/queries/bulk`, {
        items: drafts.map((draft) => ({
          queryText: draft.queryText,
          tags: draft.tags,
        })),
        tags: [],
        locationCode: Number(locationCode),
        languageCode,
        forceWebSearch: true,
        schedule:
          cadence === "weekly"
            ? {
                cadence,
                weekday: Number(weekday),
                time,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              }
            : {
                cadence,
                time,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              },
      }),
    onSuccess: async (result) => {
      setCreationResult(result);
      setDialogStep("success");
      setSelectedIds(new Set());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["prompts", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-tags", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
    onError: (value: Error) => setError(value.message),
  });

  if (!projectId) return <NoProject />;

  const openConfiguration = (templates: PromptLibraryTemplate[]) => {
    if (!templates.length || !canEdit) return;
    setConfigurationIds(templates.slice(0, 50).map((template) => template.id));
    setDialogProjectId(projectId);
    setVariables({ ...automaticValues });
    setSharedTags([]);
    setDrafts([]);
    setCreationResult(null);
    setError("");
    setDialogStep("configure");
    setDialogOpen(true);
  };
  const toggleTemplate = (id: string, selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) {
        if (next.size < 50) next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };
  const continueToReview = () => {
    setError("");
    const missing = requiredVariables.filter((name) => !variables[name]?.trim());
    if (missing.length) {
      setError(
        `Complete ${missing.map((name) => `{${name}}`).join(", ")} before continuing.`,
      );
      return;
    }
    const nextDrafts = configuredTemplates.map((template) => ({
      templateId: template.id,
      queryText: renderPromptTemplate(template.text, variables).trim(),
      tags: uniquePromptTagNames([...sharedTags, template.suggestedTag]),
    }));
    if (nextDrafts.some((draft) => draft.tags.length > MAX_PROMPT_TAGS)) {
      setError(`Each prompt can have up to ${MAX_PROMPT_TAGS} tags.`);
      return;
    }
    if (nextDrafts.some((draft) => draft.queryText.length > 2_000)) {
      setError("Each generated prompt must be 2,000 characters or fewer.");
      return;
    }
    setDrafts(nextDrafts);
    setDialogStep("review");
  };
  const submitDrafts = () => {
    setError("");
    if (!drafts.length) {
      setError("Select at least one prompt.");
      return;
    }
    const invalidDraft = drafts.find(
      (draft) =>
        !draft.queryText.trim() ||
        draft.queryText.length > 2_000 ||
        unresolvedPromptPlaceholders(draft.queryText).length > 0,
    );
    if (invalidDraft) {
      setError(
        "Every prompt needs complete placeholder values and must be 2,000 characters or fewer.",
      );
      return;
    }
    createPrompts.mutate();
  };
  const availableLanguages = languagesForLocation(locationCode);

  return (
    <div className="page prompt-library-page">
      <Link className="back-link" to="/prompts">
        <ArrowLeft size={15} /> Prompts
      </Link>
      <PageHeader
        title="Prompt library"
        description="Use proven brand-reputation prompts as a starting point, then tailor them to your project."
        action={
          selectedTemplates.length ? (
            <Button
              disabled={!canEdit}
              onClick={() => openConfiguration(selectedTemplates)}
            >
              Use {selectedTemplates.length} selected
              <ChevronRight size={15} />
            </Button>
          ) : undefined
        }
        eyebrow="Resources"
      />
      {!canEdit ? (
        <div className="inline-note">
          Viewers can browse templates, but only editors and admins can add prompts.
        </div>
      ) : null}

      <div className="prompt-library-filters">
        <div className="search-filter">
          <Search size={15} />
          <Input
            aria-label="Search prompt templates"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search templates"
            value={search}
          />
        </div>
        <Select
          onValueChange={setGroup}
          options={[
            { value: "all", label: "All groups" },
            ...PROMPT_LIBRARY_GROUPS.map((value) => ({
              value,
              label: value,
            })),
          ]}
          value={group}
        />
        <Select
          onValueChange={setCategory}
          options={[
            { value: "all", label: "All categories" },
            ...categories.map((value) => ({ value, label: value })),
          ]}
          value={activeCategory}
        />
        <Select
          onValueChange={setAvailability}
          options={[
            { value: "all", label: "All templates" },
            { value: "ready", label: "Ready to use" },
            { value: "needs-input", label: "Needs more details" },
          ]}
          value={availability}
        />
      </div>

      <Card className="prompt-library-card">
        <div className="prompt-library-summary">
          <div>
            <strong>{visibleTemplates.length} templates</strong>
            <span>English library · category tags are suggested automatically</span>
          </div>
          <span>{selectedIds.size}/50 selected</span>
        </div>
        {details.isPending ? (
          <div className="prompt-library-loading">
            {Array.from({ length: 7 }, (_, index) => (
              <Skeleton key={index} />
            ))}
          </div>
        ) : visibleTemplates.length ? (
          <div className="prompt-library-list">
            {visibleTemplates.map((template) => {
              const selected = selectedIds.has(template.id);
              const unresolved = unresolvedPromptPlaceholders(
                renderPromptTemplate(template.text, automaticValues),
              );
              return (
                <article
                  className={`prompt-library-row${selected ? " selected" : ""}`}
                  key={template.id}
                >
                  <input
                    aria-label={`Select ${template.text}`}
                    checked={selected}
                    disabled={
                      !canEdit || (!selected && selectedIds.size >= 50)
                    }
                    onChange={(event) =>
                      toggleTemplate(template.id, event.target.checked)
                    }
                    type="checkbox"
                  />
                  <div className="prompt-library-row-content">
                    <p>
                      <TemplateText
                        text={template.text}
                        values={automaticValues}
                      />
                    </p>
                    <div className="prompt-library-row-meta">
                      <span>{template.group}</span>
                      <TagChip compact tag={tagForName(template.suggestedTag)} />
                      <span>
                        {unresolved.length
                          ? `${unresolved.length} detail${unresolved.length === 1 ? "" : "s"} needed`
                          : "Ready to use"}
                      </span>
                    </div>
                  </div>
                  <Button
                    disabled={!canEdit}
                    onClick={() => openConfiguration([template])}
                    variant="secondary"
                  >
                    Use template
                  </Button>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            description="Try another search or broaden the selected filters."
            title="No matching templates"
          />
        )}
      </Card>

      <Dialog
        contentClassName="prompt-library-dialog"
        description={
          dialogStep === "configure"
            ? "Fill the reusable details once and apply shared tracking settings."
            : dialogStep === "review"
              ? "Review every prompt and its tags before adding them."
              : "Your selected prompts are ready to track."
        }
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setError("");
        }}
        open={dialogOpen && dialogProjectId === projectId}
        title={
          dialogStep === "configure"
            ? `Configure ${configuredTemplates.length} prompt${configuredTemplates.length === 1 ? "" : "s"}`
            : dialogStep === "review"
              ? "Review prompts"
              : "Prompts added"
        }
      >
        {dialogStep === "configure" ? (
          <div className="prompt-library-configure">
            <section>
              <h3>Template details</h3>
              <p>These values are inserted wherever the template uses a placeholder.</p>
              <div className="form-grid prompt-library-variable-grid">
                {requiredVariables.map((name) => (
                  <Label key={name}>
                    {name.replaceAll("_", " ")}
                    <Input
                      aria-label={name}
                      onChange={(event) =>
                        setVariables((current) => ({
                          ...current,
                          [name]: event.target.value,
                        }))
                      }
                      placeholder={`Value for {${name}}`}
                      value={variables[name] ?? ""}
                    />
                  </Label>
                ))}
              </div>
            </section>
            <section>
              <h3>Tracking settings</h3>
              <div className="form-grid">
                <Label>
                  Location
                  <Select
                    onValueChange={(value) => {
                      setLocationCode(value);
                      const nextLanguages = languagesForLocation(value);
                      const nextLanguage = nextLanguages.some(
                        (option) => option.value === languageCode,
                      )
                        ? languageCode
                        : nextLanguages[0]?.value ?? DEFAULT_LANGUAGE;
                      setLanguageCode(nextLanguage);
                      const nextCountry =
                        localeEntry(Number(value), nextLanguage)?.locationName ??
                        "";
                      setVariables((current) => ({
                        ...current,
                        country: nextCountry,
                      }));
                    }}
                    options={LOCATION_OPTIONS}
                    value={locationCode}
                  />
                </Label>
                <Label>
                  Language
                  <Select
                    onValueChange={setLanguageCode}
                    options={availableLanguages}
                    value={languageCode}
                  />
                </Label>
                <Label>
                  Cadence
                  <Select
                    onValueChange={(value) =>
                      setCadence(value as "daily" | "weekly")
                    }
                    options={[
                      { value: "daily", label: "Daily" },
                      { value: "weekly", label: "Weekly" },
                    ]}
                    value={cadence}
                  />
                </Label>
                {cadence === "weekly" ? (
                  <Label>
                    Day
                    <Select
                      onValueChange={setWeekday}
                      options={[
                        "Sunday",
                        "Monday",
                        "Tuesday",
                        "Wednesday",
                        "Thursday",
                        "Friday",
                        "Saturday",
                      ].map((label, value) => ({
                        value: String(value),
                        label,
                      }))}
                      value={weekday}
                    />
                  </Label>
                ) : null}
                <Label>
                  Time
                  <Input
                    onChange={(event) => setTime(event.target.value)}
                    type="time"
                    value={time}
                  />
                </Label>
                <Label>
                  Shared tags
                  <TagPicker
                    allowCreate
                    label={
                      sharedTags.length ? `${sharedTags.length} shared` : "Add tags"
                    }
                    onToggle={(name, selected) =>
                      setSharedTags((current) =>
                        toggleName(current, name, selected),
                      )
                    }
                    selectedNames={sharedTags}
                    tags={tags.data ?? []}
                  />
                </Label>
              </div>
              <p className="form-help">
                Each prompt also receives its suggested category tag. You can remove
                it in the next step.
              </p>
            </section>
            {error ? <p className="form-error">{error}</p> : null}
            <div className="dialog-actions">
              <Button onClick={() => setDialogOpen(false)} variant="ghost">
                Cancel
              </Button>
              <Button onClick={continueToReview}>
                Review prompts <ChevronRight size={15} />
              </Button>
            </div>
          </div>
        ) : dialogStep === "review" ? (
          <div className="prompt-library-review">
            <div className="prompt-library-review-list">
              {drafts.map((draft, index) => (
                <article className="prompt-library-draft" key={draft.templateId}>
                  <div className="prompt-library-draft-heading">
                    <strong>Prompt {index + 1}</strong>
                    <span>{draft.queryText.length}/2,000</span>
                  </div>
                  <textarea
                    aria-label={`Prompt ${index + 1}`}
                    maxLength={2_000}
                    onChange={(event) =>
                      setDrafts((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, queryText: event.target.value }
                            : item,
                        ),
                      )
                    }
                    value={draft.queryText}
                  />
                  <div className="prompt-library-draft-tags">
                    <div>
                      {draft.tags.map((name) => (
                        <TagChip
                          compact
                          key={promptTagKey(name)}
                          onRemove={() =>
                            setDrafts((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      tags: toggleName(item.tags, name, false),
                                    }
                                  : item,
                              ),
                            )
                          }
                          tag={tagForName(name)}
                        />
                      ))}
                    </div>
                    <TagPicker
                      allowCreate
                      disabled={draft.tags.length >= MAX_PROMPT_TAGS}
                      label="Edit tags"
                      onToggle={(name, selected) =>
                        setDrafts((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  tags: toggleName(item.tags, name, selected),
                                }
                              : item,
                          ),
                        )
                      }
                      selectedNames={draft.tags}
                      tags={tags.data ?? []}
                    />
                  </div>
                </article>
              ))}
            </div>
            {error ? <p className="form-error">{error}</p> : null}
            <div className="dialog-actions">
              <Button onClick={() => setDialogStep("configure")} variant="ghost">
                Back
              </Button>
              <Button
                disabled={createPrompts.isPending}
                onClick={submitDrafts}
              >
                {createPrompts.isPending
                  ? "Adding prompts…"
                  : `Add ${drafts.length} prompt${drafts.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        ) : (
          <div className="prompt-library-success">
            <span><Check size={19} /></span>
            <div>
              <h3>
                {creationResult?.createdCount ?? 0} prompt
                {(creationResult?.createdCount ?? 0) === 1 ? "" : "s"} added
              </h3>
              <p>
                {creationResult?.skippedCount
                  ? `${creationResult.skippedCount} existing or duplicate prompt${creationResult.skippedCount === 1 ? " was" : "s were"} skipped.`
                  : "They now use the selected schedule, locale, and tags."}
              </p>
            </div>
            <Button
              onClick={() => {
                setDialogOpen(false);
                void navigate("/prompts");
              }}
            >
              View prompts
            </Button>
          </div>
        )}
      </Dialog>
    </div>
  );
}
