/* U10 claim 前的只讀遠端盤點。
   不 import state/today/cloud-sync，也不接受 storage port，避免這條路徑意外
   merge、push 或前移 watermark。所有查詢只靠目前 JWT 的 RLS ownership。 */

import {
  SUPABASE_KEY,
  SUPABASE_URL,
  getSessionResult,
} from './cloud-auth.js';

const REMOTE_PROBE_SCHEMA = 'thai-review-remote-probe-v1';
const TABLES = Object.freeze([
  { name: 'thai_cards', select: 'card_key' },
  { name: 'thai_days', select: 'date,device_id' },
  {
    name: 'thai_meta',
    select: [
      'reset_at', 'protection', 'protection_refill_checkpoint', 'makeup_pending',
      'resweep_position', 'resweep_started_at', 'achievements', 'favorites',
      'meta_updated_at',
    ].join(','),
  },
]);

function userIdForWorkspace(workspaceId) {
  if (typeof workspaceId !== 'string' || !workspaceId.startsWith('user:')) return null;
  const userId = workspaceId.slice(5).trim();
  return userId || null;
}

function authenticatedSession(result, workspaceId) {
  const userId = userIdForWorkspace(workspaceId);
  const session = result?.status === 'authenticated' ? result.session : null;
  return userId && session?.user?.id === userId && session?.access_token
    ? session
    : null;
}

function validNonnegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateMetaRow(row) {
  const requiredNumericFields = [
    'reset_at', 'resweep_position', 'resweep_started_at', 'meta_updated_at',
  ];
  const nullableNumericFields = ['protection', 'protection_refill_checkpoint'];
  const requiredFields = [
    ...requiredNumericFields, ...nullableNumericFields,
    'makeup_pending', 'achievements', 'favorites',
  ];
  if (!validRecord(row) || requiredFields.some(field => !Object.hasOwn(row, field))) {
    throw new Error('thai_meta returned an incomplete schema');
  }
  for (const field of requiredNumericFields) {
    if (!validNonnegativeNumber(row[field])) {
      throw new Error(`thai_meta ${field} has an invalid type`);
    }
  }
  for (const field of nullableNumericFields) {
    if (row[field] !== null && !validNonnegativeNumber(row[field])) {
      throw new Error(`thai_meta ${field} has an invalid type`);
    }
  }
  if (row.makeup_pending !== null && !validRecord(row.makeup_pending)) {
    throw new Error('thai_meta makeup_pending has an invalid type');
  }
  if (!validRecord(row.achievements) || !validRecord(row.favorites)) {
    throw new Error('thai_meta map fields have an invalid type');
  }
}

function metaHasLearningFacts(row) {
  validateMetaRow(row);
  return (row.reset_at || 0) > 0
    || (row.protection || 0) > 0
    || (row.protection_refill_checkpoint || 0) > 0
    || row.makeup_pending !== null
    || (row.resweep_position || 0) > 0
    || (row.resweep_started_at || 0) > 0
    || Object.keys(row.achievements).length > 0
    || Object.keys(row.favorites).length > 0;
}

function tableHasFacts(name, rows) {
  if (name !== 'thai_meta') return rows.length > 0;
  return rows.some(metaHasLearningFacts);
}

function makeReceiptId(createId, workspaceId) {
  const id = String(createId?.() || '').trim();
  if (!id) throw new Error('remote probe receipt ID is missing');
  return `${REMOTE_PROBE_SCHEMA}:${encodeURIComponent(workspaceId)}:${id}`;
}

function abortable(value, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const error = new Error('remote workspace probe aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export function createRemoteWorkspaceProbe({
  resolveSession = getSessionResult,
  fetchImpl = (...args) => fetch(...args),
  createId = () => crypto.randomUUID(),
  now = () => Date.now(),
  timeoutMs = 10000,
} = {}) {
  if (typeof resolveSession !== 'function'
      || typeof fetchImpl !== 'function'
      || typeof createId !== 'function'
      || typeof now !== 'function') {
    throw new TypeError('remote workspace probe adapters are incomplete');
  }

  let generation = 0;
  let currentController = null;
  const receipts = new Map();

  const invalidate = () => {
    generation += 1;
    currentController?.abort();
    currentController = null;
    receipts.clear();
  };

  async function readTables(workspaceId, { issueReceipt = false } = {}) {
    const operationGeneration = ++generation;
    currentController?.abort();
    const controller = new AbortController();
    currentController = controller;
    const ownsOperation = () => generation === operationGeneration && !controller.signal.aborted;
    const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 1));

    try {
      const before = await abortable(resolveSession(), controller.signal);
      const session = authenticatedSession(before, workspaceId);
      if (!session || !ownsOperation()) {
        return { completed: false, rowCount: null, workspaceId, reason: 'session-unavailable' };
      }
      const headers = {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${session.access_token}`,
      };
      const rowsByTable = await Promise.all(TABLES.map(async table => {
        const params = new URLSearchParams({ select: table.select, limit: '1' });
        const response = await abortable(fetchImpl(
          `${SUPABASE_URL}/rest/v1/${table.name}?${params}`,
          { method: 'GET', headers, signal: controller.signal },
        ), controller.signal);
        if (!response?.ok) throw new Error(`${table.name} ${response?.status || 'request-failed'}`);
        const rows = await abortable(response.json(), controller.signal);
        if (!Array.isArray(rows) || rows.length > 1) {
          throw new Error(`${table.name} returned an invalid probe payload`);
        }
        return [table.name, rows];
      }));
      if (!ownsOperation()) {
        return { completed: false, rowCount: null, workspaceId, reason: 'ownership-lost' };
      }
      const after = await abortable(resolveSession(), controller.signal);
      if (!authenticatedSession(after, workspaceId) || !ownsOperation()) {
        return { completed: false, rowCount: null, workspaceId, reason: 'ownership-lost' };
      }

      const tables = Object.fromEntries(rowsByTable.map(([name, rows]) => [name, {
        empty: !tableHasFacts(name, rows),
        sampledRows: rows.length,
      }]));
      const rowCount = Object.values(tables).filter(table => !table.empty).length;
      const result = {
        completed: true,
        rowCount,
        workspaceId,
        schemaVersion: REMOTE_PROBE_SCHEMA,
        tables,
      };
      if (issueReceipt && rowCount === 0) {
        const receiptId = makeReceiptId(createId, workspaceId);
        receipts.set(receiptId, {
          workspaceId,
          schemaVersion: REMOTE_PROBE_SCHEMA,
          issuedAt: now(),
        });
        result.receiptId = receiptId;
      }
      return result;
    } catch (error) {
      const reason = controller.signal.aborted ? 'aborted' : 'request-failed';
      controller.abort();
      return {
        completed: false,
        rowCount: null,
        workspaceId,
        reason,
        error,
      };
    } finally {
      clearTimeout(timer);
      if (currentController === controller) currentController = null;
    }
  }

  return {
    inspect(workspaceId) {
      return readTables(workspaceId, { issueReceipt: true });
    },
    async verifyRemotePull({ workspaceId, receiptId } = {}) {
      const receipt = receipts.get(receiptId);
      if (!receipt
          || receipt.workspaceId !== workspaceId
          || receipt.schemaVersion !== REMOTE_PROBE_SCHEMA) return false;
      const result = await readTables(workspaceId);
      return result.completed === true && result.rowCount === 0;
    },
    invalidate,
  };
}
