import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Plus, Search, Tag, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  MAX_PROMPT_TAG_LENGTH,
  MAX_PROMPT_TAGS,
  normalizePromptTagName,
  promptTagColorIndex,
  promptTagKey,
} from "../../shared/prompt-tags";
import { cn } from "../lib/utils";

export interface PromptTag {
  id: string;
  name: string;
  colorIndex: number;
  usageCount?: number;
}

// This helper intentionally shares the component module so draft chips and menu
// options always use the exact same color mapping.
// eslint-disable-next-line react-refresh/only-export-components
export function tagForName(name: string): PromptTag {
  return {
    id: `draft:${promptTagKey(name)}`,
    name: normalizePromptTagName(name),
    colorIndex: promptTagColorIndex(name),
  };
}

export function TagChip({
  tag,
  onRemove,
  compact = false,
}: {
  tag: PromptTag;
  onRemove?: () => void;
  compact?: boolean;
}) {
  return (
    <span
      className={cn(
        "prompt-tag-chip",
        `prompt-tag-tone-${tag.colorIndex}`,
        compact && "prompt-tag-chip-compact",
      )}
    >
      <span>{tag.name}</span>
      {onRemove ? (
        <button
          aria-label={`Remove ${tag.name}`}
          onClick={onRemove}
          type="button"
        >
          <X size={11} />
        </button>
      ) : null}
    </span>
  );
}

export function TagPicker({
  tags,
  selectedNames,
  onToggle,
  allowCreate = false,
  disabled = false,
  label = "Tags",
  className,
}: {
  tags: PromptTag[];
  selectedNames: string[];
  onToggle: (name: string, selected: boolean) => void;
  allowCreate?: boolean;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const [search, setSearch] = useState("");
  const selectedKeys = useMemo(
    () => new Set(selectedNames.map(promptTagKey)),
    [selectedNames],
  );
  const allTags = useMemo(() => {
    const catalog = new Map(tags.map((tag) => [promptTagKey(tag.name), tag]));
    for (const name of selectedNames) {
      if (!catalog.has(promptTagKey(name))) {
        catalog.set(promptTagKey(name), tagForName(name));
      }
    }
    return [...catalog.values()];
  }, [selectedNames, tags]);
  const normalizedSearch = normalizePromptTagName(search);
  const visibleTags = allTags.filter((tag) =>
    tag.name.toLocaleLowerCase().includes(normalizedSearch.toLocaleLowerCase()),
  );
  const canCreate =
    allowCreate &&
    normalizedSearch.length > 0 &&
    normalizedSearch.length <= MAX_PROMPT_TAG_LENGTH &&
    !allTags.some((tag) => promptTagKey(tag.name) === promptTagKey(normalizedSearch));
  const atLimit = selectedKeys.size >= MAX_PROMPT_TAGS;

  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open) setSearch("");
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          className={cn("tag-picker-trigger", className)}
          disabled={disabled}
          type="button"
        >
          <Tag size={14} />
          <span>{label}</span>
          {selectedKeys.size ? (
            <span className="tag-picker-count">{selectedKeys.size}</span>
          ) : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          collisionPadding={12}
          className="tag-picker-content"
          sideOffset={5}
        >
          <div className="tag-picker-search">
            <Search size={13} />
            <input
              aria-label="Search tags"
              autoFocus
              maxLength={MAX_PROMPT_TAG_LENGTH}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
              placeholder={allowCreate ? "Find or create a tag" : "Find tags"}
              value={search}
            />
          </div>
          <div className="tag-picker-options">
            {visibleTags.map((tag) => {
              const selected = selectedKeys.has(promptTagKey(tag.name));
              return (
                <DropdownMenu.Item
                  className="tag-picker-option"
                  disabled={!selected && atLimit}
                  key={tag.id}
                  onSelect={(event) => {
                    event.preventDefault();
                    onToggle(tag.name, !selected);
                  }}
                >
                  <TagChip compact tag={tag} />
                  {tag.usageCount !== undefined ? (
                    <span className="tag-picker-usage">{tag.usageCount}</span>
                  ) : null}
                  {selected ? <Check size={14} /> : null}
                </DropdownMenu.Item>
              );
            })}
            {canCreate ? (
              <DropdownMenu.Item
                className="tag-picker-option tag-picker-create"
                disabled={atLimit}
                onSelect={(event) => {
                  event.preventDefault();
                  onToggle(normalizedSearch, true);
                  setSearch("");
                }}
              >
                <Plus size={14} />
                <span>Create “{normalizedSearch}”</span>
              </DropdownMenu.Item>
            ) : null}
            {!visibleTags.length && !canCreate ? (
              <p className="tag-picker-empty">
                {allTags.length ? "No matching tags" : "No tags yet"}
              </p>
            ) : null}
          </div>
          {atLimit ? (
            <p className="tag-picker-limit">Maximum {MAX_PROMPT_TAGS} tags per prompt</p>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
