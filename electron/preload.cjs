const { contextBridge, ipcRenderer } = require('electron');

const GET_API_KEY_CHANNEL = 'tournament-secure:get-api-key';
const SET_API_KEY_CHANNEL = 'tournament-secure:set-api-key';

contextBridge.exposeInMainWorld('tournamentSecure', Object.freeze({
  getApiKey: () => ipcRenderer.invoke(GET_API_KEY_CHANNEL),
  setApiKey: (key) => {
    if (key !== null && typeof key !== 'string') return Promise.reject(new TypeError('API key must be a string or null'));
    return ipcRenderer.invoke(SET_API_KEY_CHANNEL, key);
  },
}));
