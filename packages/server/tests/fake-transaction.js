/**
 * A stand-in for db/pool.js's transaction()/rollback() in tests that mock the pool with a
 * scripted client: BEGIN, fn(client), then COMMIT, or ROLLBACK when fn returns rollback(value)
 * (resolving to `value`) or throws (rethrown). `getClient` returns the fake client to use.
 */
export function fakeTransaction(getClient) {
  const ROLLBACK = Symbol("rollback");
  const rollback = (value) => ({ [ROLLBACK]: true, value });
  async function transaction(fn) {
    const client = await getClient();
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      if (result && result[ROLLBACK]) {
        await client.query("ROLLBACK");
        return result.value;
      }
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release?.();
    }
  }
  return { transaction, rollback };
}
