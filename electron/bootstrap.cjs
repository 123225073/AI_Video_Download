const { app, dialog } = require('electron');
import('./main.js').catch(error => {
  console.error('Fengsha startup failed:', error.stack || error);
  if (process.env.FENGSHA_TEST_MODE !== '1' && !process.argv.includes('--agent-background')) dialog.showErrorBox('风沙下载器启动失败', String(error.message));
  app.quit();
});
