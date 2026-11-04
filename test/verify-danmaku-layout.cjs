// Run with: ./node_modules/.bin/electron test/verify-danmaku-layout.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: true, width: 800, height: 500, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await window.loadURL('about:blank');
  const library = path.resolve(__dirname, '../src/client/js/danmaku.dom.js');
  const result = await window.webContents.executeJavaScript(`(async () => {
    const Danmaku = require(${JSON.stringify(library)});
    const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    let maxVisible = 0;
    for (const height of [32, 96, 160]) {
      document.body.innerHTML = '<div id="stage" style="width:640px;height:' + height + 'px;overflow:hidden;position:relative"></div>';
      const stage = document.getElementById('stage');
      const media = new EventTarget();
      media.currentTime = 0; media.playbackRate = 1; media.paused = false;
      const comments = Array.from({length: 200}, (_, i) => ({time: i * 0.1, text: i % 3 ? '短弹幕' : '很长的测试弹幕用来检查不同文字长度造成的碰撞', style: {fontSize:'20px', lineHeight:'30px'}}));
      const engine = new Danmaku({container:stage, media, comments, speed:64});
      for (let n = 1; n <= 100; n++) {
        media.currentTime = n * 0.2;
        await frames();
        const bounds = stage.getBoundingClientRect();
        const nodes = Array.from(stage.firstChild.children).map(node => node.getBoundingClientRect()).filter(rect => rect.right > bounds.left && rect.left < bounds.right);
        maxVisible = Math.max(maxVisible, nodes.length);
        for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          if (a.top < b.bottom && b.top < a.bottom && Math.max(a.left, b.left) - Math.min(a.right, b.right) < 7.9) throw new Error('Comments overlap or lack spacing at height ' + height + ', time ' + media.currentTime);
        }
      }
      engine.destroy();
    }
    document.body.innerHTML = '<div id="stage" style="width:640px;height:160px"></div>';
    const stage = document.getElementById('stage');
    const media = new EventTarget();
    media.currentTime = 0; media.playbackRate = 2; media.paused = true;
    const comments = [0, 2, 2, 5, 12, 20].map((time, i) => ({ time, text:'弹幕' + i, style:{fontSize:'20px', lineHeight:'30px'} }));
    const engine = new Danmaku({ container:stage, media, comments, speed:64 });
    media.currentTime = 10; media.dispatchEvent(new Event('seeking'));
    const visible = engine._.runningList.map(c => c.text);
    if (!visible.includes('弹幕1') || !visible.includes('弹幕2') || !visible.includes('弹幕3') || visible.includes('弹幕4')) throw new Error('Paused seek did not restore in-flight comments: ' + visible);
    media.currentTime = 3; media.dispatchEvent(new Event('seeking'));
    if (!engine._.runningList.some(c => c.text === '弹幕1') || engine._.runningList.some(c => c.text === '弹幕3')) throw new Error('Backward seek did not restore the correct comments');
    engine.destroy();
    return {maxVisible};
  })()`);
  if (!result.maxVisible) throw new Error('Test did not exercise dense comments');
  console.log('Danmaku layout verified:', result);
  window.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
