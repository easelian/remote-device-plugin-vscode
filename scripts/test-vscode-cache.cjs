// Optional real-host regression check. Uses disposable profiles and fake tokens.
// Usage: node scripts/test-vscode-cache.cjs /absolute/path/to/vscode-executable
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

async function run() {
  const executable = process.argv[2];
  assert.ok(executable && path.isAbsolute(executable), 'Supply the VS Code executable path');
  const root = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rdh-host-cache-'));
  const access = 'rdh-test-access-sentinel-not-a-real-token';
  const refresh = 'rdh-test-refresh-sentinel-not-a-real-token';
  try {
    for (const mode of ['legacy', 'proxy']) {
      const directory = path.join(temporary, mode);
      const extension = path.join(directory, 'extension');
      const profile = path.join(directory, 'profile');
      const workspace = path.join(directory, 'workspace');
      await fs.mkdir(extension, { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      await fs.cp(path.join(root, 'out'), path.join(extension, 'out'), { recursive: true });
      await fs.cp(path.join(root, 'resources'), path.join(extension, 'resources'), {
        recursive: true,
      });
      const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
      manifest.main = './fixture.cjs';
      delete manifest.contributes.chatSkills;
      await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify(manifest));
      const { resolveDeployment } = require('../out/authConfig');
      const deployment = resolveDeployment();
      const fixture = `const vscode = require('vscode');
const fs = require('node:fs');
exports.activate = async (context) => {
  // Fake tokens may reach only the disposable local test server.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => new URL(url).hostname === '127.0.0.1'
    ? realFetch(url, init) : Promise.reject(new Error('Fixture network disabled'));
  if (${JSON.stringify(mode)} === 'legacy') {
    context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('easelian.remote-device-hub', {
      provideMcpServerDefinitions: () => [new vscode.McpHttpServerDefinition('remote-device-hub',
        vscode.Uri.parse('http://127.0.0.1:9/mcp'), {Authorization: 'Bearer ' + ${JSON.stringify(access)}})]
    }));
  } else {
    await context.secrets.store(${JSON.stringify(deployment.credentialNamespace + '.tokens.v1')},
      JSON.stringify({access_token:${JSON.stringify(access)}, refresh_token:${JSON.stringify(refresh)},
        client_id:'fixture-client', _issuer:${JSON.stringify(deployment.mcpOrigin + '/')},
        _got_at:Date.now()/1000, expires_in:3600}));
    require('./out/extension.bundle.js').activate(context);
    const http = require('node:http');
    const seen = [];
    const server = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) { body += chunk; }
      seen.push(request.headers.authorization);
      response.writeHead(200, {'content-type':'application/json'});
      response.end(JSON.stringify({jsonrpc:'2.0', id:JSON.parse(body).id, result:{tools:[]}}));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { McpProxy } = require(${JSON.stringify(path.join(root, 'out', 'mcpProxy.js'))});
    const token = {access_token:${JSON.stringify(access)}, refresh_token:${JSON.stringify(refresh)},
      client_id:'runtime-fixture', _issuer:'fixture'};
    const proxy = new McpProxy({getToken:async()=>token, getAcceptedToken:async()=>token,
      onDidChange:()=>({dispose(){}})}, {warn(){}},
      {mcpUri:'http://127.0.0.1:' + server.address().port + '/mcp'});
    try {
      // The extension host's own runtime must be able to serve and forward.
      const launch = await proxy.launch();
      const reply = await realFetch(launch.uri, {method:'POST',
        headers:{...launch.headers, 'content-type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/list', params:{}})});
      const message = await reply.json();
      if (message.id !== 1 || !Array.isArray(message.result.tools)
        || seen[0] !== 'Bearer ' + ${JSON.stringify(access)}) {
        throw new Error('Unexpected proxy response');
      }
    } finally { proxy.dispose(); server.closeAllConnections(); server.close(); }
  }
  fs.writeFileSync(${JSON.stringify(path.join(directory, 'activated'))}, 'ready');
  setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 5000);
};`;
      await fs.writeFile(path.join(extension, 'fixture.cjs'), fixture);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.VSCODE_IPC_HOOK_CLI;
      const child = spawn(
        executable,
        [
          '--user-data-dir',
          profile,
          '--extensions-dir',
          path.join(directory, 'extensions'),
          '--extensionDevelopmentPath=' + extension,
          '--new-window',
          '--skip-welcome',
          '--skip-release-notes',
          '--disable-workspace-trust',
          workspace,
        ],
        { env, stdio: 'ignore', detached: process.platform !== 'win32' },
      );
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          // The editor starts helpers of its own; end the whole group.
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill();
          }
          reject(new Error('Disposable VS Code host did not finish'));
        }, 45000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            reject(new Error(`Disposable VS Code exited with code ${code}`));
          } else {
            resolve();
          }
        });
      });
      assert.equal(await fs.readFile(path.join(directory, 'activated'), 'utf8'), 'ready');
      const storage = path.join(profile, 'User', 'workspaceStorage');
      let cache;
      for (const workspaceId of await fs.readdir(storage)) {
        const file = path.join(storage, workspaceId, 'state.vscdb');
        try {
          const database = new DatabaseSync(file, { readOnly: true });
          const row = database
            .prepare("SELECT value FROM ItemTable WHERE key = 'mcp.extCachedServers'")
            .get();
          database.close();
          if (row?.value) {
            cache = String(row.value);
          }
        } catch (error) {
          if (error.code !== 'ERR_SQLITE_ERROR') {
            throw error;
          }
        }
      }
      assert.ok(cache, 'Host must actually persist an MCP discovery cache');
      const serialized = JSON.parse(cache);
      assert.ok(Object.values(serialized).some((entry) => entry.servers.length === 1));
      assert.equal(cache.includes(access), mode === 'legacy');
      assert.equal(cache.includes(refresh), false);
      if (mode === 'proxy') {
        assert.ok(cache.includes('127.0.0.1'));
        assert.ok(cache.includes('rdh-local-'));
      }
      console.log(
        `${mode}: real VS Code cache ${mode === 'legacy' ? 'reproduced plaintext token' : 'contains no OAuth token'}`,
      );
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
