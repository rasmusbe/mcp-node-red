/**
 * Every tool response travels through the caller's context window, so the JSON is compact:
 * indentation on a flow with 59 nodes costs about 20,000 characters and says nothing.
 */
export function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value),
      },
    ],
  };
}
