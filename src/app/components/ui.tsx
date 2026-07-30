import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Slot } from "@radix-ui/react-slot";
import { Check, ChevronDown, X } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  PropsWithChildren,
  ReactNode,
} from "react";
import { cn } from "../lib/utils";

export function Button({
  className,
  variant = "default",
  asChild,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "ghost" | "danger";
  asChild?: boolean;
}) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      className={cn("button", `button-${variant}`, className)}
      {...props}
    />
  );
}

export function Card({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card", className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card-header">
      <div>
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function CardContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card-content", className)} {...props} />;
}

export function Badge({
  children,
  tone = "neutral",
}: PropsWithChildren<{ tone?: "neutral" | "success" | "warning" | "danger" | "info" }>) {
  return <span className={cn("badge", `badge-${tone}`)}>{children}</span>;
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("input", className)} {...props} />;
}

export function Label({
  children,
  hint,
}: PropsWithChildren<{ hint?: string }>) {
  return (
    <label className="label">
      <span>
        {children}
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-orbit" />
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} />;
}

export function TableSkeleton({
  rows = 5,
  columns = 4,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div className="table-skeleton" aria-label="Loading data">
      {Array.from({ length: rows }, (_, row) => (
        <div
          className="table-skeleton-row"
          key={row}
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton
              className={column === 0 ? "table-skeleton-primary" : undefined}
              key={column}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Dialog({
  trigger,
  title,
  description,
  children,
  open,
  onOpenChange,
  contentClassName,
}: PropsWithChildren<{
  trigger?: ReactNode;
  title: string;
  description?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  contentClassName?: string;
}>) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content className={cn("dialog-content", contentClassName)}>
          <div className="dialog-heading">
            <div>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close className="icon-button" aria-label="Close">
              <X size={17} />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
}: {
  value?: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string; icon?: ReactNode }>;
  placeholder?: string;
}) {
  const selectedOption = options.find((option) => option.value === value);

  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger className="select-trigger">
        <SelectPrimitive.Value placeholder={placeholder}>
          {selectedOption ? (
            <span className="select-value-content">
              {selectedOption.icon}
              <span>{selectedOption.label}</span>
            </span>
          ) : undefined}
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon><ChevronDown size={15} /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="select-content" position="popper">
          <SelectPrimitive.Viewport className="select-viewport">
            {options.map((option) => (
              <SelectPrimitive.Item
                className="select-item"
                key={option.value}
                value={option.value}
              >
                <span className="select-option-content">
                  {option.icon}
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                </span>
                <SelectPrimitive.ItemIndicator><Check size={14} /></SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function DataTable({
  columns,
  rows,
  onRowClick,
  rowAriaLabel,
}: {
  columns: Array<{ key: string; label: ReactNode; className?: string }>;
  rows: Array<Record<string, ReactNode>>;
  onRowClick?: (row: Record<string, ReactNode>) => void;
  rowAriaLabel?: (row: Record<string, ReactNode>) => string;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((column) => <th className={column.className} key={column.key}>{column.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              aria-label={onRowClick ? rowAriaLabel?.(row) : undefined}
              className={onRowClick ? "clickable-table-row" : undefined}
              key={
                typeof row.id === "string" || typeof row.id === "number"
                  ? row.id
                  : index
              }
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              role={onRowClick ? "link" : undefined}
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((column) => (
                <td className={column.className} key={column.key}>{row[column.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
