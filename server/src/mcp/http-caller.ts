/** POSTs JSON and maps transport failures without leaking them out of an MCP child. */
export async function postJson<T, E>(
  url: string,
  body: Record<string, unknown>,
  serviceName: string,
  failure: (message: string) => E,
): Promise<T | E> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return failure(`${serviceName} returned ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    return failure(`${serviceName} unreachable: ${String(error)}`);
  }
}
