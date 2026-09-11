/**
 * Flows, subflows and config nodes are objects, and a JSON string of the same content costs
 * about 16 percent more characters in escaping and turns one stray quote into a failed call.
 * Objects are therefore the documented shape, and strings stay accepted because clients and
 * models that learned the old signature keep sending them.
 */
export function parseJsonArgument(value: unknown, name: string): unknown {
  if (typeof value === 'object' && value !== null) {
    return value;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${name} parameter: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  throw new Error(`${name} must be an object or a JSON string`);
}
