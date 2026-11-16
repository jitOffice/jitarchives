import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentProgressService } from '../dist/agent/agent.progress.js';
import { withAgentTrace, recordStep, understood } from '../dist/agent/agent.trace.js';

const traceStep = (id, status) => ({ id, label: 'internal-only-label', status, hitCount: 3, durationMs: 12, note: 'internal diagnostic text' });

test('Agent progress exposes only user-facing stages and combines attachment/content progress', () => {
  const progress = new AgentProgressService();
  progress.start(7, 'request-1');
  progress.update(7, 'request-1', [
    traceStep('understand', 'completed'),
    traceStep('archives', 'running'),
    traceStep('attachments', 'completed'),
    traceStep('content', 'running'),
  ]);

  const snapshot = progress.get(7, 'request-1');
  assert.equal(snapshot.status, 'running');
  assert.deepEqual(snapshot.steps.map((step) => [step.id, step.status]), [
    ['understand', 'completed'],
    ['archives', 'running'],
    ['content', 'running'],
    ['evidence', 'waiting'],
    ['answer', 'waiting'],
  ]);
  assert.equal(JSON.stringify(snapshot).includes('internal-only-label'), false);
  assert.equal(JSON.stringify(snapshot).includes('internal diagnostic text'), false);
});

test('completed progress closes active stages and marks unused stages as skipped', () => {
  const progress = new AgentProgressService();
  progress.start(7, 'request-2');
  progress.update(7, 'request-2', [traceStep('understand', 'completed'), traceStep('archives', 'running')]);
  progress.complete(7, 'request-2');

  const snapshot = progress.get(7, 'request-2');
  assert.equal(snapshot.status, 'completed');
  assert.deepEqual(snapshot.steps.map((step) => step.status), [
    'completed', 'completed', 'skipped', 'skipped', 'skipped',
  ]);
});

test('progress snapshots are isolated by authenticated user', () => {
  const progress = new AgentProgressService();
  progress.start(7, 'shared-request');
  assert.equal(progress.get(8, 'shared-request'), null);
  assert.ok(progress.get(7, 'shared-request'));
});

test('failed requests mark the active stage as failed', () => {
  const progress = new AgentProgressService();
  progress.start(7, 'request-3');
  progress.update(7, 'request-3', [traceStep('understand', 'completed'), traceStep('content', 'running')]);
  progress.fail(7, 'request-3');

  const snapshot = progress.get(7, 'request-3');
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.steps.find((step) => step.id === 'content').status, 'failed');
});

test('cancelling a running request aborts its signal exactly once', () => {
  const progress = new AgentProgressService();
  progress.start(7, 'request-cancel');
  const signal = progress.signal(7, 'request-cancel');
  assert.equal(signal.aborted, false);
  assert.equal(progress.cancel(7, 'request-cancel'), true);
  assert.equal(signal.aborted, true);
  assert.equal(progress.cancel(7, 'request-cancel'), false);
});

test('cancel arriving before start still aborts the request when it begins', () => {
  const progress = new AgentProgressService();
  assert.equal(progress.cancel(7, 'request-early-cancel'), true);
  progress.start(7, 'request-early-cancel');
  assert.equal(progress.signal(7, 'request-early-cancel').aborted, true);
});

test('trace callbacks receive real stage transitions and understood completes a running stage', async () => {
  const updates = [];
  await withAgentTrace(async () => {
    recordStep('understand', 'running', 0, 0);
    understood();
  }, (steps) => updates.push(steps.map((step) => [step.id, step.status])));

  assert.deepEqual(updates.at(-1), [['understand', 'completed']]);
});

test('answer progress exposes only allowlisted, user-readable substage details', async () => {
  const progress = new AgentProgressService();
  progress.start(7, 'answer-detail');
  await withAgentTrace(async () => {
    recordStep('answer', 'running', 0, 0, '正在整理分段资料（共 3 部分）');
  }, (steps) => progress.update(7, 'answer-detail', steps));
  assert.equal(progress.get(7, 'answer-detail').steps.find((step) => step.id === 'answer').detail, '正在整理分段资料（共 3 部分）');

  await withAgentTrace(async () => {
    recordStep('answer', 'running', 0, 0, 'tfidf_cosine_aggregated / internal diagnostic');
  }, (steps) => progress.update(7, 'answer-detail', steps));
  const snapshot = progress.get(7, 'answer-detail');
  assert.equal(snapshot.steps.find((step) => step.id === 'answer').detail, '正在整理分段资料（共 3 部分）');
  assert.doesNotMatch(JSON.stringify(snapshot), /tfidf_cosine_aggregated|internal diagnostic/u);
});
