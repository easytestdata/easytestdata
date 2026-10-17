import { batchCreate, batchUpdate, clearSandbox } from "@easytestdata/qbo-client";

// Node's built-in multipart body classes (the lint environment does not list them as globals).
const { FormData, Blob } = globalThis;

// Endpoint names are QuickBooks entity names in lower case ("invoice", "recurringtransaction").
const ENDPOINT = /^[a-z]{2,40}$/;
const REPORT = /^[A-Za-z]{2,60}$/;

function endpoint(entity) {
  if (typeof entity !== "string" || !ENDPOINT.test(entity)) {
    throw new Error(`Invalid QuickBooks entity: ${entity}`);
  }
  return entity;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Returns { target, close }.
 * The only way an extension job writes to QuickBooks: a frozen object over a locked,
 * sandbox-only QboClient (buildLockedQboClient), built by the job runner inside the job's
 * connection lock and bound to the job's signal. It reaches only that sandbox.
 */
export function createSandboxTarget(rawClient, { signal, onUse = () => {} } = {}) {
  let closed = false;
  // The client as the methods see it: the same client, except that a request about to be sent
  // reports that the sandbox was used (a call refused before that, such as an invalid entity
  // name, does not count). Its state stays on the real client.
  const client = Object.create(rawClient, {
    request: {
      value: (...args) => {
        onUse();
        return rawClient.request(...args);
      }
    }
  });
  const inFlight = new Set();
  const numbered = (items) => items.map((item, index) => ({ ...item, originalIndex: index }));
  const methods = {
    query: (sql) => client.query(sql),
    read: (entity, id) => client.request("GET", `/${endpoint(entity)}/${encodeURIComponent(id)}`),
    create: (entity, payload) => client.create(endpoint(entity), payload),
    update: (entity, payload) => client.update(endpoint(entity), payload),
    remove: (entity, { Id, SyncToken }) => client.delete(endpoint(entity), Id, SyncToken),
    /** items: [{ payload, ref? }]; results carry originalIndex = the item's position. */
    batchCreate: (entity, items, { onCreated, onProgress } = {}) =>
      batchCreate(client, endpoint(entity), numbered(items), { signal, onCreated, onProgress }),
    /** items: [{ payload }] */
    batchUpdate: (entity, items, { onProgress } = {}) =>
      batchUpdate(client, endpoint(entity), items, { signal, onProgress }),
    /** Attaches a file: multipart POST /upload (metadata part + content part). */
    upload: ({ fileName, contentType, bytes, entityRef }) => {
      const form = new FormData();
      const metadata = {
        AttachableRef: [{ EntityRef: entityRef }],
        FileName: fileName,
        ContentType: contentType
      };
      form.append(
        "file_metadata_01",
        new Blob([JSON.stringify(metadata)], { type: "application/json" }),
        "metadata.json"
      );
      form.append("file_content_01", new Blob([bytes], { type: contentType }), fileName);
      return client.request("POST", "/upload", { data: form });
    },
    report: (name, params = {}) => {
      if (typeof name !== "string" || !REPORT.test(name))
        throw new Error(`Invalid report: ${name}`);
      return client.request("GET", `/reports/${name}`, { params });
    },
    preferences: () => client.request("GET", "/preferences"),
    /** `sparse` must carry the current SyncToken; it is sent as a sparse update. */
    updatePreferences: (sparse) =>
      client.request("POST", "/preferences", {
        headers: JSON_HEADERS,
        data: { ...sparse, sparse: true }
      }),
    /** Deletes a recurring template, which QuickBooks wraps by type ({ Invoice: {...} }). */
    removeRecurring: (type, { Id, SyncToken }) =>
      client.request("POST", "/recurringtransaction", {
        params: { operation: "delete" },
        headers: JSON_HEADERS,
        data: { [type]: { Id, SyncToken } }
      }),
    clearSandbox: ({ onProgress } = {}) => clearSandbox(client, { emit: onProgress, signal })
  };
  // Every call is tracked, so the runner can wait for calls still running before it releases the
  // lock. Once the job's handler has ended the target refuses further calls.
  const used = Object.fromEntries(
    Object.entries(methods).map(([name, fn]) => [
      name,
      (...args) => {
        if (closed) {
          return Promise.reject(new Error("This job has ended; its sandbox can't be used now."));
        }
        const call = Promise.resolve().then(() => fn(...args));
        inFlight.add(call);
        const settle = () => inFlight.delete(call);
        call.then(settle, settle);
        return call;
      }
    ])
  );
  const target = Object.freeze({ realmId: rawClient.cfg.qboRealmId, ...used });
  /** Refuses further calls and resolves once the ones already started have settled. */
  async function close() {
    closed = true;
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  }
  return { target, close };
}
