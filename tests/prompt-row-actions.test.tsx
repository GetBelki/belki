import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptRowActions } from "../src/app/components/prompt-row-actions";

afterEach(cleanup);

function renderActions({ isActive = true }: { isActive?: boolean } = {}) {
  const onRun = vi.fn();
  const onToggle = vi.fn();
  const onDelete = vi.fn();

  render(
    <PromptRowActions
      canDelete
      deleteDisabled={false}
      isActive={isActive}
      onDelete={onDelete}
      onRun={onRun}
      onToggle={onToggle}
      promptName="Best dog food"
      runDisabled={false}
      runLabel="Run now"
      toggleDisabled={false}
    />,
  );

  return { onDelete, onRun, onToggle };
}

function openMenu() {
  fireEvent.keyDown(
    screen.getByRole("button", { name: "More actions for Best dog food" }),
    { key: "Enter" },
  );
}

describe("PromptRowActions", () => {
  it("keeps run visible and moves pause and delete into the menu", () => {
    const { onDelete, onRun, onToggle } = renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(onRun).toHaveBeenCalledOnce();

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause" }));
    expect(onToggle).toHaveBeenCalledOnce();

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("makes resume visible and moves run into the menu when paused", () => {
    const { onRun, onToggle } = renderActions({ isActive: false });

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onToggle).toHaveBeenCalledOnce();

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Run now" }));
    expect(onRun).toHaveBeenCalledOnce();
  });
});
