import { createWebUiStreamState, reduceClaudeSseData } from './stream-adapter.js';

function escapeForTemplateLiteral(source: string): string {
  return source.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function buildScript(): string {
  const createStateSource = createWebUiStreamState.toString();
  const reduceSource = reduceClaudeSseData.toString();

  return `(() => {
  const createWebUiStreamState = ${createStateSource};
  const reduceClaudeSseData = ${reduceSource};

  const state = {
    apiKey: '',
    models: [],
    selectedModel: '',
    history: [],
    running: false,
    abortController: null,
  };

  const els = {
    apiKey: document.getElementById('api-key'),
    saveKey: document.getElementById('save-key'),
    model: document.getElementById('model-select'),
    refreshModels: document.getElementById('refresh-models'),
    messages: document.getElementById('messages'),
    prompt: document.getElementById('prompt'),
    send: document.getElementById('send-btn'),
    stop: document.getElementById('stop-btn'),
    clear: document.getElementById('clear-btn'),
    status: document.getElementById('status-text'),
  };

  function setStatus(text, isError = false) {
    els.status.textContent = text;
    els.status.classList.toggle('error', isError);
  }

  function renderMessages() {
    if (state.history.length === 0) {
      els.messages.innerHTML = '<div class="empty">开始对话吧。页面不会保存 API key；刷新页面后需重新输入。</div>';
      return;
    }
    const html = state.history
      .map((item) => {
        const role = item.role === 'user' ? 'user' : 'assistant';
        const safe = String(item.text)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
        return '<div class="msg ' + role + '"><div class="role">' + role + '</div><pre>' + safe + '</pre></div>';
      })
      .join('');
    els.messages.innerHTML = html;
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function syncButtons() {
    const canSend = !state.running && !!state.selectedModel && !!state.apiKey && !!els.prompt.value.trim();
    els.send.disabled = !canSend;
    els.stop.disabled = !state.running;
    els.model.disabled = state.running;
    els.refreshModels.disabled = state.running;
    els.clear.disabled = state.running;
    els.saveKey.disabled = state.running;
    els.prompt.disabled = state.running;
  }

  function updateModelSelect() {
    const options = state.models
      .map((model) => '<option value="' + model + '">' + model + '</option>')
      .join('');
    els.model.innerHTML = options || '<option value="">暂无模型</option>';
    if (state.models.includes(state.selectedModel)) {
      els.model.value = state.selectedModel;
    } else {
      state.selectedModel = state.models[0] || '';
      els.model.value = state.selectedModel;
    }
  }

  async function loadModels() {
    if (!state.apiKey) {
      setStatus('请先输入 API key。', true);
      syncButtons();
      return;
    }

    setStatus('正在加载模型...');
    try {
      const response = await fetch('/api/claude/v1/models', {
        headers: {
          'x-api-key': state.apiKey,
          'content-type': 'application/json',
        },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error?.message || '加载模型失败');
      }

      const payload = await response.json();
      state.models = Array.isArray(payload?.data)
        ? payload.data.map((x) => x?.id).filter((id) => typeof id === 'string')
        : [];
      updateModelSelect();
      setStatus(state.models.length > 0 ? '模型已加载。' : '未获取到可用模型。', state.models.length === 0);
    } catch (error) {
      state.models = [];
      updateModelSelect();
      setStatus(error instanceof Error ? error.message : '加载模型失败', true);
    }
    syncButtons();
  }

  function buildClaudeMessages() {
    return state.history.map((item) => ({ role: item.role, content: item.text }));
  }

  function stopGeneration() {
    if (state.abortController) {
      state.abortController.abort();
    }
  }

  async function sendMessage() {
    const prompt = els.prompt.value.trim();
    if (!prompt || !state.selectedModel || !state.apiKey || state.running) return;

    state.running = true;
    setStatus('正在生成...');
    syncButtons();

    state.history.push({ role: 'user', text: prompt });
    const assistantMessage = { role: 'assistant', text: '' };
    state.history.push(assistantMessage);
    renderMessages();
    els.prompt.value = '';

    const controller = new AbortController();
    state.abortController = controller;

    try {
      const response = await fetch('/api/claude/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': state.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: state.selectedModel,
          max_tokens: 2048,
          stream: true,
          messages: buildClaudeMessages(),
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error?.message || '请求失败');
      }

      if (!response.body) {
        throw new Error('流式响应不可用');
      }

      const streamState = createWebUiStreamState();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let done = false;

      while (!done) {
        const result = await reader.read();
        if (result.done) break;
        pending += decoder.decode(result.value, { stream: true });

        while (true) {
          const end = pending.indexOf('\n\n');
          if (end === -1) break;
          const block = pending.slice(0, end);
          pending = pending.slice(end + 2);

          const dataLines = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .filter(Boolean);
          if (dataLines.length === 0) continue;

          const delta = reduceClaudeSseData(streamState, dataLines.join('\n'));
          if (delta.textDelta) {
            assistantMessage.text += delta.textDelta;
            renderMessages();
          }
          if (delta.errorMessage) {
            throw new Error(delta.errorMessage);
          }
          if (delta.done) {
            done = true;
            break;
          }
        }
      }

      if (!assistantMessage.text) {
        assistantMessage.text = '[无可显示文本输出]';
        renderMessages();
      }
      setStatus('完成。');
    } catch (error) {
      if (controller.signal.aborted) {
        setStatus('已停止生成。');
      } else {
        const message = error instanceof Error ? error.message : '请求失败';
        setStatus(message, true);
        if (!assistantMessage.text) {
          assistantMessage.text = '[请求失败]';
          renderMessages();
        }
      }
    } finally {
      state.running = false;
      state.abortController = null;
      syncButtons();
      renderMessages();
    }
  }

  els.saveKey.addEventListener('click', () => {
    state.apiKey = String(els.apiKey.value || '').trim();
    if (!state.apiKey) {
      setStatus('请输入 API key。', true);
      syncButtons();
      return;
    }
    setStatus('API key 已设置（仅保存在内存）。');
    loadModels();
    syncButtons();
  });

  els.model.addEventListener('change', () => {
    state.selectedModel = els.model.value;
    syncButtons();
  });
  els.refreshModels.addEventListener('click', loadModels);
  els.prompt.addEventListener('input', syncButtons);
  els.send.addEventListener('click', sendMessage);
  els.stop.addEventListener('click', stopGeneration);
  els.clear.addEventListener('click', () => {
    state.history = [];
    renderMessages();
    setStatus('会话已清空。');
    syncButtons();
  });

  els.prompt.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      sendMessage();
    }
  });

  updateModelSelect();
  renderMessages();
  syncButtons();
  setStatus('请输入 API key 并加载模型。');
})();`;
}

const WEB_UI_STYLE = `:root {
  color-scheme: light dark;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
}
body {
  margin: 0;
  background: #111827;
  color: #e5e7eb;
}
main {
  max-width: 960px;
  margin: 0 auto;
  padding: 16px;
  display: grid;
  gap: 12px;
}
.card {
  background: #1f2937;
  border: 1px solid #374151;
  border-radius: 10px;
  padding: 12px;
}
.controls {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(12, minmax(0, 1fr));
}
.controls label,
.controls input,
.controls select,
.controls button,
.controls textarea {
  font: inherit;
}
#api-key { grid-column: span 7; }
#save-key { grid-column: span 2; }
#model-select { grid-column: span 2; }
#refresh-models { grid-column: span 1; }
#messages {
  min-height: 45vh;
  max-height: 55vh;
  overflow: auto;
  display: grid;
  gap: 8px;
}
.msg {
  border: 1px solid #4b5563;
  border-radius: 8px;
  padding: 8px;
}
.msg.user { background: #0f172a; }
.msg.assistant { background: #111827; }
.msg .role {
  font-size: 12px;
  text-transform: uppercase;
  opacity: 0.8;
  margin-bottom: 6px;
}
.msg pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.empty {
  opacity: 0.8;
  font-size: 14px;
}
#prompt {
  width: 100%;
  min-height: 120px;
  resize: vertical;
  box-sizing: border-box;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
button {
  border: 1px solid #4b5563;
  background: #374151;
  color: inherit;
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
#status-text {
  font-size: 13px;
}
#status-text.error {
  color: #fca5a5;
}
.warning {
  font-size: 12px;
  opacity: 0.8;
}
@media (max-width: 768px) {
  #api-key { grid-column: span 12; }
  #save-key { grid-column: span 4; }
  #model-select { grid-column: span 6; }
  #refresh-models { grid-column: span 2; }
}`;

export function buildWebUiHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>kiro2claude Web UI</title>
    <style>${escapeForTemplateLiteral(WEB_UI_STYLE)}</style>
  </head>
  <body>
    <main>
      <h1>kiro2claude Web UI (MVP)</h1>
      <div class="card controls">
        <input id="api-key" type="password" placeholder="输入 KIRO2CLAUDE_API_KEY" autocomplete="off" />
        <button id="save-key" type="button">设置 Key</button>
        <select id="model-select" aria-label="模型选择"></select>
        <button id="refresh-models" type="button">刷新</button>
      </div>

      <div class="card" id="messages"></div>

      <div class="card">
        <textarea id="prompt" placeholder="输入消息，Ctrl/Cmd + Enter 发送"></textarea>
        <div class="actions">
          <button id="send-btn" type="button">发送</button>
          <button id="stop-btn" type="button">停止</button>
          <button id="clear-btn" type="button">清空会话</button>
          <span id="status-text"></span>
        </div>
        <div class="warning">API key 仅保存在当前页面内存，不会写入 localStorage。</div>
      </div>
    </main>
    <script>${escapeForTemplateLiteral(buildScript())}</script>
  </body>
</html>`;
}
