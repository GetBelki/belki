function providerFieldLabel(value: string): string {
  const words = value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/gu, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function productDetailRows(
  records: Array<Record<string, unknown>>,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const visit = (value: unknown, path: string[], depth: number) => {
    if (
      rows.length >= 48 ||
      value === null ||
      value === undefined ||
      value === ""
    ) {
      return;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      rows.push({
        label: path.map(providerFieldLabel).join(" · "),
        value: String(value),
      });
      return;
    }
    if (Array.isArray(value)) {
      const primitives = value.filter((item) =>
        ["string", "number", "boolean"].includes(typeof item),
      );
      if (primitives.length === value.length && primitives.length) {
        rows.push({
          label: path.map(providerFieldLabel).join(" · "),
          value: primitives.join(", "),
        });
      } else if (depth < 2) {
        value.forEach((item, index) =>
          visit(item, [...path, String(index + 1)], depth + 1),
        );
      }
      return;
    }
    if (typeof value === "object" && depth < 2) {
      Object.entries(value as Record<string, unknown>).forEach(([key, item]) =>
        visit(item, [...path, key], depth + 1),
      );
    }
  };
  records.forEach((record) => visit(record, [], 0));
  return rows.filter((row) => row.label);
}
