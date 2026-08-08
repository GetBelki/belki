import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "./ui";

export function PromptRowActions({
  promptName,
  isActive,
  runLabel,
  runDisabled,
  toggleDisabled,
  deleteDisabled,
  canDelete,
  onRun,
  onToggle,
  onDelete,
}: {
  promptName: string;
  isActive: boolean;
  runLabel: string;
  runDisabled: boolean;
  toggleDisabled: boolean;
  deleteDisabled: boolean;
  canDelete: boolean;
  onRun: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="prompt-row-actions">
      {isActive ? (
        <Button
          className="prompt-action-button prompt-action-primary"
          disabled={runDisabled}
          onClick={onRun}
          type="button"
          variant="secondary"
        >
          <RefreshCw size={13} />
          {runLabel}
        </Button>
      ) : (
        <Button
          className="prompt-action-button prompt-action-primary"
          disabled={toggleDisabled}
          onClick={onToggle}
          type="button"
          variant="secondary"
        >
          <Play size={13} />
          {toggleDisabled ? "Saving…" : "Resume"}
        </Button>
      )}

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            aria-label={`More actions for ${promptName}`}
            className="prompt-actions-menu-trigger"
            title="More actions"
            type="button"
            variant="secondary"
          >
            <MoreHorizontal aria-hidden="true" size={16} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            collisionPadding={12}
            className="prompt-actions-menu"
            sideOffset={5}
          >
            {isActive ? (
              <DropdownMenu.Item
                className="prompt-actions-menu-item"
                disabled={toggleDisabled}
                onSelect={onToggle}
              >
                <Pause size={14} />
                <span>{toggleDisabled ? "Saving…" : "Pause"}</span>
              </DropdownMenu.Item>
            ) : (
              <DropdownMenu.Item
                className="prompt-actions-menu-item"
                disabled={runDisabled}
                onSelect={onRun}
              >
                <RefreshCw size={14} />
                <span>{runLabel}</span>
              </DropdownMenu.Item>
            )}

            {canDelete ? (
              <>
                <DropdownMenu.Separator className="prompt-actions-menu-separator" />
                <DropdownMenu.Item
                  className="prompt-actions-menu-item prompt-actions-menu-danger"
                  disabled={deleteDisabled}
                  onSelect={onDelete}
                >
                  <Trash2 size={14} />
                  <span>Delete</span>
                </DropdownMenu.Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
