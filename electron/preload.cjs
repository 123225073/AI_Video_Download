const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name) => (...args) => ipcRenderer.invoke(`fengsha:${name}`, ...args);
contextBridge.exposeInMainWorld('fengsha', {
  snapshot: invoke('snapshot'), parse: invoke('parse'), enqueue: invoke('enqueue'),
  contentSearch:invoke('content-search'),contentMore:invoke('content-more'),contentLast:invoke('content-last'),contentCancel:invoke('content-cancel'),contentShow:invoke('content-show'),contentClone:invoke('content-clone'),contentSource:invoke('content-source'),contentDrafts:invoke('content-drafts'),contentDraftLast:invoke('content-draft-last'),contentDraftGet:invoke('content-draft-get'),contentDraftSave:invoke('content-draft-save'),contentAssetsAdd:invoke('content-assets-add'),contentImageEdit:invoke('content-image-edit'),contentRenderVideo:invoke('content-render-video'),contentVideoPreview:invoke('content-video-preview'),contentExport:invoke('content-export'),contentPublishOpen:invoke('content-publish-open'),contentPublishFill:invoke('content-publish-fill'),
  creatorIdentify: invoke('creator-identify'), creatorPage: invoke('creator-page'), creatorLast: invoke('creator-last'), creatorCancel: invoke('creator-cancel'), creatorRecover: invoke('creator-recover'),
  creatorRefresh: invoke('creator-refresh'),
  userSearch: invoke('user-search'), userSearchMore: invoke('user-search-more'), userSearchLast: invoke('user-search-last'), userSearchCancel: invoke('user-search-cancel'), userSearchShow: invoke('user-search-show'),
  action: invoke('action'), saveSettings: invoke('settings'), chooseFolder: invoke('folder'),
  voiceSave:invoke('voice-save'),voiceClone:invoke('voice-clone'),voiceStatus:invoke('voice-status'),voicePreview:invoke('voice-preview'),contentVoiceReview:invoke('content-voice-review'),contentVoiceApprove:invoke('content-voice-approve'),contentVoiceGenerate:invoke('content-voice-generate'),
  contentRemix:invoke('content-remix'),
  contentAutoRemix:invoke('content-auto-remix'),
  contentVideoFrames:invoke('content-video-frames'),
  contentPublishSubmit:invoke('content-publish-submit'),
  commentsStart:invoke('comments-start'),commentsMore:invoke('comments-more'),commentsLast:invoke('comments-last'),commentsExport:invoke('comments-export'),commentsShow:invoke('comments-show'),commentsCancel:invoke('comments-cancel'),contactPrepare:invoke('contact-prepare'),contactSend:invoke('contact-send'),contactBatchPreview:invoke('contact-batch-preview'),contactBatchSend:invoke('contact-batch-send'),contactBatchLast:invoke('contact-batch-last'),contactCancel:invoke('contact-cancel'),
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
