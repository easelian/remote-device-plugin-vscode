const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.bundle.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  legalComments: 'linked',
  metafile: true,
  plugins: [
    {
      name: 'licenses',
      setup(build) {
        build.onEnd((result) => {
          if (!result.metafile) {
            return;
          }
          const packages = new Set();
          for (const input of Object.keys(result.metafile.inputs)) {
            const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
            if (match) {
              packages.add(match[1]);
            }
          }
          const notices = [];
          for (const name of [...packages].sort()) {
            const directory = path.join('node_modules', name);
            const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find((file) =>
              fs.existsSync(path.join(directory, file)),
            );
            if (!license) {
              throw new Error(`Missing bundled license for ${name}`);
            }
            notices.push(`${name}\n\n${fs.readFileSync(path.join(directory, license), 'utf8')}`);
          }
          fs.writeFileSync('out/THIRD_PARTY_NOTICES.txt', notices.join('\n\n'));
        });
      },
    },
  ],
};
if (process.argv.includes('--watch')) {
  void esbuild.context(options).then((context) => context.watch());
} else {
  void esbuild.build(options).catch(() => {
    process.exitCode = 1;
  });
}
