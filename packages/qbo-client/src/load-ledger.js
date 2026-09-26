/**
 * LoadLedger — tracks all QBO entities created during a load operation.
 * On failure, the ledger can be serialized into the job record for later rollback.
 */

// Reverse dependency order for cleanup (most dependent first)
const CLEANUP_ORDER = [
  "journalentry",
  "transfer",
  "deposit",
  "vendorcredit",
  "refundreceipt",
  "creditmemo",
  "billpayment",
  "payment",
  "purchase",
  "salesreceipt",
  "bill",
  "invoice",
  "purchaseorder",
  "estimate"
];

// Master data cannot be deleted in QBO, only made inactive (as purge does), after every
// transaction is gone. Accounts are recorded but never inactivated, like purge: QBO may refuse
// (a balance, an item posting to it), and a rollback that can never succeed could not be retried.
const INACTIVATION_ORDER = ["item", "employee", "vendor", "customer"];

export class LoadLedger {
  constructor() {
    /** @type {Map<string, Array<{ Id: string, SyncToken: string }>>} */
    this.entities = new Map();
    this.failedAtPhase = null;
    this.failedError = null;
  }

  /**
   * Record created entities (a whole batchCreate result or one batch's `onCreated` slice).
   * Ids already recorded for the type are skipped, so recording incrementally and again at the
   * end never double-counts.
   * @param {string} entityType - e.g. "invoice", "bill"
   * @param {{ results: Array<{ entity: { Id: string, SyncToken: string } }> }} batchResult
   */
  recordBatchResults(entityType, batchResult) {
    if (!batchResult?.results) return;
    const existing = this.entities.get(entityType) || [];
    const seen = new Set(existing.map((e) => e.Id));
    for (const r of batchResult.results) {
      const id = r.entity?.Id;
      if (id && !seen.has(id)) {
        seen.add(id);
        existing.push({ Id: id, SyncToken: r.entity.SyncToken || "0" });
      }
    }
    this.entities.set(entityType, existing);
  }

  /**
   * Mark the ledger as failed at a specific phase.
   * @param {number} phase
   * @param {string} error
   */
  markFailed(phase, error) {
    this.failedAtPhase = phase;
    this.failedError = error;
  }

  /**
   * Get total number of tracked entities.
   */
  get totalTracked() {
    let total = 0;
    for (const entries of this.entities.values()) {
      total += entries.length;
    }
    return total;
  }

  /**
   * Get cleanup manifest in reverse dependency order.
   * @returns {Array<{ entityType: string, entities: Array<{ Id: string, SyncToken: string }> }>}
   */
  getCleanupManifest() {
    const manifest = [];
    for (const entityType of CLEANUP_ORDER) {
      const entries = this.entities.get(entityType);
      if (entries && entries.length > 0) {
        manifest.push({ entityType, entities: entries });
      }
    }
    return manifest;
  }

  /**
   * Get the master data a rollback makes inactive (records the load created or reactivated;
   * accounts excluded, see INACTIVATION_ORDER).
   * @returns {Array<{ entityType: string, entities: Array<{ Id: string, SyncToken: string }> }>}
   */
  getInactivationManifest() {
    const manifest = [];
    for (const entityType of INACTIVATION_ORDER) {
      const entries = this.entities.get(entityType);
      if (entries && entries.length > 0) {
        manifest.push({ entityType, entities: entries });
      }
    }
    return manifest;
  }

  /**
   * Serialize to JSON-safe object.
   */
  toJSON() {
    const entries = {};
    for (const [type, list] of this.entities) {
      entries[type] = list;
    }
    return {
      entries,
      failedAtPhase: this.failedAtPhase,
      failedError: this.failedError,
      totalTracked: this.totalTracked
    };
  }

  /**
   * Restore from serialized JSON.
   * @param {object} json
   * @returns {LoadLedger}
   */
  static fromJSON(json) {
    const ledger = new LoadLedger();
    if (json?.entries) {
      for (const [type, list] of Object.entries(json.entries)) {
        ledger.entities.set(type, /** @type {any[]} */ (list));
      }
    }
    ledger.failedAtPhase = json?.failedAtPhase ?? null;
    ledger.failedError = json?.failedError ?? null;
    return ledger;
  }
}
