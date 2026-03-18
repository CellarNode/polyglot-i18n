const PLACEHOLDER_PATTERNS = [
  /\{\{[^}]+\}\}/g, // {{variable}}
  /\{[0-9]+\}/g, // {0}, {1}
  /%[sd]/g, // %s, %d
];

/**
 * Extracts all placeholders from a string.
 */
export function extractPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) found.push(...matches);
  }
  return found;
}

/**
 * Validates that all placeholders from the source appear in the translation.
 * Returns an array of warning strings (empty = all good).
 */
export function validatePlaceholders(
  source: string,
  translated: string,
  key: string
): string[] {
  const sourcePlaceholders = extractPlaceholders(source);
  const warnings: string[] = [];

  for (const ph of sourcePlaceholders) {
    if (!translated.includes(ph)) {
      warnings.push(`Key "${key}": placeholder ${ph} missing in translation`);
    }
  }

  return warnings;
}
