const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, formatGrade } = require('../public/calc');

const near = (actual, expected, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} to be close to ${expected}`);

const sample = () => [
  { name: 'Quizzes', weight: 20, score: 90, maxScore: 100 },
  { name: 'Midterm', weight: 30, score: 80, maxScore: 100 },
  { name: 'Final', weight: 50, score: null, maxScore: 100 },
];

test('current grade averages only the graded work', () => {
  const r = summarize(sample(), 85);
  near(r.current, 84); // (18 + 24) / 50
  near(r.secured, 42);
  near(r.bestPossible, 92);
  near(r.gradedWeight, 50);
  near(r.remainingWeight, 50);
});

test('computes the average needed on the remaining work', () => {
  const r = summarize(sample(), 85);
  assert.equal(r.status, 'needed');
  near(r.required, 86); // (85 - 42) / 50
  assert.deepEqual(r.ungraded.map((c) => c.name), ['Final']);
});

test('target is secured when already earned enough', () => {
  const r = summarize(sample(), 40);
  assert.equal(r.status, 'secured');
});

test('target is unreachable when even a perfect score is not enough', () => {
  const r = summarize(sample(), 95);
  assert.equal(r.status, 'unreachable');
  assert.ok(r.required > 100);
});

test('complete subject reports a final grade', () => {
  const comps = sample();
  comps[2].score = 70;
  const r = summarize(comps, 80);
  assert.equal(r.status, 'complete');
  near(r.finalGrade, 77); // 18 + 24 + 35
});

test('respects a max score other than 100', () => {
  const r = summarize([{ name: 'Quiz', weight: 100, score: 45, maxScore: 50 }], 80);
  near(r.current, 90);
});

test('scales results when weights do not add up to 100', () => {
  const r = summarize(
    [
      { name: 'A', weight: 10, score: 100, maxScore: 100 },
      { name: 'B', weight: 10, score: null, maxScore: 100 },
    ],
    80
  );
  near(r.totalWeight, 20);
  near(r.required, 60); // (16 - 10) / 10
});

test('handles no components and missing numbers without NaN', () => {
  assert.equal(summarize([], 80).status, 'empty');
  const r = summarize([{ name: 'X', weight: null, score: 50, maxScore: null }], 80);
  assert.equal(r.status, 'empty');
  assert.equal(r.current, null);
});

test('formats grades on each scale', () => {
  assert.equal(formatGrade(87.5, 'percent'), '87.5%');
  assert.equal(formatGrade(87, 'us'), 'B+ (3.3)');
  assert.equal(formatGrade(59, 'us'), 'F (0.0)');
  assert.equal(formatGrade(76, 'ph'), '2.75');
  assert.equal(formatGrade(74.9, 'ph'), '5.00');
  assert.equal(formatGrade(null, 'percent'), '—');
});
