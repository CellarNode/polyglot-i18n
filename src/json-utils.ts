/**
 * Flattens a nested JSON object into dot-path keys.
 * { pagination: { next: "Next" } } → { "pagination.next": "Next" }
 */
export function flattenJSON(
  obj: Record<string, unknown>,
  prefix = ""
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      Object.assign(
        result,
        flattenJSON(value as Record<string, unknown>, fullKey)
      );
    } else {
      result[fullKey] = String(value);
    }
  }

  return result;
}

/**
 * Unflattens dot-path keys back into nested JSON.
 * { "pagination.next": "Next" } → { pagination: { next: "Next" } }
 * Preserves insertion order.
 */
export function unflattenJSON(
  flat: Record<string, string>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [dotPath, value] of Object.entries(flat)) {
    const parts = dotPath.split(".");
    let current = result;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current) || typeof current[part] !== "object") {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    current[parts[parts.length - 1]] = value;
  }

  return result;
}
