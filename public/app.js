'use strict';

(() => {
  const THEME_STORAGE_KEY = 'uubridge.theme';
  const themeButtons = [...document.querySelectorAll('[data-theme-choice]')];
  const colorSchemeMedia = window.matchMedia?.('(prefers-color-scheme: dark)');

  function readSavedTheme() {
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
    } catch {
      return 'system';
    }
  }

  function applyTheme(mode) {
    const normalized = mode === 'light' || mode === 'dark' ? mode : 'system';
    document.documentElement.dataset.theme = normalized;
    const effective = normalized === 'system' ? (colorSchemeMedia?.matches ? 'dark' : 'light') : normalized;
    document.documentElement.style.colorScheme = effective;
    for (const button of themeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === normalized));
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, normalized);
    } catch {
      // Ignore private browsing storage restrictions.
    }
  }

  applyTheme(readSavedTheme());
  for (const button of themeButtons) {
    button.addEventListener('click', () => applyTheme(button.dataset.themeChoice));
  }
  colorSchemeMedia?.addEventListener?.('change', () => {
    if (readSavedTheme() === 'system') applyTheme('system');
  });

  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'nativeStatus', 'screenStatus', 'accessStatus', 'uuStatus', 'screenPermission',
    'accessPermission', 'windowSelect', 'windowDescription', 'refreshWindows', 'openUU',
    'streamToggle', 'streamButtonText', 'streamButtonIcon', 'streamStatus', 'streamDot',
    'windowKind', 'viewport', 'frameSurface', 'frame', 'frameInfo', 'emptyState',
    'emptyTitle', 'emptyDescription', 'zoom', 'controlToggle', 'controlDescription',
    'inputHint', 'textForm', 'textInput', 'sendText', 'openTest', 'notice', 'openWebController',
    'copyMcpConfig',
  ].map((id) => [id, $(id)]));
  const state = {
    token: '', mcpEntry: '', status: null, windows: [], selectedId: null, selectionVersion: null, selecting: false,
    streaming: false, frameReady: false, frameBusy: false, frameTimer: null,
    frameAbort: null, frameEpoch: 0, frameURL: null, statusPromise: null,
    windowsPromise: null, statusTimer: null, control: false, pointer: null,
    inputQueue: [], inputBusy: false, inputWaiters: [], lastFrameAt: 0,
  };

  function notify(message, tone = '') {
    ui.notice.textContent = message;
    ui.notice.dataset.tone = tone;
  }

  async function request(path, body, signal) {
    const headers = { 'X-UUBridge-Token': state.token };
    const options = { method: body === undefined ? 'GET' : 'POST', headers, signal, cache: 'no-store' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    const json = (response.headers.get('content-type') || '').includes('application/json');
    if (!response.ok) {
      const data = json ? await response.json() : null;
      throw new Error(data?.error || data?.message || `请求失败（HTTP ${response.status}）`);
    }
    if (path.startsWith('/api/frame?')) {
      if (Number(response.headers.get('X-Window-Id')) !== Number(state.selectedId) ||
          Number(response.headers.get('X-Selection-Version')) !== state.selectionVersion) {
        throw new Error('画面目标已改变，请重新选择窗口。');
      }
      if (json) {
        const data = await response.json();
        throw new Error(data.error || data.message || '服务未返回窗口图像。');
      }
      if (!(response.headers.get('content-type') || '').startsWith('image/')) {
        throw new Error('窗口画面响应格式不正确。');
      }
      return response.blob();
    }
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  function selectedWindow() {
    return state.windows.find((window) => String(window.id) === String(state.selectedId));
  }

  function readyToStream() {
    return Boolean(state.token && selectedWindow() && !state.selecting &&
      state.status?.nativeAvailable && (state.status?.screenCapture || selectedWindow()?.kind === 'test'));
  }

  function readyToControl() {
    return selectedWindow()?.kind === 'test' && readyToStream() && state.status?.accessibility && state.streaming && state.frameReady &&
      Date.now() - state.lastFrameAt < 5000;
  }

  function setLabel(element, text, good) {
    element.textContent = text;
    element.className = `state-label ${good ? 'good' : 'warning'}`;
  }

  function render() {
    const status = state.status;
    if (status) {
      setLabel(ui.nativeStatus, status.nativeAvailable ? '已就绪' : '不可用', status.nativeAvailable);
      setLabel(ui.screenStatus, status.screenCapture ? '已授权' : '待授权', status.screenCapture);
      setLabel(ui.accessStatus, status.accessibility ? '已授权' : '待授权', status.accessibility);
      setLabel(ui.uuStatus, status.running ? '运行中' : status.installed ? '未运行' : '未安装', status.running);
    }
    const window = selectedWindow();
    ui.windowKind.hidden = window?.kind !== 'test';
    ui.windowKind.textContent = '本机验证 · 应用自身绘制';
    ui.streamToggle.disabled = !readyToStream() && !state.streaming;
    ui.streamToggle.classList.toggle('streaming', state.streaming);
    ui.streamButtonText.textContent = state.streaming ? '暂停画面' : '开始画面';
    ui.streamButtonIcon.textContent = state.streaming ? 'Ⅱ' : '▷';
    ui.streamDot.className = `status-dot ${state.streaming && state.frameReady ? 'active' : 'muted'}`;
    ui.streamStatus.textContent = state.streaming ? (state.frameReady ? '正在采集' : '等待窗口画面') : state.frameReady ? '画面已暂停' : '画面未开始';
    ui.controlToggle.disabled = !readyToControl();
    ui.controlToggle.checked = state.control;
    ui.viewport.classList.toggle('controlling', state.control);
    ui.textInput.disabled = !state.control;
    ui.sendText.disabled = !state.control || !ui.textInput.value.trim();
    ui.inputHint.textContent = state.control ? '本机输入已开启 · 点击画面使用键盘' : '仅查看 · 输入控制已关闭';
    ui.openWebController.hidden = false;
    ui.controlDescription.textContent = window?.kind === 'uu'
      ? '当前 UU 客户端未接受后台模拟输入。此入口用于查看；操作请使用独立的本地网页主控，并在该页面登录 UU。'
      : !status?.accessibility
      ? '需要辅助功能授权，才能向所选本机窗口发送输入。'
      : '开启后，鼠标与键盘输入会发送到所选本机窗口。';
    ui.windowDescription.textContent = window
      ? `${window.owner || 'UU'} · ${window.width} × ${window.height}${window.kind === 'test' ? ' · 本机验证用途' : ''}`
      : '只采集所选窗口，不采集整个桌面。';
    ui.emptyState.hidden = state.frameReady;
    ui.frame.hidden = !state.frameReady;
    if (!state.frameReady) {
      let title = '把 UU 窗口，放到这里。';
      let description = '选择一个窗口，然后点击「开始画面」。';
      if (!state.token) description = '无法连接本机桥接服务。请确认服务已启动后刷新此页。';
      else if (!status) description = '正在检查本机助手和系统权限…';
      else if (!status.nativeAvailable) { title = '本机助手尚未就绪'; description = status.platform !== 'darwin' ? '窗口桥接需要在 macOS 上运行原生助手。' : '请检查原生助手是否已构建，并重新启动桥接服务。'; }
      else if (!status.screenCapture && window?.kind !== 'test') { title = '先允许屏幕录制'; description = '点击右侧「屏幕录制授权」，在 macOS 系统设置中允许桥接助手采集窗口。也可先打开本机验证窗口测试输入。'; }
      else if (!state.windows.length) { title = '还没有可采集的窗口'; description = status.installed ? '打开 UU 并显示主窗口，然后点击「刷新窗口」。也可以打开本机验证窗口。' : '尚未发现 UU 客户端。请先安装并打开官方 UU，或打开本机验证窗口。'; }
      else if (!window) { title = '请选择当前的 UU 窗口'; description = '从右侧列表选择远控窗口，再开始画面。UU 重新连接后可能会创建新窗口。'; }
      else if (state.streaming) { title = '正在获取窗口画面'; description = '请保持所选窗口打开。若采集失败，下方会显示具体原因。'; }
      ui.emptyTitle.textContent = title;
      ui.emptyDescription.textContent = description;
    }
  }

  function applyZoom() {
    const fit = ui.zoom.value === 'fit' || !state.frameReady;
    const width = fit ? '100%' : `${ui.frame.naturalWidth * Number(ui.zoom.value)}px`;
    const height = fit ? '100%' : `${ui.frame.naturalHeight * Number(ui.zoom.value)}px`;
    ui.frameSurface.style.width = width;
    ui.frameSurface.style.height = height;
    ui.frame.style.width = width;
    ui.frame.style.height = height;
  }

  function clearFrame() {
    state.frameEpoch += 1;
    state.frameReady = false;
    state.frameAbort?.abort();
    ui.frame.removeAttribute('src');
    if (state.frameURL) URL.revokeObjectURL(state.frameURL);
    state.frameURL = null;
    ui.frameInfo.textContent = '— × —';
    applyZoom();
  }

  function loadFrame(url, signal) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        ui.frame.removeEventListener('load', loaded);
        ui.frame.removeEventListener('error', failed);
        signal.removeEventListener('abort', aborted);
      };
      const loaded = () => {
        cleanup();
        if (ui.frame.naturalWidth > 0) resolve();
        else reject(new Error('窗口图片为空，请重新开始画面。'));
      };
      const failed = () => { cleanup(); reject(new Error('浏览器无法加载窗口图片，请重新开始画面。')); };
      const aborted = () => { cleanup(); reject(new DOMException('画面加载已取消', 'AbortError')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('窗口图片加载超时，请重新开始画面。')); }, 5000);
      ui.frame.addEventListener('load', loaded);
      ui.frame.addEventListener('error', failed);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      // Embedded browsers can leave decode() pending for off-screen/hidden images.
      // Load the displayed image itself and use its load event and dimensions.
      ui.frame.hidden = false;
      ui.frame.src = url;
      if (ui.frame.complete && ui.frame.naturalWidth > 0) loaded();
    });
  }

  async function refreshStatus() {
    if (state.statusPromise) return state.statusPromise;
    state.statusPromise = (async () => {
      state.status = await request('/api/status');
      if (state.selectedId !== null && (String(state.status.selectedId) !== String(state.selectedId) ||
          state.status.selectionVersion !== state.selectionVersion)) {
        stopStream();
        clearFrame();
        await refreshWindows();
        notify('另一个页面改变了目标窗口，已停止画面与输入。请确认后重新开始。');
      }
      if (!readyToControl() && state.control) await disableControl();
      if (state.streaming && !readyToStream()) stopStream();
      render();
    })().finally(() => { state.statusPromise = null; });
    return state.statusPromise;
  }

  async function refreshWindows() {
    if (state.windowsPromise) return state.windowsPromise;
    ui.refreshWindows.disabled = true;
    state.windowsPromise = (async () => {
      const data = await request('/api/windows');
      state.windows = data.windows;
      const nextId = state.windows.some((window) => String(window.id) === String(data.selectedId))
        ? data.selectedId : null;
      if (String(nextId) !== String(state.selectedId) || data.selectionVersion !== state.selectionVersion) {
        await disableControl();
        stopStream();
        clearFrame();
        state.selectedId = nextId;
        state.selectionVersion = data.selectionVersion;
      }
      if (data.selectedId != null && nextId === null) {
        notify('所选 UU 窗口已关闭或重建，请从列表选择当前的远控窗口。', 'error');
      }
      ui.windowSelect.replaceChildren(new Option(state.windows.length ? '请选择要采集的窗口' : '未发现可采集窗口', ''));
      for (const window of state.windows) {
        const label = `${window.kind === 'test' ? '[验证] ' : ''}${window.title || window.owner || '未命名窗口'} · ${window.width}×${window.height}`;
        ui.windowSelect.add(new Option(label, String(window.id)));
      }
      ui.windowSelect.value = state.selectedId == null ? '' : String(state.selectedId);
      ui.windowSelect.disabled = !state.windows.length || state.selecting;
      render();
    })().finally(() => {
      state.windowsPromise = null;
      ui.refreshWindows.disabled = !state.token;
    });
    return state.windowsPromise;
  }

  function stopStream() {
    state.streaming = false;
    state.lastFrameAt = 0;
    clearTimeout(state.frameTimer);
    state.frameAbort?.abort();
    state.frameEpoch += 1;
    void disableControl();
    render();
  }

  async function pollFrame() {
    if (!state.streaming || state.frameBusy) return;
    state.frameBusy = true;
    state.frameAbort = new AbortController();
    const epoch = state.frameEpoch;
    let nextURL;
    try {
      if (!state.frameReady) notify('正在请求窗口画面…');
      const blob = await request(`/api/frame?windowId=${state.selectedId}&selectionVersion=${state.selectionVersion}`, undefined, state.frameAbort.signal);
      if (!state.frameReady) notify('已收到窗口截图，正在准备显示…');
      if (!state.streaming || epoch !== state.frameEpoch) return;
      nextURL = URL.createObjectURL(blob);
      await loadFrame(nextURL, state.frameAbort.signal);
      if (!state.streaming || epoch !== state.frameEpoch) return;
      const previousURL = state.frameURL;
      state.frameURL = nextURL;
      nextURL = null;
      if (previousURL) URL.revokeObjectURL(previousURL);
      if (!state.frameReady) notify('窗口画面已准备就绪。');
      state.frameReady = true;
      state.lastFrameAt = Date.now();
      ui.frameInfo.textContent = `${ui.frame.naturalWidth} × ${ui.frame.naturalHeight}`;
      applyZoom();
      render();
    } catch (error) {
      if (error.name !== 'AbortError' && epoch === state.frameEpoch) {
        notify(`画面采集失败：${error.message}`, 'error');
        stopStream();
        if (!state.frameReady) {
          ui.emptyTitle.textContent = '暂时无法获取画面';
          ui.emptyDescription.textContent = error.message;
        }
      }
    } finally {
      if (nextURL) URL.revokeObjectURL(nextURL);
      state.frameBusy = false;
      state.frameAbort = null;
      if (state.streaming) state.frameTimer = setTimeout(pollFrame, 500);
    }
  }

  // object-fit can leave black bars inside the img element; exclude those from input.
  function imagePoint(event, clamp = false) {
    if (!state.frameReady || !ui.frame.naturalWidth || Date.now() - state.lastFrameAt > 5000) return null;
    const rect = ui.frame.getBoundingClientRect();
    const scale = Math.min(rect.width / ui.frame.naturalWidth, rect.height / ui.frame.naturalHeight);
    const width = ui.frame.naturalWidth * scale;
    const height = ui.frame.naturalHeight * scale;
    if (!width || !height) return null;
    const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
    const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
    if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }

  function modifiers(event) {
    return [['meta', event.metaKey], ['shift', event.shiftKey], ['alt', event.altKey], ['ctrl', event.ctrlKey]]
      .filter(([, active]) => active).map(([name]) => name);
  }

  function enqueueInput(input) {
    input = { ...input, windowId: state.selectedId, selectionVersion: state.selectionVersion };
    if (input.type === 'move' && state.inputQueue.at(-1)?.type === 'move') state.inputQueue[state.inputQueue.length - 1] = input;
    else state.inputQueue.push(input);
    void drainInput();
  }

  async function drainInput() {
    if (state.inputBusy) return;
    state.inputBusy = true;
    try {
      while (state.inputQueue.length) {
        const input = state.inputQueue.shift();
        const result = await request('/api/input', input);
        if (input.type === 'text') notify(result.message || '文字已发送到本机窗口；远端效果请在 UU 中确认。', 'success');
        if (input.type === 'pointerup' || input.type === 'click') notify('鼠标操作已发送到所选本机窗口；请在画面中确认响应。');
      }
    } catch (error) {
      state.inputQueue = [];
      state.control = false;
      const pointer = state.pointer;
      state.pointer = null;
      if (pointer) {
        try { await request('/api/release', { windowId: state.selectedId, selectionVersion: state.selectionVersion }); } catch { /* Preserve the original input error. */ }
      }
      notify(`本机输入失败：${error.message}`, 'error');
      render();
    } finally {
      state.inputBusy = false;
      state.inputWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  function inputIdle() {
    return state.inputBusy ? new Promise((resolve) => state.inputWaiters.push(resolve)) : Promise.resolve();
  }

  async function disableControl() {
    state.control = false;
    const pointer = state.pointer;
    state.pointer = null;
    if (pointer) {
      if (ui.viewport.hasPointerCapture(pointer.id)) ui.viewport.releasePointerCapture(pointer.id);
      enqueueInput({ type: 'pointerup', ...pointer.point, button: pointer.button });
    }
    render();
    await inputIdle();
  }

  async function action(button, work) {
    button.disabled = true;
    try { await work(); } catch (error) { notify(error.message, 'error'); }
    finally { button.disabled = !state.token; }
  }

  ui.zoom.addEventListener('change', applyZoom);
  ui.refreshWindows.addEventListener('click', () => action(ui.refreshWindows, async () => {
    await refreshStatus();
    await refreshWindows();
    notify(state.windows.length ? `找到 ${state.windows.length} 个可采集窗口。` : '未找到窗口。请打开 UU 主窗口，或使用本机验证窗口。');
  }));
  ui.windowSelect.addEventListener('change', async () => {
    if (!ui.windowSelect.value || state.selecting) {
      ui.windowSelect.value = state.selectedId == null ? '' : String(state.selectedId);
      return;
    }
    const window = state.windows.find((item) => String(item.id) === ui.windowSelect.value);
    if (!window) return;
    state.selecting = true;
    ui.windowSelect.disabled = true;
    ui.refreshWindows.disabled = true;
    stopStream();
    try {
      await disableControl();
      const result = await request('/api/select', { windowId: window.id });
      state.selectedId = window.id;
      state.selectionVersion = result.selectionVersion;
      clearFrame();
      notify(result.message || `已选择「${window.title || window.owner}」，点击「开始画面」查看。`);
    } catch (error) {
      ui.windowSelect.value = state.selectedId == null ? '' : String(state.selectedId);
      notify(error.message, 'error');
    } finally {
      state.selecting = false;
      ui.windowSelect.disabled = !state.windows.length;
      ui.refreshWindows.disabled = false;
      render();
    }
  });
  ui.streamToggle.addEventListener('click', () => {
    if (state.streaming) { stopStream(); return; }
    if (!readyToStream()) return;
    state.streaming = true;
    render();
    clearTimeout(state.frameTimer);
    void pollFrame();
  });
  ui.controlToggle.addEventListener('change', () => {
    if (!ui.controlToggle.checked || !readyToControl()) { void disableControl(); return; }
    state.control = true;
    notify('本机窗口输入已开启。请点击画面使用键盘，远端响应需另行确认。');
    render();
  });
  ui.textInput.addEventListener('input', render);
  ui.textForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state.control || !readyToControl() || !ui.textInput.value.trim()) return;
    enqueueInput({ type: 'text', text: ui.textInput.value });
  });

  ui.viewport.addEventListener('pointerdown', (event) => {
    if (!state.control || state.pointer || ![0, 1, 2].includes(event.button)) return;
    const point = imagePoint(event);
    if (!point) return;
    event.preventDefault();
    ui.viewport.focus({ preventScroll: true });
    const button = ['left', 'middle', 'right'][event.button];
    // Automation can dispatch PointerEvents without an active browser pointer.
    // Capture is optional for those events and must never prevent native mouse-down.
    if (event.isTrusted) {
      try { ui.viewport.setPointerCapture(event.pointerId); } catch { /* Window-level pointer-up still releases the button. */ }
    }
    state.pointer = { id: event.pointerId, button, point };
    enqueueInput({ type: 'pointerdown', ...point, button, modifiers: modifiers(event) });
  });
  ui.viewport.addEventListener('pointermove', (event) => {
    if (!state.control || (state.pointer && state.pointer.id !== event.pointerId)) return;
    const point = imagePoint(event, Boolean(state.pointer));
    if (!point) return;
    if (state.pointer) state.pointer.point = point;
    enqueueInput({ type: 'move', ...point, modifiers: modifiers(event) });
  });
  function releasePointer(event) {
    const pointer = state.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    const point = imagePoint(event, true) || pointer.point;
    state.pointer = null;
    if (ui.viewport.hasPointerCapture(event.pointerId)) ui.viewport.releasePointerCapture(event.pointerId);
    enqueueInput({ type: 'pointerup', ...point, button: pointer.button, modifiers: modifiers(event) });
  }
  ui.viewport.addEventListener('pointerup', releasePointer);
  ui.viewport.addEventListener('pointercancel', releasePointer);
  ui.viewport.addEventListener('lostpointercapture', releasePointer);
  window.addEventListener('pointerup', releasePointer);
  window.addEventListener('pointercancel', releasePointer);
  ui.viewport.addEventListener('contextmenu', (event) => {
    if (state.control && imagePoint(event)) event.preventDefault();
  });
  ui.viewport.addEventListener('wheel', (event) => {
    if (!state.control) return;
    const point = imagePoint(event);
    if (!point) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? ui.viewport.clientHeight : 1;
    enqueueInput({ type: 'scroll', ...point, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, modifiers: modifiers(event) });
  }, { passive: false });
  ui.viewport.addEventListener('keydown', (event) => {
    if (!state.control || event.isComposing || ['Meta', 'Shift', 'Alt', 'Control'].includes(event.key)) return;
    if (Date.now() - state.lastFrameAt > 5000) return;
    event.preventDefault();
    enqueueInput({ type: 'key', key: event.key, modifiers: modifiers(event) });
  });

  for (const [button, kind] of [[ui.screenPermission, 'screen'], [ui.accessPermission, 'accessibility']]) {
    button.addEventListener('click', () => action(button, async () => {
      const result = await request('/api/permissions', { kind });
      notify(result.message || '已请求系统授权，请在 macOS 系统设置中完成授权。');
      await refreshStatus();
    }));
  }
  ui.openUU.addEventListener('click', () => action(ui.openUU, async () => {
    const result = await request('/api/open-uu', {});
    notify(result.message || '已请求打开 UU。窗口显示后，点击「刷新窗口」。');
    await refreshStatus();
    await refreshWindows();
  }));
  ui.openTest.addEventListener('click', () => action(ui.openTest, async () => {
    const result = await request('/api/test-window', {});
    notify(result.message || '已请求打开本机验证窗口。请刷新窗口列表并选择它。');
    await refreshStatus();
    await refreshWindows();
  }));
  ui.copyMcpConfig?.addEventListener('click', async () => {
    const snippet = JSON.stringify({
      mcpServers: {
        uubridge: {
          command: 'node',
          args: [state.mcpEntry || '/path/to/uu-bridge/agent/mcp-server.mjs'],
        },
      },
    }, null, 2);
    try {
      await navigator.clipboard.writeText(snippet);
      notify('已复制 MCP 配置 JSON，可直接粘贴到 MCP 客户端配置中。', 'success');
    } catch {
      notify('浏览器未授予剪贴板写入权限，可在 README.md 中复制 MCP 配置。', 'error');
    }
  });

  async function statusLoop() {
    try {
      if (state.token) {
        await refreshStatus();
        await refreshWindows();
      }
    }
    catch (error) { notify(`状态更新失败：${error.message}`, 'error'); stopStream(); }
    state.statusTimer = setTimeout(statusLoop, 5000);
  }
  window.addEventListener('blur', () => { void disableControl(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      void disableControl();
    } else {
      if (state.streaming) void pollFrame();
      if (state.token) void refreshStatus().catch((error) => notify(error.message, 'error'));
    }
  });
  window.addEventListener('pagehide', () => {
    // A separate keepalive request survives page teardown, including queued mouse-down.
    if (state.token && state.selectedId && (state.control || state.pointer || state.inputBusy || state.inputQueue.length)) void fetch('/api/release', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-UUBridge-Token': state.token },
      body: JSON.stringify({ windowId: state.selectedId, selectionVersion: state.selectionVersion }), keepalive: true,
    }).catch(() => {});
    stopStream();
    clearTimeout(state.statusTimer);
    clearFrame();
  });

  async function initialize() {
    const actionButtons = [ui.refreshWindows, ui.openUU, ui.openTest, ui.screenPermission, ui.accessPermission];
    actionButtons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (!response.ok) throw new Error(`无法建立本机会话（HTTP ${response.status}）`);
      const session = await response.json();
      if (!session.token) throw new Error('本机会话未返回令牌，请重启服务并刷新页面。');
      state.token = session.token;
      state.mcpEntry = typeof session.mcpEntry === 'string' ? session.mcpEntry : '';
      const results = await Promise.allSettled([refreshStatus(), refreshWindows()]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      notify('本机会话已就绪。选择窗口并开始画面；输入控制默认关闭。');
    } catch (error) { notify(error.message, 'error'); }
    finally {
      actionButtons.forEach((button) => { button.disabled = !state.token; });
      render();
      if (state.token) state.statusTimer = setTimeout(statusLoop, 5000);
    }
  }
  void initialize();
})();
