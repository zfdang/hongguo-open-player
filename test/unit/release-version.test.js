const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSemVer,
  formatSemVer,
  analyzeCommits,
  bumpVersion,
  resolveReleaseVersion,
} = require('../../scripts/compute-release-version');

test('parseSemVer handles tags with and without v prefix and rejects invalid tags', () => {
  assert.deepEqual(parseSemVer('v1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseSemVer('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseSemVer('v0.0.1'), { major: 0, minor: 0, patch: 1 });
  assert.equal(parseSemVer('invalid'), null);
  assert.equal(parseSemVer('v1.2'), null);
  assert.equal(parseSemVer(''), null);
  assert.equal(parseSemVer(null), null);
});

test('formatSemVer formats semver objects', () => {
  assert.equal(formatSemVer({ major: 1, minor: 2, patch: 3 }), '1.2.3');
  assert.equal(formatSemVer({ major: 2, minor: 0, patch: 0 }), '2.0.0');
});

test('analyzeCommits correctly identifies major, minor, and patch bumps from Conventional Commits', () => {
  // Major via breaking bang
  assert.equal(analyzeCommits(['feat!: breaking change']), 'major');
  assert.equal(analyzeCommits(['fix(core)!: breaking fix']), 'major');
  assert.equal(analyzeCommits(['refactor!: breaking refactor']), 'major');

  // Major via BREAKING CHANGE footer/body
  assert.equal(analyzeCommits(['feat: new stuff\n\nBREAKING CHANGE: changes API']), 'major');
  assert.equal(analyzeCommits(['chore: update\n\nBREAKING-CHANGE: removes option']), 'major');

  // Minor via feat
  assert.equal(analyzeCommits(['feat: add new feature']), 'minor');
  assert.equal(analyzeCommits(['feat(ui): add button', 'fix: bug']), 'minor');

  // Patch via fix, docs, chore, etc.
  assert.equal(analyzeCommits(['fix: bug fix']), 'patch');
  assert.equal(analyzeCommits(['docs: update readme', 'chore: deps']), 'patch');
  assert.equal(analyzeCommits(['ci: update workflow']), 'patch');
  assert.equal(analyzeCommits(['some random commit']), 'patch');

  // Empty commits
  assert.equal(analyzeCommits([]), 'none');
  assert.equal(analyzeCommits(['']), 'none');
});

test('bumpVersion correctly resets lower version components', () => {
  const base = { major: 1, minor: 2, patch: 3 };
  assert.deepEqual(bumpVersion(base, 'major'), { major: 2, minor: 0, patch: 0 });
  assert.deepEqual(bumpVersion(base, 'minor'), { major: 1, minor: 3, patch: 0 });
  assert.deepEqual(bumpVersion(base, 'patch'), { major: 1, minor: 2, patch: 4 });
  assert.deepEqual(bumpVersion(base, 'none'), { major: 1, minor: 2, patch: 3 });
});

test('resolveReleaseVersion handles explicit tag push', () => {
  const res = resolveReleaseVersion({
    ref: 'refs/tags/v2.1.0',
    eventName: 'push',
  });
  assert.equal(res.shouldRelease, true);
  assert.equal(res.tag, 'v2.1.0');
  assert.equal(res.rawVersion, '2.1.0');
  assert.equal(res.bumpType, 'explicit_tag');
});

test('resolveReleaseVersion on push to main with commits calculates semver', () => {
  // Minor bump on feat
  const resFeat = resolveReleaseVersion({
    ref: 'refs/heads/main',
    eventName: 'push',
    previousTag: 'v1.2.2',
    commits: ['feat(player): add pip mode', 'fix: bug'],
  });
  assert.equal(resFeat.shouldRelease, true);
  assert.equal(resFeat.tag, 'v1.3.0');
  assert.equal(resFeat.rawVersion, '1.3.0');
  assert.equal(resFeat.bumpType, 'minor');

  // Patch bump on fixes
  const resFix = resolveReleaseVersion({
    ref: 'refs/heads/main',
    eventName: 'push',
    previousTag: 'v1.2.2',
    commits: ['fix: bug fix', 'ci: test'],
  });
  assert.equal(resFix.shouldRelease, true);
  assert.equal(resFix.tag, 'v1.2.3');
  assert.equal(resFix.rawVersion, '1.2.3');
  assert.equal(resFix.bumpType, 'patch');

  // Major bump on breaking change
  const resMajor = resolveReleaseVersion({
    ref: 'refs/heads/main',
    eventName: 'push',
    previousTag: 'v1.2.2',
    commits: ['feat!: drop support for older node'],
  });
  assert.equal(resMajor.shouldRelease, true);
  assert.equal(resMajor.tag, 'v2.0.0');
  assert.equal(resMajor.rawVersion, '2.0.0');
  assert.equal(resMajor.bumpType, 'major');
});

test('resolveReleaseVersion on push to main with NO commits skips release', () => {
  const res = resolveReleaseVersion({
    ref: 'refs/heads/main',
    eventName: 'push',
    previousTag: 'v1.2.2',
    commits: [],
  });
  assert.equal(res.shouldRelease, false);
  assert.equal(res.bumpType, 'none');
});

test('resolveReleaseVersion on manual workflow_dispatch ALWAYS allows release and bumps patch when no changes', () => {
  // No commits: bumps last digit (patch)
  const resNoCommits = resolveReleaseVersion({
    ref: 'refs/heads/main',
    eventName: 'workflow_dispatch',
    previousTag: 'v1.2.2',
    commits: [],
  });
  assert.equal(resNoCommits.shouldRelease, true);
  assert.equal(resNoCommits.tag, 'v1.2.3');
  assert.equal(resNoCommits.rawVersion, '1.2.3');
  assert.equal(resNoCommits.bumpType, 'patch');

  // Explicit forceBump minor
  const resForceMinor = resolveReleaseVersion({
    ref: 'refs/heads/main',
    eventName: 'workflow_dispatch',
    previousTag: 'v1.2.2',
    forceBump: 'minor',
    commits: [],
  });
  assert.equal(resForceMinor.shouldRelease, true);
  assert.equal(resForceMinor.tag, 'v1.3.0');
  assert.equal(resForceMinor.rawVersion, '1.3.0');
  assert.equal(resForceMinor.bumpType, 'minor');

  // Explicit forceBump major
  const resForceMajor = resolveReleaseVersion({
    ref: 'refs/heads/main',
    eventName: 'workflow_dispatch',
    previousTag: 'v1.2.2',
    forceBump: 'major',
    commits: [],
  });
  assert.equal(resForceMajor.shouldRelease, true);
  assert.equal(resForceMajor.tag, 'v2.0.0');
  assert.equal(resForceMajor.rawVersion, '2.0.0');
  assert.equal(resForceMajor.bumpType, 'major');
});

test('resolveReleaseVersion increments patch if target tag already exists on remote', () => {
  const existingTags = new Set(['v1.2.3', 'v1.2.4']);
  const res = resolveReleaseVersion({
    ref: 'refs/heads/main',
    eventName: 'workflow_dispatch',
    previousTag: 'v1.2.2',
    commits: [],
    isTagExisting: tag => existingTags.has(tag),
  });
  assert.equal(res.shouldRelease, true);
  assert.equal(res.tag, 'v1.2.5');
  assert.equal(res.rawVersion, '1.2.5');
});
