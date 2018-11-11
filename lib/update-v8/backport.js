'use strict';

const path = require('path');

const execa = require('execa');
const fs = require('fs-extra');
const Listr = require('listr');

const { getCurrentV8Version, getListrOptions } = require('./common');
const updateV8Clone = require('./updateV8Clone');
const { BackportSession, steps } = require('./BackportSession');

function backportMain(options) {
  const session = new BackportSession(options);
  options.backportSession = session;
  const status = session.status;

  if (status.step !== steps.NONE && options.abort) {
    session.clean();
    return options.execGitNode('reset', '--hard', 'HEAD');
  }

  switch (status.step) {
    case steps.NONE:
      return startSession(options);
    case steps.CONFLICT:
      return continueFromConflicts(options);
    default:
      throw new Error(`unexpected backport session step: ${status.step}`);
  }
}

async function startSession(options) {
  if (options.continue || options.abort) {
    throw new Error('there is no current backporting session');
  }
  const tasks = new Listr(
    [updateV8Clone(), doBackport(options), commitBackport()],
    getListrOptions(options)
  );
  return tasks.run(options);
}

async function continueFromConflicts(options) {
  if (!options.continue) {
    throw new Error(
      'you are in the middle of a backporting session. Please run `git node' +
      'v8 backport` with --continue or --abort.'
    );
  }

  const todo = [
    getCurrentV8Version(),
    applyPatches(),
    commitBackport()
  ];
  maybeIncrementVersion(todo, options);
}

function doBackport(options) {
  const todo = [
    getCurrentV8Version(),
    generatePatches(),
    applyPatches()
  ];
  maybeIncrementVersion(todo, options);
  return {
    title: 'V8 commit backport',
    task: () => {
      return new Listr(todo);
    }
  };
};

function maybeIncrementVersion(todo, options) {
  if (options.bump !== false) {
    if (options.nodeMajorVersion < 9) {
      todo.push(incrementV8Version());
    } else {
      todo.push(incrementEmbedderVersion());
    }
  }
}

function commitBackport() {
  return {
    title: 'Commit patches',
    task: async(ctx) => {
      const patchList = ctx.backportSession.status.patches;
      const patches = patchList.map((sha) => ctx.backportSession.getPatch(sha));
      let messageTitle, messageBody;
      if (patches.length === 1) {
        const [patch] = patches;
        const formatted = formatMessage(patch);
        messageTitle = formatted.title;
        messageBody = formatted.body;
      } else {
        messageTitle = 'deps: cherry-pick multiple commits from upstream V8';
        messageBody = '';
        for (const patch of patches) {
          const formatted = formatMessage(patch);
          messageBody += formatted.title + '\n' + formatted.body + '\n\n';
        }
      }
      await ctx.execGitNode('add', 'deps/v8');
      await ctx.execGitNode('commit', '-m', messageTitle, '-m', messageBody);
      ctx.backportSession.clean();
    }
  };
};

function getMessageTitle(patch) {
  return `deps: cherry-pick ${patch.sha.substring(0, 7)} from upstream V8`;
}

function formatMessage(patch) {
  const title = getMessageTitle(patch);
  const indentedMessage = patch.message.replace(/\n/g, '\n    ');
  const body =
    'Original commit message:\n\n' +
    `    ${indentedMessage}\n\n` +
    `Refs: https://github.com/v8/v8/commit/${patch.sha}`;
  return {
    title,
    body
  };
}

function generatePatches() {
  return {
    title: 'Generate patches',
    task: async(ctx) => {
      const shas = ctx.sha;
      try {
        const fullShas = await Promise.all(
          shas.map(async(sha) => {
            const { stdout } = await ctx.execGitV8('rev-parse', sha);
            return stdout;
          })
        );
        const patches = await Promise.all(fullShas.map(async(sha) => {
          const [patch, message] = await Promise.all([
            ctx.execGitV8('format-patch', '--stdout', `${sha}^..${sha}`),
            ctx.execGitV8('log', '--format=%B', '-n', '1', sha)
          ]);
          return {
            sha,
            data: patch.stdout,
            message: message.stdout
          };
        }));
        ctx.backportSession.savePatches(patches);
      } catch (e) {
        throw new Error(e.stderr);
      }
    }
  };
}

function applyPatches() {
  return {
    title: 'Apply patches to deps/v8',
    task: async(ctx) => {
      const { status } = ctx.backportSession;
      const { patches, currentPatch } = status;
      const patchIndex = patches.findIndex(currentPatch);
      for (let i = patchIndex; i < patches.length; i++) {
        const patch = ctx.backportSession.getPatch(patches[i]);
        try {
          await execa('git', ['apply', '-3', '--directory=deps/v8'], {
            cwd: ctx.nodeDir,
            input: patch.data
          });
        } catch (e) {
          status.step = steps.CONFLICT;
          status.currentPatch = patch.sha;
          ctx.backportSession.saveStatus(status);
          throw new Error(
            `failed to apply patch ${patch.sha.substring(0, 7)}. Fix the ` +
            'conflicts and run `git node v8 backport --continue` to continue.'
          );
        }
      }
      status.step = steps.COMMIT;
    }
  };
}

function incrementV8Version() {
  return {
    title: 'Increment V8 version',
    task: async(ctx) => {
      const incremented = ctx.currentVersion[3] + 1;
      const versionHPath = `${ctx.nodeDir}/deps/v8/include/v8-version.h`;
      let versionH = await fs.readFile(versionHPath, 'utf8');
      versionH = versionH.replace(
        /V8_PATCH_LEVEL (\d+)/,
        `V8_PATCH_LEVEL ${incremented}`
      );
      await fs.writeFile(versionHPath, versionH);
    }
  };
}

const embedderRegex = /'v8_embedder_string': '-node\.(\d+)'/;
function incrementEmbedderVersion() {
  return {
    title: 'Increment embedder version number',
    task: async(ctx) => {
      const commonGypiPath = path.join(ctx.nodeDir, 'common.gypi');
      const commonGypi = await fs.readFile(commonGypiPath, 'utf8');
      const embedderValue = parseInt(embedderRegex.exec(commonGypi)[1], 10);
      const embedderString = `'v8_embedder_string': '-node.${embedderValue +
        1}'`;
      await fs.writeFile(
        commonGypiPath,
        commonGypi.replace(embedderRegex, embedderString)
      );
      await ctx.execGitNode('add', 'common.gypi');
    }
  };
}

module.exports = {
  main: backportMain
};
