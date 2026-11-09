const { app, BrowserWindow } = require('electron');
const { startServer } = require('../src/server/index.js');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  let server, port;
  try {
    const res = await startServer(0);
    server = res.server;
    port = res.port;

    // Seed search history for realistic search screenshot
    const storeService = require('../src/server/services/storeService.js');
    storeService.updateSearchHistory('clear');
    for (const kw of ['万妖图录传', '持械入宋', '全球死考', '李柯以', '玄幻', '都市战神']) {
      await storeService.updateSearchHistory('add', kw);
    }

    const win = new BrowserWindow({
      width: 1280,
      height: 840,
      title: '红果开源播放器',
      backgroundColor: '#0f1015',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: false
      }
    });

    const screensDir = path.resolve(__dirname, '../docs/screenshots');

    // Helper to capture and save JPG
    async function capture(filename) {
      // Small pause to allow layout & paints to settle
      await new Promise(r => setTimeout(r, 600));
      const image = await win.webContents.capturePage();
      const target = path.join(screensDir, filename);
      fs.writeFileSync(target, image.toJPEG(92));
      console.log(`Saved ${filename}: ${image.getSize().width}x${image.getSize().height} (${Math.round(fs.statSync(target).size / 1024)} KB)`);
    }

    console.log('Loading app URL...');
    await win.loadURL(`http://127.0.0.1:${port}`);
    await new Promise(r => setTimeout(r, 3500));

    // 1. Catalog overview
    console.log('1. Capturing catalog-overview.jpg...');
    await capture('catalog-overview.jpg');

    // 2. Search history dropdown
    console.log('2. Capturing search-history.jpg...');
    await win.webContents.executeJavaScript(`
      (() => {
        const input = document.querySelector('.search-input');
        if (input) {
          input.focus();
        }
      })();
    `);
    await new Promise(r => setTimeout(r, 800));
    await capture('search-history.jpg');

    // Close search dropdown
    await win.webContents.executeJavaScript(`
      (() => {
        const input = document.querySelector('.search-input');
        if (input) input.blur();
      })();
    `);
    await new Promise(r => setTimeout(r, 500));

    // 3. Actor Ranking tab
    console.log('3. Capturing actor-ranking.jpg...');
    await win.webContents.executeJavaScript(`
      (() => {
        const vue = document.querySelector('#app')._vnode.component.proxy;
        vue.switchTab('actors');
      })();
    `);
    await new Promise(r => setTimeout(r, 3000));
    await capture('actor-ranking.jpg');

    // 4. Theater playback with multi-season drama
    console.log('4. Capturing theater-playback.jpg with multi-season sidebar...');
    await win.webContents.executeJavaScript(`
      (async () => {
        const vue = document.querySelector('#app')._vnode.component.proxy;
        await vue.openTheater({
          series_id: '7621200213801176126',
          series_title: '万妖图录传第一季'
        });
      })();
    `);
    // Wait for series and seasons to load
    await new Promise(r => setTimeout(r, 4500));
    await capture('theater-playback.jpg');

    // 5. Series seasons dialog with sorted cards & new playing equalizer style
    console.log('5. Capturing series-seasons.jpg (multi-season dialog)...');
    await win.webContents.executeJavaScript(`
      (() => {
        const vue = document.querySelector('#app')._vnode.component.proxy;
        vue.openSeasonsModal();
      })();
    `);
    await new Promise(r => setTimeout(r, 1200));
    await capture('series-seasons.jpg');

    console.log('All screenshots captured successfully!');
    win.close();
    server.close();
    app.quit();
  } catch (err) {
    console.error('Capture error:', err);
    if (server) server.close();
    app.exit(1);
  }
});
