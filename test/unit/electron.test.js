const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

for (const platform of ['darwin', 'win32', 'linux']) test(`desktop lifecycle and packaged window options on ${platform}`, async () => {
  const app = new EventEmitter();
  Object.assign(app, { commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getPath: () => '/tmp/player-user', setAboutPanelOptions() {}, quit() {} });
  const windows = [];
  class Window extends EventEmitter {
    static getAllWindows() { return windows.filter(w => !w.closed); }
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.reload = () => { this.reloads = (this.reloads || 0) + 1; }; this.webContents.setWindowOpenHandler = handler => { this.open = handler; }; windows.push(this); }
    async loadURL() { this.emit('ready-to-show'); }
    show() { this.shown = true; }
    focus() {}
  }
  let starts = 0;
  let lastMenuTemplate = [];
  let openedUrl = null;
  const context = { console, process: { platform, env: {} }, __dirname: '/repo/src/electron',
    require(name) {
      if (name === 'electron') return { app, BrowserWindow: Window,
        Menu: { buildFromTemplate(tmpl) { lastMenuTemplate = tmpl; return tmpl; }, setApplicationMenu() {} },
        shell: { openExternal: async (url) => { openedUrl = url; }, openPath: async () => {} },
        dialog: { showErrorBox() {}, showMessageBox: async () => ({ response: 0 }) } };
      if (name === '../server/index.js') return { startServer: async () => { starts++; return { server: { close() {} }, port: 8899 }; } };
      if (name === '../server/services/logger') return require('../../src/server/services/logger');
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/electron/main.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows[0].shown, true);
  windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows[0].reloads, 1);
  assert.ok(require('../../package.json').build.files.includes('build/icon.png'));
  if (platform === 'win32') {
    assert.equal(windows[0].options.titleBarStyle, 'hidden');
    assert.equal(windows[0].options.titleBarOverlay.height, 40);
    assert.ok(require('../../package.json').build.files.includes('build/icon.ico'));
  }
  windows[0].closed = true;
  windows[0].emit('closed');
  app.emit('activate');
  app.emit('activate');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  for (const name of ['will-navigate', 'will-redirect']) {
    let blocked = 0;
    for (const url of ['bad url', 'file:///etc/passwd', 'https://elsewhere.example']) windows[1].webContents.emit(name, { preventDefault() { blocked++; } }, url);
    assert.equal(blocked, 3);
  }
  assert.equal(windows[1].shown, true);
  assert.equal(windows.length, 2);
  assert.equal(windows[1].open({ url: 'file:///etc/passwd' }).action, 'deny');
  const helpMenu = lastMenuTemplate.find(m => m.label === '帮助');
  assert.ok(helpMenu);
  const aboutHelp = helpMenu.submenu.find(i => i.label === '关于 红果开源播放器');
  assert.ok(aboutHelp);
  aboutHelp.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(openedUrl, 'https://github.com/zfdang/hongguo-open-player');
});

test('packaging artifact names use english hongguo-open-player without breaking chinese productName', () => {
  const pkg = require('../../package.json');
  assert.equal(pkg.build.productName, '红果开源播放器');
  assert.ok(pkg.build.artifactName.startsWith('${name}-'));
  assert.equal(pkg.build.mac.artifactName, '${name}-${version}-mac-${arch}.${ext}');
  assert.equal(pkg.build.win.artifactName, '${name}-${version}-win-${arch}.${ext}');
  assert.equal(pkg.build.nsis.artifactName, '${name}-${version}-win-${arch}-setup.${ext}');
  assert.equal(pkg.build.portable.artifactName, '${name}-${version}-win-${arch}-portable.${ext}');
  for (const pattern of [
    pkg.build.artifactName,
    pkg.build.mac.artifactName,
    pkg.build.win.artifactName,
    pkg.build.nsis.artifactName,
    pkg.build.portable.artifactName,
  ]) {
    assert.ok(/^[\w-${}.]+$/.test(pattern), `Pattern ${pattern} contains disallowed characters`);
  }
});
