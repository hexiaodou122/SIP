// 渲染进程和主进程之间的小桥，只放行固定的几个频道
const { contextBridge, ipcRenderer } = require('electron');

const SEND = [
  'pour-start', 'pour-end', 'cup-busy', 'cup-retracted',
  'save-settings', 'onboarding-done', 'close-window',
];
const INVOKE = ['water-ready', 'cup-ready', 'get-settings'];
const ON = [
  'state', 'drink', 'stream-start', 'evaporate', 'geometry', 'hidden',
  'cup-show', 'cup-hide',
];

contextBridge.exposeInMainWorld('sip', {
  send(channel, data) {
    if (SEND.includes(channel)) ipcRenderer.send(channel, data);
  },
  invoke(channel, data) {
    if (INVOKE.includes(channel)) return ipcRenderer.invoke(channel, data);
    return Promise.reject(new Error('channel not allowed: ' + channel));
  },
  on(channel, cb) {
    if (!ON.includes(channel)) return () => {};
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
