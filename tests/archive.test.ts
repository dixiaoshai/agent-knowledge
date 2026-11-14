import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ArchiveEvidenceStore } from '../src/archive/index.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function event(seq: number, text: string, project = 'demo') {
  return { schema_version: 1, event_id: hash(JSON.stringify(['codex', 'local', 'session', seq])), archive_seq: seq,
    runtime: 'codex', instance_id: 'local', session_id: 'session', session_key: '["codex","local","session"]', project_id: project,
    kind: 'message.user', occurred_at: '2026-01-01T00:00:00Z', observed_at: '2026-01-01T00:00:00Z', native_type: 'event_msg.user_message',
    source: { path: '/gone/session.jsonl', line: seq, record_hash: hash(text) },
    data: { turn_id: null, root_turn_id: null, model: null, title: text }, body: { text }, raw: { type: 'event_msg', payload: { type: 'user_message', message: text } } };
}
function batch(start: number, end: number, events: unknown[]) {
  return { schema_version: 1, archive_id: 'archive-a', view: 'content', after_cursor: start, next_cursor: end, has_more: false, events };
}

test('import, independently scoped search/read and replay survive source removal', () => {
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo']);
  const first = batch(0, 1, [event(1, 'hello world')]);
  assert.equal(store.importBatch(first).imported, 1);
  assert.equal(store.importBatch(first).replayed, true);
  const hit = store.search('world')[0]!;
  assert.equal(hit.event.body?.text, 'hello world');
  assert.equal(store.read('archive-a', hit.event.event_id).event.source?.path, '/gone/session.jsonl');
  assert.throws(() => store.search('world', 'private'));
  assert.throws(() => store.read('archive-a', hit.event.event_id, 'private'));
  store.close();
});

test('gaps, conflicting replay, unauthorized project and metadata injection roll back', () => {
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo']);
  store.importBatch(batch(0, 1, [event(1, 'first')]));
  assert.throws(() => store.importBatch(batch(0, 1, [event(1, 'changed')])));
  assert.throws(() => store.importBatch(batch(2, 3, [event(3, 'gap')])));
  assert.throws(() => store.importBatch(batch(1, 2, [event(2, 'secret', 'other')])));
  const injected = event(2, 'secret'); Object.assign(injected.data, { secret: 'password' });
  assert.throws(() => store.importBatch(batch(1, 2, [injected])));
  assert.equal(store.importBatch(batch(1, 2, [event(2, 'valid')])).cursor, 2);
  assert.equal(store.search('secret').length, 0);
  store.close();
});

test('deletion removes searchable evidence and prevents reimport', () => {
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo']);
  const original = event(1, 'delete me');
  store.importBatch(batch(0, 1, [original]));
  const tombstone = { ...event(2, ''), event_id: hash(JSON.stringify(['codex', 'local', 'session', 'deleted'])), kind: 'session.deleted', native_type: 'archive.session_deleted', source: null, data: {}, body: null, raw: null };
  store.importBatch(batch(1, 2, [tombstone]));
  assert.equal(store.search('delete me').length, 0);
  assert.throws(() => store.read('archive-a', original.event_id));
  assert.throws(() => store.importBatch(batch(2, 3, [event(3, 'resurrection')])));
  store.close();
});

test('rejects stalled pages, timezone-free timestamps and mismatched content atomically', () => {
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo']);
  assert.throws(() => store.importBatch({ ...batch(0, 0, []), has_more: true }));
  const time = event(1, 'clock'); time.occurred_at = '2026-01-01T00:00:00';
  assert.throws(() => store.importBatch(batch(0, 1, [time])));
  const mismatch = event(1, 'original'); mismatch.body.text = 'modified';
  assert.throws(() => store.importBatch(batch(0, 1, [mismatch])));
  assert.equal(store.importBatch(batch(0, 1, [event(1, 'valid')])).cursor, 1);
  store.close();
});

test('an authorized tombstone cannot remove a different project session', () => {
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo', 'other']);
  store.importBatch(batch(0, 1, [event(1, 'preserve')]));
  const tombstone = { ...event(2, '', 'other'), event_id: hash(JSON.stringify(['codex', 'local', 'session', 'deleted'])), kind: 'session.deleted', native_type: 'archive.session_deleted', source: null, data: {}, body: null, raw: null };
  assert.throws(() => store.importBatch(batch(1, 2, [tombstone])));
  assert.equal(store.search('preserve', 'demo').length, 1);
  store.close();
});

test('deletion cannot reuse an ordinary event ID or repeat under a new sequence', () => {
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo']);
  const original = event(1, 'preserved until valid deletion');
  store.importBatch(batch(0, 1, [original]));
  const bad = { ...event(2, ''), event_id: original.event_id, kind: 'session.deleted', native_type: 'archive.session_deleted', source: null, data: {}, body: null, raw: null };
  assert.throws(() => store.importBatch(batch(1, 2, [bad])), /deletion event ID/);
  assert.equal(store.search('preserved').length, 1);
  const good = { ...bad, event_id: hash(JSON.stringify(['codex', 'local', 'session', 'deleted'])) };
  assert.equal(store.importBatch(batch(1, 2, [good])).cursor, 2);
  assert.throws(() => store.importBatch(batch(2, 3, [{ ...good, archive_seq: 3 }])), /Duplicate deletion/);
  assert.equal(store.importBatch(batch(1, 2, [good])).cursor, 2);
  store.close();
});
