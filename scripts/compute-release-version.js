#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');

function parseSemVer(tagStr) {
  if (!tagStr) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tagStr).trim());
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

function formatSemVer({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function analyzeCommits(commitMessages) {
  if (!Array.isArray(commitMessages) || commitMessages.length === 0) {
    return 'none';
  }

  let hasFeat = false;
  let hasAnyCommit = false;

  for (const raw of commitMessages) {
    const text = String(raw || '').trim();
    if (!text) continue;
    hasAnyCommit = true;

    // 1. Check for Breaking Change:
    // (a) type!: or type(scope)!:
    if (/^[a-zA-Z0-9_-]+(\([^)]+\))?!:/.test(text)) {
      return 'major';
    }
    // (b) BREAKING CHANGE: or BREAKING-CHANGE:
    if (/BREAKING[- ]CHANGE:/i.test(text)) {
      return 'major';
    }

    // 2. Check for Feature:
    if (/^feat(\([^)]+\))?:/i.test(text)) {
      hasFeat = true;
    }
  }

  if (hasFeat) return 'minor';
  if (hasAnyCommit) return 'patch';
  return 'none';
}

function bumpVersion(base, bumpType) {
  const next = { ...base };
  switch (bumpType) {
    case 'major':
      next.major += 1;
      next.minor = 0;
      next.patch = 0;
      break;
    case 'minor':
      next.minor += 1;
      next.patch = 0;
      break;
    case 'patch':
      next.patch += 1;
      break;
    default:
      break;
  }
  return next;
}

function getPreviousTag(cwd = process.cwd()) {
  try {
    execSync('git fetch --tags --quiet origin || git fetch --tags --quiet || true', {
      cwd, stdio: 'ignore',
    });
  } catch (_) {}

  try {
    const out = execSync("git tag --list --sort='-v:refname' --merged HEAD", {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tags = out.split('\n').map(t => t.trim()).filter(t => /^v\d+\.\d+\.\d+$/.test(t));
    return tags[0] || null;
  } catch (_) {
    return null;
  }
}

function getCommitsSince(previousTag, cwd = process.cwd()) {
  try {
    const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
    const out = execSync(`git log "${range}" --format="%s%n%b%n---COMMIT-END---"`, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('---COMMIT-END---').map(c => c.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function checkRemoteTagExists(tag, cwd = process.cwd()) {
  try {
    // Check locally first
    const local = execSync(`git rev-parse "refs/tags/${tag}"`, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (local.trim()) return true;
  } catch (_) {}

  try {
    const out = execSync(`git ls-remote --tags origin "refs/tags/${tag}"`, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch (_) {
    return false;
  }
}

function validateReleaseRef(ref, eventName) {
  if (eventName === 'workflow_dispatch' && ref.startsWith('refs/tags/')) {
    throw new Error('Manual releases must run from main, not an existing tag. Select main to publish a new version.');
  }
  if (['push', 'workflow_dispatch'].includes(eventName) && ref === 'refs/heads/main') return;
  if (eventName === 'push' && ref.startsWith('refs/tags/v')) return;
  throw new Error('Stable releases must run from main or a version tag pushed from main.');
}

function assertTagOnMain(cwd) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'], {
      cwd, stdio: 'ignore',
    });
  } catch (_) {
    throw new Error('Release tag commit must be reachable from origin/main. Ensure main is fetched and the commit is merged.');
  }
}

function resolveReleaseVersion({
  ref = process.env.GITHUB_REF || '',
  eventName = process.env.GITHUB_EVENT_NAME || 'push',
  forceBump = process.env.INPUT_FORCE_BUMP || 'auto',
  previousTag = null,
  commits = [],
  isTagExisting = null,
} = {}) {
  validateReleaseRef(ref, eventName);

  // 1. Explicit tag push (e.g. refs/tags/v1.2.3)
  if (eventName === 'push' && ref.startsWith('refs/tags/v')) {
    const raw = ref.replace(/^refs\/tags\/v/, '');
    const parsed = parseSemVer(raw);
    if (!parsed) throw new Error(`Invalid semver tag pushed: ${ref}`);
    return {
      shouldRelease: true,
      rawVersion: raw,
      tag: `v${raw}`,
      bumpType: 'explicit_tag',
      previousTag: previousTag || null,
    };
  }

  const baseSemVer = parseSemVer(previousTag) || { major: 1, minor: 0, patch: 0 };
  const isManual = eventName === 'workflow_dispatch';

  let bumpType = 'none';

  if (['major', 'minor', 'patch'].includes(forceBump)) {
    bumpType = forceBump;
  } else {
    bumpType = analyzeCommits(commits);
    // User requirement: "如果是手工触发的，每次总是允许发布新的版本，如果没有任何变化，则将最末一位+1"
    if (isManual && bumpType === 'none') {
      bumpType = 'patch';
    }
  }

  // On push without any changes, skip release
  if (bumpType === 'none') {
    return {
      shouldRelease: false,
      rawVersion: formatSemVer(baseSemVer),
      tag: `v${formatSemVer(baseSemVer)}`,
      bumpType: 'none',
      previousTag,
    };
  }

  let nextVer = bumpVersion(baseSemVer, bumpType);

  // Avoid tag collision if tag already exists on remote
  const tagChecker = typeof isTagExisting === 'function' ? isTagExisting : () => false;
  while (tagChecker(`v${formatSemVer(nextVer)}`)) {
    nextVer.patch += 1;
  }

  const rawVersion = formatSemVer(nextVer);
  return {
    shouldRelease: true,
    rawVersion,
    tag: `v${rawVersion}`,
    bumpType,
    previousTag,
  };
}

function writeGitHubOutput(key, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

function main() {
  const cwd = process.cwd();
  const ref = process.env.GITHUB_REF || '';
  const eventName = process.env.GITHUB_EVENT_NAME || 'push';
  const forceBump = process.env.INPUT_FORCE_BUMP || 'auto';

  // Fail before computing a version or starting any builds for an invalid source.
  validateReleaseRef(ref, eventName);
  if (ref.startsWith('refs/tags/')) assertTagOnMain(cwd);

  const previousTag = getPreviousTag(cwd);
  const commits = getCommitsSince(previousTag, cwd);

  const result = resolveReleaseVersion({
    ref,
    eventName,
    forceBump,
    previousTag,
    commits,
    isTagExisting: tag => checkRemoteTagExists(tag, cwd),
  });

  console.log(`========================================`);
  console.log(`Release Version Computation Summary:`);
  console.log(`  Event:        ${eventName}`);
  console.log(`  Ref:          ${ref}`);
  console.log(`  Previous Tag: ${result.previousTag || '(none)'}`);
  console.log(`  Commits Count: ${commits.length}`);
  console.log(`  Bump Type:    ${result.bumpType}`);
  console.log(`  Should Release: ${result.shouldRelease}`);
  console.log(`  Target Tag:   ${result.tag}`);
  console.log(`  Raw Version:  ${result.rawVersion}`);
  console.log(`========================================`);

  writeGitHubOutput('should_release', result.shouldRelease);
  writeGitHubOutput('tag', result.tag);
  writeGitHubOutput('raw_version', result.rawVersion);
  writeGitHubOutput('bump_type', result.bumpType);
  writeGitHubOutput('previous_tag', result.previousTag || '');
}

if (require.main === module) {
  main();
}

module.exports = {
  parseSemVer,
  formatSemVer,
  analyzeCommits,
  bumpVersion,
  resolveReleaseVersion,
  getPreviousTag,
  getCommitsSince,
};
