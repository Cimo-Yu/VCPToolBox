// VCPBridge Popup Script v1.1.0
const statusBar = document.getElementById('statusBar');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const wsHostInput = document.getElementById('wsHost');
const vcpKeyInput = document.getElementById('vcpKey');
const keyStatus = document.getElementById('keyStatus');
const connectBtn = document.getElementById('connectBtn');
const feedBtn = document.getElementById('feedBtn');

// 初始化
chrome.runtime.sendMessage({ type: 'getConnectionStatus' }, (response) => {
  if (response) {
    updateStatus(response.connected);
    wsHostInput.value = response.wsHost || 'localhost:6015';
    keyStatus.textContent = response.vcpKey === '已配置' ? '🔑 密钥已配置' : '⚠️ 密钥未配置';
    keyStatus.style.color = response.vcpKey === '已配置' ? '#81c784' : '#ff8a65';
  }
});

// 从storage加载已保存的key（只显示状态，不回显密码）
chrome.storage.local.get(['vcpWsHost', 'vcpKey'], (result) => {
  if (result.vcpWsHost) wsHostInput.value = result.vcpWsHost;
  if (result.vcpKey) {
    vcpKeyInput.placeholder = '密钥已保存（留空则不修改）';
  }
});

function updateStatus(connected) {
  if (connected) {
    statusBar.className = 'status connected';
    statusDot.className = 'dot on';
    statusText.textContent = '✅ 已连接到VCP';
  } else {
    statusBar.className = 'status disconnected';
    statusDot.className = 'dot off';
    statusText.textContent = '未连接';
  }
}

connectBtn.addEventListener('click', () => {
  const host = wsHostInput.value.trim();
  const key = vcpKeyInput.value.trim();

  const config = {};
  if (host) config.host = host;
  if (key) config.key = key;

  chrome.runtime.sendMessage({ type: 'updateConfig', ...config }, (response) => {
    statusText.textContent = '正在连接...';
    if (key) {
      keyStatus.textContent = '🔑 密钥已更新';
      keyStatus.style.color = '#81c784';
      vcpKeyInput.value = '';
      vcpKeyInput.placeholder = '密钥已保存（留空则不修改）';
    }
  });
});

feedBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'extract',
        extractType: 'generic',
        options: {}
      });
      chrome.runtime.sendMessage({
        type: 'feedToServer',
        data: {
          extract_type: 'generic',
          extractedData: response.data,
          sourceUrl: tab.url
        }
      });
      feedBtn.textContent = '✅ 已投喂！';
      setTimeout(() => { feedBtn.textContent = '📤 投喂当前页面'; }, 2000);
    } catch (e) {
      feedBtn.textContent = '❌ 失败';
      setTimeout(() => { feedBtn.textContent = '📤 投喂当前页面'; }, 2000);
    }
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'connectionStatus') {
    updateStatus(message.connected);
  }
});