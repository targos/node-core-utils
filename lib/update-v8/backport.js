'use strict';

const path = require('path');

const execa = require('execa');
const fs = require('fs-extra');
const Listr = require('listr');

const common = require('./common');

exports.doBackport = function doBackport(options) {
  const todo = [
    common.getCurrentV8Version(),
    generatePatches(),
    applyPatches()
  ];
  if (options.bump !== false) {
    if (options.nodeMajorVersion < 9) {
      todo.push(incrementV8Version());
    } else {
      todo.push(incrementEmbedderVersion());
    }
  }
  return {
    title: 'V8 commit backport',
    task: () => {
      return new Listr(todo);
    }
  };
};

exports.commitBackport = function commitBackport() {
  return {
    title: 'Commit patches',
    task: async(ctx) => {
      const { patches } = ctx;
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
        ctx.patches = await Promise.all(fullShas.map(async(sha) => {
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
      const { patches } = ctx;
      for (const patch of patches) {
        try {
          await execa('git', ['apply', '-3', '--directory=deps/v8'], {
            cwd: ctx.nodeDir,
            input: patch.data
          });
        } catch (e) {
          const file = path.join(ctx.nodeDir, `${patch.sha}.diff`);
          await fs.writeFile(file, patch.data);
          throw new Error(
            `Could not apply patch.\n${e}\nDiff was stored in ${file}`
          );
        }
      }
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
