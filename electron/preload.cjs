const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name) => (...args) => ipcRenderer.invoke(`fengsha:${name}`, ...args);
contextBridge.exposeInMainWorld('fengsha', {
  snapshot: invoke('snapshot'), parse: invoke('parse'), enqueue: invoke('enqueue'),
  creatorIdentify: invoke('creator-identify'), creatorPage: invoke('creator-page'), creatorLast: invoke('creator-last'), creatorCancel: invoke('creator-cancel'), creatorRecover: invoke('creator-recover'),
  creatorRefresh: invoke('creator-refresh'),
  userSearch: invoke('user-search'), userSearchMore: invoke('user-search-more'), userSearchLast: invoke('user-search-last'), userSearchCancel: invoke('user-search-cancel'), userSearchShow: invoke('user-search-show'),
  action: invoke('action'), saveSettings: invoke('settings'), chooseFolder: invoke('folder'),
  login: invoke('login'), accounts: invoke('accounts'), addAccount: invoke('account-add'), importAccount: invoke('account-import'), accountAction: invoke('account-action'), environment: invoke('environment'),
  openFile: invoke('open-file'), locateFile: invoke('locate-file'), relocate: invoke('relocate'),
  updateTags: invoke('tags'), openSource: invoke('source'), windowAction: invoke('window'),
  clipboard: invoke('clipboard'), openHelp: invoke('help'),
  aiSave: invoke('ai-save'), aiModels: invoke('ai-models'), aiTest: invoke('ai-test'),
  transcriptionFolder: invoke('transcription-folder'), transcriptionChoose: invoke('transcription-choose'), transcriptionStart: invoke('transcription-start'), transcriptionGet: invoke('transcription-get'), transcriptionAction: invoke('transcription-action'), transcriptionArchive: invoke('transcription-archive'), transcriptionUnarchive: invoke('transcription-unarchive'), transcriptionExport: invoke('transcription-export'),
  collectorSave: invoke('collector-save'), collectorTest: invoke('collector-test'), openGuide: invoke('guide'),
  collectorPrepare:invoke('collector-prepare'),collectorAllow:invoke('collector-allow'),collectorRestore:invoke('collector-restore'),collectorStatus:invoke('collector-status'),
  transcriptionSearch: invoke('transcription-search'),
  transcriptionDraft: invoke('transcription-draft'),
  transcriptionSource: invoke('transcription-source'),
  onCreatorChange(callback) { const listener = (_event, value) => callback(value); ipcRenderer.on('fengsha:creator-changed', listener); return () => ipcRenderer.removeListener('fengsha:creator-changed', listener); },
  onChange(callback) { const listener = (_event, value) => callback(value); ipcRenderer.on('fengsha:changed', listener); return () => ipcRenderer.removeListener('fengsha:changed', listener); }
});
