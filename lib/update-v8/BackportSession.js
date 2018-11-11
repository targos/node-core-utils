'use strict';

const path = require('path');

const rimraf = require('rimraf');

const { readJson, writeJson } = require('../file');

const steps = {
  NONE: 'NONE',
  APPLY: 'APPLY',
  CONFLICT: 'CONFLICT',
  COMMIT: 'COMMIT'
};

class BackportSession {
  constructor(config) {
    this.config = config;
    this.nodeDir = config.nodeDir;
    this.ncuDir = path.join(this.nodeDir, '.ncu');
  }

  get backportPath() {
    return path.join(this.ncuDir, 'v8-backport');
  }

  get sessionPath() {
    return path.join(this.backportPath, 'session');
  }

  get status() {
    const status = readJson(this.sessionPath);
    if (!status.step) status.step = steps.NONE;
    return status;
  }

  saveStatus(value) {
    writeJson(this.sessionPath, value);
  }

  patchPath(sha) {
    return path.join(this.backportPath, `${sha}.patch`);
  }

  clean() {
    rimraf.sync(this.backportPath);
  }

  getPatch(sha) {
    return readJson(this.patchPath(sha));
  }

  savePatches(patches) {
    for (const patch of patches) {
      writeJson(this.patchPath(patch.sha), patch);
    }
    writeJson(this.sessionPath, {
      step: steps.APPLY,
      patches: patches.map((patch) => patch.sha),
      currentPatch: patches[0].sha
    });
  }
}

module.exports = {
  BackportSession,
  steps
};
