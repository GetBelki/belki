export type EntityGroupKey = "brands" | "companies" | "places" | "other";

export const ENTITY_GROUPS: Array<{ key: EntityGroupKey; label: string }> = [
  { key: "brands", label: "Brands" },
  { key: "companies", label: "Companies" },
  { key: "places", label: "Places" },
  { key: "other", label: "Other" },
];

export function entityGroup(entityType: string | null | undefined): EntityGroupKey {
  const type = (entityType ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

  if (type.includes("brand")) return "brands";
  if (
    type.includes("company") ||
    type.includes("organization") ||
    type.includes("organisation") ||
    type.includes("business") ||
    type.includes("corporation")
  ) return "companies";
  if (
    type.includes("place") ||
    type.includes("location") ||
    type.includes("city") ||
    type.includes("country") ||
    type.includes("region") ||
    type.includes("address")
  ) return "places";

  return "other";
}

export function normalizeEntityName(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}
