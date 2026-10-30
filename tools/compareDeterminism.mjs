import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const files = process.argv.slice(2);
if (files.length < 2) throw new Error('Provide reference JSON and one or more engine JSON files');
const reference = JSON.parse(readFileSync(files[0], 'utf8'));
assert.notEqual(reference.complete, false, 'Reference run is incomplete');
assert.notEqual(reference.status, 'running', 'Reference run is incomplete');
assert.ok(reference.runs.length > 0, 'Reference has no runs');
if (reference.expectedRuns != null) assert.equal(reference.runs.length, reference.expectedRuns, 'Reference missing cases');
for (const file of files.slice(1)) {
  const actual = JSON.parse(readFileSync(file, 'utf8'));
  assert.notEqual(actual.status, 'unfulfilled', `${file}: ${actual.error}`);
  assert.notEqual(actual.status, 'running', `${file}: still running`);
  assert.notEqual(actual.complete, false, `${file}: incomplete`);
  if (actual.expectedRuns != null) assert.equal(actual.runs.length, actual.expectedRuns, `${file}: missing cases`);
  assert.equal(actual.minutes, reference.minutes, `${file}: duration mismatch`);
  assert.equal(actual.runs.length, reference.runs.length, `${file}: incomplete run set`);
  for (let i = 0; i < reference.runs.length; i++) {
    const expected = reference.runs[i], got = actual.runs[i], label = `${file}: ${expected.mapId}/${expected.seed}`;
    for (const key of ['mapId', 'seed', 'ticks', 'final', 'digest', 'physics']) assert.deepEqual(got[key], expected[key], `${label}: ${key}`);
    assert.equal(got.checkpoints.length, Math.floor(expected.ticks / 100), `${label}: missing checkpoints`);
    for (let n = 0; n < expected.checkpoints.length; n++) assert.equal(got.checkpoints[n], expected.checkpoints[n], `${label}: tick ${(n + 1) * 100}`);
    assert.deepEqual(got.terrainCheckpoints, expected.terrainCheckpoints, `${label}: physical surface checkpoint`);
  }
  console.log(`${actual.name ?? actual.engine}: ${actual.runs.length} runs and every checkpoint match`);
}
