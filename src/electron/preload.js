// SPDX-License-Identifier: GPL-3.0-only
// 预加载脚本：以安全方式向渲染进程暴露桌面设置能力（如老板键全局快捷键）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hongguoDesktop', {
  // 读取桌面设置（老板键等）
  getSettings: () => ipcRenderer.invoke('settings:get'),
  // 设置老板键（传入 Electron 快捷键字符串，传 null 清除）
  setBossKey: (accelerator) => ipcRenderer.invoke('settings:setBossKey', accelerator)
});
