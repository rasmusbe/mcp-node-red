import type { ZodError, ZodIssue } from 'zod';

/**
 * A ZodError stringifies to a pretty-printed JSON array, which spends eleven lines of the
 * caller's context on one missing field. One line per issue carries the same information.
 */
export function formatZodError(toolName: string, error: ZodError): string {
  const lines = [...new Set(collect(error.issues))];
  return [`Invalid input for ${toolName}:`, ...lines.map((line) => `- ${line}`)].join('\n');
}

function collect(issues: ZodIssue[]): string[] {
  const lines: string[] = [];

  for (const issue of issues) {
    // A union only says "Invalid input" and keeps the real reasons inside the error of each
    // alternative, so report those instead. Alternatives overlap, hence the dedupe above.
    if (issue.code === 'invalid_union') {
      const nested = collect(issue.unionErrors.flatMap((unionError) => unionError.issues));
      if (nested.length > 0) {
        lines.push(...nested);
        continue;
      }
    }

    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    lines.push(`${path}: ${issue.message}`);
  }

  return lines;
}
