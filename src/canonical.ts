export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) {
        const child = normalize((item as Record<string, unknown>)[key]);
        if (child !== undefined) result[key] = child;
      }
      return result;
    }
    return item;
  };
  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) throw new Error("INVALID_JSON");
  return serialized;
}
