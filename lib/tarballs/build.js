"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Errors = require("@oclif/errors");
const findYarnWorkspaceRoot = require("find-yarn-workspace-root");
const path = require("path");
const qq = require("qqjs");
const log_1 = require("../log");
const bin_1 = require("./bin");
const node_1 = require("./node");
const pack = async (from, to) => {
    const prevCwd = qq.cwd();
    qq.cd(path.dirname(from));
    await qq.mkdirp(path.dirname(to));
    log_1.log(`packing tarball from ${qq.prettifyPaths(from)} to ${qq.prettifyPaths(to)}`);
    await (to.endsWith('gz') ?
        qq.x('tar', ['czf', to, path.basename(from)]) :
        qq.x(`tar c ${path.basename(from)} | xz > ${to}`));
    qq.cd(prevCwd);
};
async function build(c, options = {}) {
    const { xz, config } = c;
    const prevCwd = qq.cwd();
    const packCLI = async () => {
        const stdout = await qq.x.stdout('npm', ['pack', '--unsafe-perm'], { cwd: c.root });
        return path.join(c.root, stdout.split('\n').pop());
    };
    const extractCLI = async (tarball) => {
        await qq.emptyDir(c.workspace());
        await qq.mv(tarball, c.workspace());
        tarball = path.basename(tarball);
        tarball = qq.join([c.workspace(), tarball]);
        qq.cd(c.workspace());
        await qq.x(`tar -xzf ${tarball}`);
        // eslint-disable-next-line no-await-in-loop
        for (const f of await qq.ls('package', { fullpath: true }))
            await qq.mv(f, '.');
        await qq.rm('package', tarball, 'bin/run.cmd');
    };
    const updatePJSON = async () => {
        qq.cd(c.workspace());
        const pjson = await qq.readJSON('package.json');
        pjson.version = c.version;
        pjson.oclif.update = pjson.oclif.update || {};
        pjson.oclif.update.s3 = pjson.oclif.update.s3 || {};
        pjson.oclif.update.s3.bucket = c.s3Config.bucket;
        await qq.writeJSON('package.json', pjson);
    };
    const addDependencies = async () => {
        qq.cd(c.workspace());
        const yarnRoot = findYarnWorkspaceRoot(c.root) || c.root;
        const yarn = await qq.exists([yarnRoot, 'yarn.lock']);
        if (yarn) {
            await qq.cp([yarnRoot, 'yarn.lock'], '.');
            await qq.x('yarn --no-progress --production --non-interactive');
        }
        else {
            let lockpath = qq.join(c.root, 'package-lock.json');
            if (!await qq.exists(lockpath)) {
                lockpath = qq.join(c.root, 'npm-shrinkwrap.json');
            }
            await qq.cp(lockpath, '.');
            await qq.x('npm install --production');
        }
    };
    const buildTarget = async (target) => {
        const workspace = c.workspace(target);
        const key = config.s3Key('versioned', '.tar.gz', target);
        const base = path.basename(key);
        log_1.log(`building target ${base}`);
        await qq.rm(workspace);
        await qq.cp(c.workspace(), workspace);
        await node_1.fetchNodeBinary({
            nodeVersion: c.nodeVersion,
            output: path.join(workspace, 'bin', 'node'),
            platform: target.platform,
            arch: target.arch,
            tmp: qq.join(config.root, 'tmp'),
        });
        if (options.pack === false)
            return;
        await pack(workspace, c.dist(key));
        if (xz)
            await pack(workspace, c.dist(config.s3Key('versioned', '.tar.xz', target)));
        if (!c.updateConfig.s3.host)
            return;
        const rollout = (typeof c.updateConfig.autoupdate === 'object' && c.updateConfig.autoupdate.rollout);
        const manifest = {
            rollout: rollout === false ? undefined : rollout,
            version: c.version,
            channel: c.channel,
            baseDir: config.s3Key('baseDir', target),
            gz: config.s3Url(config.s3Key('versioned', '.tar.gz', target)),
            xz: xz ? config.s3Url(config.s3Key('versioned', '.tar.xz', target)) : undefined,
            sha256gz: await qq.hash('sha256', c.dist(config.s3Key('versioned', '.tar.gz', target))),
            sha256xz: xz ? await qq.hash('sha256', c.dist(config.s3Key('versioned', '.tar.xz', target))) : undefined,
            node: {
                compatible: config.pjson.engines.node,
                recommended: c.nodeVersion,
            },
        };
        await qq.writeJSON(c.dist(config.s3Key('manifest', target)), manifest);
    };
    const buildBaseTarball = async () => {
        if (options.pack === false)
            return;
        await pack(c.workspace(), c.dist(config.s3Key('versioned', '.tar.gz')));
        if (xz)
            await pack(c.workspace(), c.dist(config.s3Key('versioned', '.tar.xz')));
        if (!c.updateConfig.s3.host) {
            Errors.warn('No S3 bucket or host configured. CLI will not be able to update.');
            return;
        }
        const manifest = {
            version: c.version,
            baseDir: config.s3Key('baseDir'),
            channel: config.channel,
            gz: config.s3Url(config.s3Key('versioned', '.tar.gz')),
            xz: config.s3Url(config.s3Key('versioned', '.tar.xz')),
            sha256gz: await qq.hash('sha256', c.dist(config.s3Key('versioned', '.tar.gz'))),
            sha256xz: xz ? await qq.hash('sha256', c.dist(config.s3Key('versioned', '.tar.xz'))) : undefined,
            rollout: (typeof c.updateConfig.autoupdate === 'object' && c.updateConfig.autoupdate.rollout),
            node: {
                compatible: config.pjson.engines.node,
                recommended: c.nodeVersion,
            },
        };
        await qq.writeJSON(c.dist(config.s3Key('manifest')), manifest);
    };
    log_1.log(`gathering workspace for ${config.bin} to ${c.workspace()}`);
    await extractCLI(await packCLI());
    await updatePJSON();
    await addDependencies();
    await bin_1.writeBinScripts({ config, baseWorkspace: c.workspace(), nodeVersion: c.nodeVersion });
    await buildBaseTarball();
    for (const target of c.targets) {
        if (!options.platform || options.platform === target.platform) {
            // eslint-disable-next-line no-await-in-loop
            await buildTarget(target);
        }
    }
    qq.cd(prevCwd);
}
exports.build = build;
