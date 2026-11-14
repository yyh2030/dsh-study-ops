/* @dsh-generated: client-identity prelude begin */
;(function (global) {
  if (global.__DSH_RESEARCH_CLIENT_IDENTITY__) return

const DSH_RESEARCH_CLIENT_IDENTITY = (function () {
  const IDENTITY_VERSION = '2026-11-10-u02'
  /** 共享键：同一标签里四个插件都读它，保证 pageId 一致。 */
  const PAGE_KEY = 'dsh:research:page:v3'
  /** 每个插件自己的键：键名含插件前一等公民前缀，便于诊断与单独清理。 */
  const PAGE_KEY_PREFIX = 'dsh:research:page:v3:plugin'
  const WORKSPACE_KEY = 'dsh:research:workspace:v3'
  const REVISION_KEY = 'dsh:research:page-revision:v3'
  const TAB_CHANNEL = 'dsh-research-tab-v3'
  const GLOBAL_KEY = '__DSH_RESEARCH_CLIENT_IDENTITY__'
  const PAGE_ID_RE = /^[A-Za-z0-9_-]{8,80}$/
  const PROBE_TIMEOUT_MS = 60
  /** 同一 realm（一个标签页）里所有插件共用的随机标签指纹，用来区分同标签兄弟与克隆标签。 */
  const tabNonce = randomToken()

  function randomToken(length) {
    const bytes = new Uint8Array(Math.ceil((length || 24) / 2))
    const cryptoSource = typeof globalThis !== 'undefined' ? globalThis.crypto : null
    if (cryptoSource && typeof cryptoSource.getRandomValues === 'function') cryptoSource.getRandomValues(bytes)
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  }

  function randomPageId() { return randomToken(24) }

  function isPageId(value) { return typeof value === 'string' && PAGE_ID_RE.test(value) }

  function pluginPageKey(plugin) {
    const name = String(plugin || 'unknown').trim() || 'unknown'
    return PAGE_KEY_PREFIX + ':' + name
  }

  function safeSegment(value) {
    const text = String(value === null || value === undefined ? '' : value).trim()
    if (!text) return 'none'
    return text.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 96) || 'none'
  }

  /** 数据集标识：优先 dataRoot，其次研究定义路径，最后 studyId；只用于草稿键隔离。 */
  function datasetKey(binding) {
    if (!binding || typeof binding !== 'object') return 'none'
    return safeSegment(binding.dataRoot || binding.studyPath || binding.dataset || binding.studyId || 'none')
  }

  function instanceKey(binding) {
    return safeSegment(binding && (binding.instanceId || binding.studyId) || 'none')
  }

  /** study-ops 写到 scale-desk 的焦点提示：同一研究实例 + 同一数据集才复用。 */
  function focusKey(binding) {
    return 'dsh:research:focus:v2:' + instanceKey(binding) + ':' + datasetKey(binding)
  }

  /** analysis-run 方案草稿：实例 + 数据集（dataPath），不能只按 studyId 存。 */
  function planDraftKey(binding, dataPath, studyId) {
    return 'analysis-plan:v2:' + instanceKey(binding) + ':' + safeSegment(studyId || (binding && binding.studyId)) + ':' + safeSegment(dataPath || datasetKey(binding))
  }

  /** demographic-coder 数据集草稿：实例 + 数据集名。 */
  function datasetDraftKey(prefix, binding, dataset) {
    return String(prefix || 'dc:dataset:v3') + ':' + instanceKey(binding) + ':' + safeSegment(dataset || datasetKey(binding))
  }

  /**
   * 从 Client Slot/Service 契约读取当前标签所属工作区。
   * 只读 uiWorkspace 的当前会话与工作区成员关系；拿不到就返回 null，绝不猜 cwd。
   */
  function workspaceFromContext(ctx) {
    try {
      if (!ctx || typeof ctx.get !== 'function') return null
      const ui = ctx.get('uiWorkspace')
      if (!ui) return null
      const selection = ui.selection && typeof ui.selection.getSnapshot === 'function' ? ui.selection.getSnapshot() : null
      const sessionId = selection && selection.sessionId
      const snapshot = ui.workspaces && ui.workspaces.list && typeof ui.workspaces.list.getSnapshot === 'function' ? ui.workspaces.list.getSnapshot() : null
      const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
      let workspace = null
      if (sessionId) workspace = items.find(item => item && Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId)) || null
      if (!workspace && selection && selection.workspaceId) workspace = items.find(item => item && item.workspaceId === selection.workspaceId) || null
      if (!workspace) return null
      return { id: workspace.workspaceId || '', path: workspace.path || '' }
    } catch { return null }
  }

  function safeStorage(global) {
    try { return global && global.sessionStorage ? global.sessionStorage : null } catch { return null }
  }

  function createClientIdentity(options) {
    const settings = options || {}
    const global = settings.global || (typeof globalThis !== 'undefined' ? globalThis : null)
    const plugin = String(settings.plugin || 'unknown')
    const storage = settings.storage !== undefined ? settings.storage : safeStorage(global)
    // 只从页面 window（或显式注入）取 BroadcastChannel；Node 测试进程的全局实现
    // 不能被误当成浏览器标签能力，否则测试/宿主进程会被常驻通道挂住。
    const broadcastFactory = settings.BroadcastChannel || (global && global.BroadcastChannel) || null
    const workspaceProvider = settings.workspaceProvider || null
    const random = typeof settings.random === 'function' ? settings.random : randomPageId
    const tabId = settings.tabId || tabNonce
    const pageKey = pluginPageKey(plugin)
    let pageId = ''
    let workspace = null
    let revision = 0
    let binding = null
    let readyPromise = null
    let channel = null

    function read(key) {
      try { return storage && typeof storage.getItem === 'function' ? String(storage.getItem(key) || '') : '' } catch { return '' }
    }
    function write(key, value) {
      try { if (storage && typeof storage.setItem === 'function') storage.setItem(key, String(value)); return true } catch { return false }
    }
    function remove(key) { try { if (storage && typeof storage.removeItem === 'function') storage.removeItem(key) } catch { /* ignore */ } }

    function workspaceStorageKey(id) { return WORKSPACE_KEY + ':' + id }
    function revisionStorageKey(id) { return REVISION_KEY + ':' + id }

    function readWorkspace() {
      const raw = read(workspaceStorageKey(pageId))
      if (!raw) return null
      try {
        const value = JSON.parse(raw)
        return value && typeof value === 'object' ? { id: String(value.id || ''), path: String(value.path || '') } : null
      } catch { return null }
    }
    function readRevision() {
      const value = Number(read(revisionStorageKey(pageId)))
      return Number.isFinite(value) && value >= 0 ? value : 0
    }
    function persistWorkspace() {
      if (!pageId) return
      if (workspace) write(workspaceStorageKey(pageId), JSON.stringify(workspace))
      else remove(workspaceStorageKey(pageId))
      write(revisionStorageKey(pageId), String(revision))
    }

    function normalizeWorkspace(value) {
      if (!value) return null
      if (typeof value === 'string') return { id: value.trim(), path: '' }
      const id = String(value.id || value.workspaceId || '').trim()
      const path = typeof value.path === 'string' ? value.path.trim() : ''
      if (!id && !path) return null
      return { id, path }
    }

    function installChannel() {
      if (channel || !broadcastFactory) return
      try {
        channel = new broadcastFactory(TAB_CHANNEL)
        if (typeof channel.addEventListener === 'function') {
          channel.addEventListener('message', event => {
            const message = event && event.data ? event.data : event
            if (!message || message.type !== 'identity-probe' || !message.nonce) return
            // 同一标签的四个兄弟共用一个 tab 指纹，不能互相判成克隆；只回答其他标签的探测。
            if (message.tab === tabId) return
            if (message.pageId !== pageId) return
            try { channel.postMessage({ type: 'identity-alive', pageId, nonce: message.nonce }) } catch { /* ignore */ }
          })
        }
      } catch { channel = null }
    }

    /** 克隆标签会复制 sessionStorage；用 BroadcastChannel 问一下这个 pageId 是否已在别的标签活着。 */
    async function contested(id) {
      if (!broadcastFactory) return false
      let probe = null
      try { probe = new broadcastFactory(TAB_CHANNEL) } catch { return false }
      return await new Promise(resolve => {
        let settled = false
        const nonce = random()
        const finish = value => {
          if (settled) return
          settled = true
          try { if (probe && typeof probe.close === 'function') probe.close() } catch { /* ignore */ }
          resolve(value)
        }
        if (typeof probe.addEventListener === 'function') {
          probe.addEventListener('message', event => {
            const message = event && event.data ? event.data : event
            if (message && message.type === 'identity-alive' && message.pageId === id && message.nonce === nonce) finish(true)
          })
        }
        try { probe.postMessage({ type: 'identity-probe', pageId: id, nonce, tab: tabId }) } catch { finish(false); return }
        setTimeout(() => finish(false), PROBE_TIMEOUT_MS)
      })
    }

    function ready() {
      if (readyPromise) return readyPromise
      readyPromise = (async () => {
        const storedPlugin = read(pageKey)
        const storedShared = read(PAGE_KEY)
        // 共享键优先：四个插件以它为唯一事实；插件键只做诊断/清理辅助。
        let candidate = isPageId(storedShared) ? storedShared : (isPageId(storedPlugin) ? storedPlugin : '')
        // 同标签的兄弟插件已经通过共享内存确认过这个身份，不必再互探。
        if (candidate && candidate !== memoryPageId() && await contested(candidate)) candidate = ''
        if (!candidate) {
          candidate = isPageId(memoryPageId()) ? memoryPageId() : random()
          // 进程内唯一 ID：同一标签的四个插件通过共享内存拿到同一个值，克隆/无 storage 时也彼此不同。
          setMemoryPageId(candidate)
          write(pageKey, candidate)
          write(PAGE_KEY, candidate)
        } else {
          setMemoryPageId(candidate)
          if (storedPlugin !== candidate) write(pageKey, candidate)
          if (storedShared !== candidate) write(PAGE_KEY, candidate)
        }
        pageId = candidate
        if (!workspace) workspace = readWorkspace()
        revision = Math.max(revision, readRevision())
        installChannel()
        return pageId
      })()
      return readyPromise
    }

    // 进程内单例挂在全局 API 上：四个插件 bundle 共用同一个 API 实例时通过它对齐。
    function memoryPageId() {
      try { return global && global.__DSH_RESEARCH_PAGE_MEMORY__ ? String(global.__DSH_RESEARCH_PAGE_MEMORY__) : '' } catch { return '' }
    }
    function setMemoryPageId(value) {
      try { if (global) global.__DSH_RESEARCH_PAGE_MEMORY__ = value } catch { /* ignore */ }
    }

    /** 同标签任一插件 newPage 后，其他插件下次请求前要采纳新的共享 pageId。 */
    function syncPageFromGlobal() {
      const sharedMemory = memoryPageId()
      if (!isPageId(sharedMemory) || sharedMemory === pageId) return
      pageId = sharedMemory
      workspace = readWorkspace()
      revision = readRevision()
      binding = null
    }

    function ensure() {
      syncPageFromGlobal()
      if (!pageId) {
        // 同步路径也不能覆盖已持久化的身份；只有确实没有候选时才生成。
        const storedShared = read(PAGE_KEY)
        const storedPlugin = read(pageKey)
        const stored = isPageId(storedShared) ? storedShared : (isPageId(storedPlugin) ? storedPlugin : '')
        pageId = stored || (isPageId(memoryPageId()) ? memoryPageId() : random())
        setMemoryPageId(pageId)
        if (!stored) write(PAGE_KEY, pageId)
        if (storedPlugin !== pageId) write(pageKey, pageId)
        if (!workspace) workspace = readWorkspace()
        revision = Math.max(revision, readRevision())
      }
      return pageId
    }

    function syncWorkspace(ctx) {
      if (typeof workspaceProvider !== 'function' || !pageId) return workspace
      let next = null
      try { next = workspaceProvider(ctx) } catch { next = null }
      return setWorkspace(next)
    }

    function setWorkspace(next) {
      const normalized = normalizeWorkspace(next)
      if (!normalized) return workspace
      if (workspace && workspace.id === normalized.id && workspace.path === normalized.path) return workspace
      if (workspace) {
        // 同标签切换工作区：绑定代次递增，旧令牌作废。
        revision += 1
        binding = null
      }
      workspace = normalized
      persistWorkspace()
      return workspace
    }

    function newPage() {
      const next = random()
      pageId = next
      setMemoryPageId(next)
      revision = 0
      binding = null
      write(pageKey, next)
      write(PAGE_KEY, next)
      persistWorkspace()
      installChannel()
      return next
    }

    function prepare(ctx) {
      syncPageFromGlobal()
      ensure()
      if (typeof workspaceProvider === 'function') syncWorkspace(ctx)
      return begin()
    }

    function begin() {
      ensure()
      return {
        pageId,
        workspaceId: workspace ? workspace.id : '',
        workspacePath: workspace ? workspace.path : '',
        bindingRevision: revision,
        studyId: binding ? binding.studyId || '' : '',
        instanceId: binding ? binding.instanceId || '' : '',
        token: binding ? binding.token || '' : '',
      }
    }

    function headers() {
      ensure()
      const result = { 'x-dsh-page': pageId }
      if (workspace && workspace.id) result['x-dsh-workspace'] = workspace.id
      return result
    }

    function body() {
      ensure()
      const result = { pageId, bindingRevision: revision }
      if (workspace && workspace.id) result.workspaceId = workspace.id
      // 写入令牌必须随请求体发送：连接/读取响应会 remember() 令牌，但只有 body 带上它，
      // 服务端 assertWrite 才会认为这是当前页面的绑定（否则页面永远 binding_required）。
      if (binding && binding.token) result.binding = binding.token
      return result
    }

    function capture() { return begin() }

    function remember(nextBinding) {
      if (!nextBinding || typeof nextBinding !== 'object' || !nextBinding.token) return binding
      binding = {
        token: String(nextBinding.token),
        studyId: nextBinding.studyId || (nextBinding.study && nextBinding.study.id) || '',
        instanceId: nextBinding.instanceId || (nextBinding.study && nextBinding.study.instanceId) || '',
        studyRevision: nextBinding.studyRevision || (nextBinding.study && nextBinding.study.revision) || '',
        bindingRevision: Number(nextBinding.bindingRevision) || 0,
        workspaceId: nextBinding.workspaceId || '',
      }
      return binding
    }

    function staleError(message, details) {
      const error = new Error(message)
      error.code = 'stale_response'
      error.details = details
      return error
    }

    /**
     * 响应回来后核对本次 capture：页面、工作区代次或研究身份变了就拒绝，
     * 由调用方丢弃这次结果，不能覆盖新页面状态。
     */
    function assertResponse(snapshot, responseBinding, options) {
      if (!snapshot) return true
      if (snapshot.pageId !== pageId) throw staleError('页面身份已变化，忽略过时响应', { pageId, expected: snapshot.pageId })
      if (snapshot.bindingRevision !== revision) throw staleError('页面绑定已切换，忽略过时响应', { bindingRevision: revision, expected: snapshot.bindingRevision })
      const workspaceId = workspace ? workspace.id : ''
      if ((snapshot.workspaceId || '') !== workspaceId) throw staleError('页面工作区已切换，忽略过时响应', { workspaceId, expected: snapshot.workspaceId })
      if (responseBinding && typeof responseBinding === 'object') {
        const allowRebind = options && options.allowRebind === true
        const responseStudy = responseBinding.studyId || (responseBinding.study && responseBinding.study.id) || ''
        const responseInstance = responseBinding.instanceId || (responseBinding.study && responseBinding.study.instanceId) || ''
        const responseWorkspace = responseBinding.workspaceId || ''
        if (responseWorkspace && workspaceId && responseWorkspace !== workspaceId) {
          throw staleError('响应来自其他工作区，已丢弃', { workspaceId, responseWorkspace })
        }
        if (!allowRebind) {
          if (snapshot.studyId && responseStudy && snapshot.studyId !== responseStudy) {
            throw staleError('响应属于其他研究，已丢弃', { studyId: responseStudy, expected: snapshot.studyId })
          }
          if (snapshot.instanceId && responseInstance && snapshot.instanceId !== responseInstance) {
            throw staleError('响应属于其他研究实例，已丢弃', { instanceId: responseInstance, expected: snapshot.instanceId })
          }
        }
      }
      return true
    }

    function accept(snapshot, responseBinding, options) {
      assertResponse(snapshot, responseBinding, options)
      return remember(responseBinding)
    }

    // 首次创建就落盘：隐私模式下也会落到本标签的进程内单例。
    void ready().catch(() => {})

    return {
      version: IDENTITY_VERSION,
      plugin,
      ready,
      ensure,
      pageId() { return ensure() },
      newPage,
      prepare,
      begin,
      syncWorkspace,
      setWorkspace,
      workspace() { return workspace ? { ...workspace } : null },
      revision() { return revision },
      headers,
      body,
      capture,
      remember,
      binding() { return binding ? { ...binding } : null },
      assertResponse,
      accept,
      focusKey() { return focusKey(binding) },
      planDraftKey(dataPath) { return planDraftKey(binding, dataPath, binding && binding.studyId) },
      datasetDraftKey(prefix, dataset) { return datasetDraftKey(prefix, binding, dataset) },
      staleError,
    }
  }

  return {
    IDENTITY_VERSION,
    PAGE_KEY,
    PAGE_KEY_PREFIX,
    WORKSPACE_KEY,
    REVISION_KEY,
    TAB_CHANNEL,
    GLOBAL_KEY,
    randomPageId,
    isPageId,
    pluginPageKey,
    safeSegment,
    datasetKey,
    instanceKey,
    focusKey,
    planDraftKey,
    datasetDraftKey,
    workspaceFromContext,
    createClientIdentity,
  }
})()
  global.__DSH_RESEARCH_CLIENT_IDENTITY__ = DSH_RESEARCH_CLIENT_IDENTITY
})(typeof window !== 'undefined' ? window : globalThis)
/* @dsh-generated: client-identity prelude end */








/* @dsh-generated: study-picker prelude begin */
;(function (global) {
  if (global.__DSH_RESEARCH_PICKER__) return

function createStudyPicker(options) {
  const route = options.route
  const headers = options.headers || (() => ({}))
  const pickDirectory = options.pickDirectory || null
  const onChanged = options.onChanged || (() => {})
  const plugin = options.plugin || 'research'
  let root = null
  let panel = null
  let choices = null
  let note = ''
  let busy = false
  let advanced = false
  let creating = false
  let targetDir = ''
  let chooseDir = null

  async function api(action, payload, method = 'POST') {
    const url = method === 'GET' ? `${route}?action=${encodeURIComponent(action)}` : route
    const response = await fetch(url, {
      method,
      headers: { ...headers(), 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ action, payload: payload || {} }) : undefined,
    })
    let data = null
    try { data = await response.json() } catch { data = null }
    if (!response.ok || !data || data.ok === false) {
      const message = data && data.error && (data.error.message || data.error.note) ? (data.error.message || data.error.note) : `请求失败（${response.status}）`
      throw new Error(message)
    }
    return data.data
  }

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'style') { if (node.style) for (const [name, style] of Object.entries(value)) node.style[name] = style }
      else if (key === 'onClick') node.addEventListener('click', value)
      else if (key === 'className') node.className = value
      else if (key === 'text') node.textContent = value
      else if (key === 'value') node.value = value
      else if (key === 'placeholder') node.placeholder = value
      else node.setAttribute(key, value)
    }
    for (const child of children) if (child != null) node.append(child)
    return node
  }

  const buttonStyle = {
    height: '30px', padding: '0 10px', border: '1px solid #cdc7b7', borderRadius: '5px',
    background: '#fffefb', color: '#24221f', cursor: 'pointer', font: 'inherit', fontSize: '13px',
  }
  const rowStyle = { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderBottom: '1px solid #eceade', cursor: 'pointer', width: '100%', background: 'transparent', border: 'none', textAlign: 'left', font: 'inherit' }

  function stateLabel(row) {
    if (row.state === 'ok') return '已存在'
    if (row.state === 'missing') return '需重新定位'
    if (row.state === 'invalid') return '配置损坏'
    return '未知'
  }

  function render() {
    if (!panel) return
    panel.textContent = ''
    const recent = (choices && choices.recent) || []
    const scope = (choices && choices.scope) || {}
    const binding = (choices && choices.binding) || {}
    const head = el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
      el('strong', { text: '打开研究' }),
      el('button', { style: buttonStyle, text: '关闭', onClick: close }),
    )
    const scopeBox = el('div', { style: { background: '#f2f0e9', borderRadius: '6px', padding: '8px 10px', fontSize: '12.5px', color: '#5b564d', lineHeight: '1.7' } },
      el('div', { text: `当前页面：${binding.studyId || '未绑定'}` }),
      el('div', { text: `当前工作区：${scope.workspace ? (scope.workspace.path || scope.workspace.id || '已识别') : '未识别'}` }),
      el('div', { text: `当前会话：${scope.kind === 'agent' ? (scope.session || '已识别') : '页面切换不改变 Agent 研究'}` }),
      el('div', { style: { color: '#726c62', fontSize: '12px' }, text: '在此研究工作区打开会话：暂不支持（宿主没有研究→工作区映射）；请在工作区新建会话。' }),
    )
    const list = el('div', { style: { maxHeight: '230px', overflow: 'auto', border: '1px solid #eceade', borderRadius: '6px', marginTop: '10px' } })
    if (!recent.length) list.append(el('div', { style: { padding: '12px', color: '#726c62' }, text: '暂无最近研究。选择研究文件夹或新建研究。' }))
    for (const row of recent) {
      const item = el('button', { style: { ...rowStyle, opacity: row.state === 'missing' ? '0.65' : '1' }, onClick: () => select(row) },
        el('span', { style: { flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: `${row.name || row.studyId || row.studyPath}` }),
        el('span', { style: { color: '#726c62', fontSize: '12px' }, text: row.current ? '当前' : stateLabel(row) }),
      )
      if (row.current) item.style.background = '#f4e5dd'
      list.append(item)
    }
    const actions = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
      el('button', { style: buttonStyle, text: '选择研究文件夹…', onClick: chooseFolder }),
      el('button', { style: buttonStyle, text: '新建研究…', onClick: () => { creating = true; advanced = false; render() } }),
      el('button', { style: buttonStyle, text: '高级', onClick: () => { advanced = !advanced; creating = false; render() } }),
    )
    const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, head, scopeBox, list, actions)
    if (creating) body.append(createForm())
    if (advanced) body.append(advancedForm())
    if (note) body.append(el('div', { style: { color: '#9b3a2c', fontSize: '12.5px' }, text: note }))
    panel.append(body)
  }

  function createForm() {
    const name = el('input', { placeholder: '研究名称', value: '', style: { height: '30px', padding: '0 8px', border: '1px solid #cdc7b7', borderRadius: '5px', font: 'inherit' } })
    const dirText = el('span', { style: { color: '#5b564d', fontSize: '12.5px', wordBreak: 'break-all' }, text: targetDir || '尚未选择父目录' })
    const choose = el('button', { style: buttonStyle, text: '选择父目录…', onClick: async () => {
      const dir = await chooseFolderPath()
      if (!dir) return
      targetDir = dir; render()
    } })
    const create = el('button', { style: { ...buttonStyle, background: '#a55a3c', color: '#fdfbf7', borderColor: '#a55a3c' }, text: '创建并连接', onClick: async () => {
      if (busy) return
      const title = String(name.value || '').trim()
      if (!title) { note = '请填写研究名称'; render(); return }
      if (!targetDir) { note = '请选择父目录'; render(); return }
      busy = true; note = ''
      try {
        const payload = { studyPath: joinPath(targetDir, 'study.json'), name: title }
        await api('studyCreate', payload)
        await finishSwitch()
      } catch (error) { note = error.message; busy = false; render() }
    } })
    return el('div', { style: { border: '1px solid #eceade', borderRadius: '6px', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' } },
      el('strong', { text: '新建研究' }), name, dirText, el('div', { style: { display: 'flex', gap: '8px' } }, choose, create))
  }

  function advancedForm() {
    const input = el('input', { placeholder: 'study.json 的绝对路径', style: { flex: '1 1 auto', height: '30px', padding: '0 8px', border: '1px solid #cdc7b7', borderRadius: '5px', font: 'inherit' } })
    const connect = el('button', { style: buttonStyle, text: '连接', onClick: async () => {
      if (busy) return
      if (!input.value.trim()) { note = '请填写研究定义路径'; render(); return }
      busy = true; note = ''
      try { await api('studyConnect', { studyPath: input.value.trim() }); await finishSwitch() }
      catch (error) { note = error.message; busy = false; render() }
    } })
    return el('div', { style: { border: '1px solid #eceade', borderRadius: '6px', padding: '10px', display: 'flex', gap: '8px' } }, input, connect)
  }

  function joinPath(dir, name) {
    const clean = String(dir).replace(/[\\/]+$/, '')
    return `${clean}/${name}`
  }

  async function chooseFolderPath() {
    if (!pickDirectory) { note = '当前宿主未提供目录选择，请使用高级路径'; render(); return null }
    try { return await pickDirectory() } catch (error) { note = error.message || '目录选择已取消'; render(); return null }
  }

  async function chooseFolder() {
    const dir = await chooseFolderPath()
    if (!dir) return
    busy = true; note = ''
    try {
      const found = await api('studyDiscover', { dir })
      const configs = (found && found.configs) || []
      if (!configs.length) {
        targetDir = dir; creating = true; advanced = false
        note = '此文件夹没有研究配置，可以新建研究。'
      } else if (configs.length === 1) {
        await api('studyConnect', { studyPath: configs[0].studyPath })
        await finishSwitch()
        return
      } else {
        choices = null
        showConfigs(configs)
        busy = false
        return
      }
    } catch (error) { note = error.message }
    busy = false
    render()
  }

  function showConfigs(configs, relocateId = null) {
    if (!panel) return
    panel.textContent = ''
    panel.append(
      el('strong', { text: relocateId ? '选择重新定位后的研究配置' : '此文件夹有多个研究配置，请选择' }),
      el('div', { style: { margin: '10px 0', border: '1px solid #eceade', borderRadius: '6px' } },
        ...configs.map(row => el('button', { style: rowStyle, onClick: async () => {
          if (!row.valid) { note = '这个配置无效：' + (row.problems || []).join('；'); render(); return }
          try {
            if (relocateId) await api('studyRelocate', { instanceId: relocateId, studyPath: row.studyPath })
            else await api('studyConnect', { studyPath: row.studyPath })
            await finishSwitch()
          } catch (error) { note = error.message; busy = false; render() }
        } },
          el('span', { style: { flex: '1 1 auto' }, text: `${row.name || row.studyId || row.relativePath}` }),
          el('span', { style: { color: row.valid ? '#3f6b4f' : '#9b3a2c', fontSize: '12px' }, text: row.valid ? row.relativePath : '无效' }),
        ))
      ),
      el('button', { style: buttonStyle, text: '返回', onClick: () => { choices = null; refresh(); render() } }),
    )
  }

  async function select(row) {
    if (row.state === 'missing') {
      if (!row.instanceId) { note = '该研究没有实例记录，请选择文件夹或高级路径连接'; advanced = true; render(); return }
      const dir = await chooseFolderPath()
      if (!dir) return
      busy = true; note = ''
      try {
        const found = await api('studyDiscover', { dir })
        const configs = (found && found.configs) || []
        if (!configs.length) { note = '此文件夹没有研究配置'; busy = false; render(); return }
        if (configs.length > 1) { showConfigs(configs, row.instanceId); return }
        await api('studyRelocate', { instanceId: row.instanceId, studyPath: configs[0].studyPath })
        await finishSwitch()
      } catch (error) { note = error.message; busy = false; render() }
      return
    }
    if (!row.studyPath) return
    busy = true; note = ''
    try { await api('studyConnect', { studyPath: row.studyPath }); await finishSwitch() }
    catch (error) { note = error.message; busy = false; render() }
  }

  async function finishSwitch() {
    busy = false
    let name = ''
    try { choices = await api('studyChoices'); const current = (choices.recent || []).find(row => row.current); name = (current && (current.name || current.studyId)) || '' } catch { /* 名称稍后刷新 */ }
    close()
    updateButton()
    showToast(name)
    onChanged()
  }

  function showToast(name) {
    const toast = el('div', {
      style: {
        position: 'fixed', right: '24px', bottom: '28px', zIndex: '2147483100', maxWidth: '420px',
        background: '#24221f', color: '#fdfbf7', borderRadius: '8px', padding: '10px 12px',
        display: 'flex', alignItems: 'center', gap: '10px', font: '13px Cambria, serif',
        boxShadow: '0 10px 26px rgba(0,0,0,.25)',
      },
    },
      el('span', { style: { flex: '1 1 auto' }, text: name ? `已切换到：${name}` : '已切换研究' }),
      el('button', { style: { ...buttonStyle, height: '26px', background: '#fdfbf7' }, text: '刷新面板', onClick: () => { try { window.location.reload() } catch { /* 无窗口 */ } } }),
      el('button', { style: { ...buttonStyle, height: '26px', background: 'transparent', color: '#fdfbf7', borderColor: '#5b564d' }, text: '稍后', onClick: () => toast.remove() }),
    )
    document.body.append(toast)
    setTimeout(() => { try { toast.remove() } catch { /* 已移除 */ } }, 12000)
  }

  async function refresh() {
    try { choices = await api('studyChoices') } catch (error) { choices = null; note = error.message }
    updateButton()
    if (panel) render()
  }

  function updateButton() {
    if (!root) return
    const current = choices && choices.binding && choices.binding.studyId
    const nameRow = choices && choices.recent && choices.recent.find(row => row.current)
    root.textContent = `研究：${(nameRow && (nameRow.name || nameRow.studyId)) || current || '未绑定'} ▾`
  }

  function close() {
    if (panel) {
      if (panel.__onKey) document.removeEventListener('keydown', panel.__onKey)
      panel.remove(); panel = null
    }
  }

  function open() {
    if (panel) { close(); return }
    panel = el('div', {
      style: {
        position: 'fixed', bottom: '108px', right: '24px', width: '540px', maxWidth: 'calc(100vw - 48px)',
        maxHeight: 'calc(100vh - 200px)', overflow: 'auto', zIndex: '2147483000', background: '#fbfaf6',
        border: '1px solid #cdc7b7', borderRadius: '10px', padding: '14px', boxShadow: '0 18px 50px rgba(0,0,0,.22)',
        fontFamily: 'Cambria, "Noto Serif SC", serif', color: '#24221f', fontSize: '14px',
      },
    })
    document.body.append(panel)
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); close() } }
    document.addEventListener('keydown', onKey)
    panel.__onKey = onKey
    refresh()
  }

  function install() {
    if (root) return root
    if (typeof window !== 'undefined' && window.__DSH_RESEARCH_PICKER_INSTANCE__) return window.__DSH_RESEARCH_PICKER_INSTANCE__
    if (!document.body || typeof document.body.appendChild !== 'function' || !document.createElement) return null
    root = el('button', {
      style: {
        position: 'fixed', bottom: '64px', right: '24px', zIndex: '2147482000',
        height: '30px', padding: '0 12px', border: '1px solid #cdc7b7', borderRadius: '999px',
        background: '#fffefb', color: '#24221f', cursor: 'pointer', font: 'inherit', fontSize: '13px',
        boxShadow: '0 2px 10px rgba(0,0,0,.08)',
      },
      text: '研究：加载中…',
      title: `${plugin} 当前研究`,
    })
    root.addEventListener('click', open)
    document.body.append(root)
    // 面板只在研究插件页打开时自动关闭；入口按钮始终可见，避免被误判为“消失”。
    setInterval(() => {
      if (!panel) return
      try { if (!document.querySelector('.so-pagehead,.sd-root,.dc-root,.ar-pagehead')) close() } catch { close() }
    }, 800)
    refresh()
    if (typeof window !== 'undefined') window.__DSH_RESEARCH_PICKER_INSTANCE__ = pickerApi
    return root
  }

  const pickerApi = { install, open, close, refresh, get state() { return choices } }
  return pickerApi
}

const DSH_RESEARCH_PICKER = { createStudyPicker }
  global.__DSH_RESEARCH_PICKER__ = DSH_RESEARCH_PICKER
})(typeof window !== 'undefined' ? window : globalThis)
/* @dsh-generated: study-picker prelude end */











window.__ModuleLoader__.load({id:'@local/study-ops',factory(require){
  const React=require('react'),h=React.createElement,{useState,useEffect,useCallback}=React
  const CSS=`
.so-root{
  --so-bg:#f5f4ef;--so-sunk:#eeede6;--so-panel:#fbfaf6;--so-raised:#fffefb;--so-alt:#f2f0e9;
  --so-line:#e3dfd4;--so-line-soft:#eceade;--so-line-strong:#cdc7b7;
  --so-ink:#24221f;--so-ink-2:#5b564d;--so-ink-3:#726c62;
  --so-accent:#c46e4f;--so-accent-deep:#a55a3c;--so-accent-darker:#8b4526;--so-accent-soft:#f4e5dd;--so-on-accent:#fdfbf7;
  --so-ok:#3f6b4f;--so-ok-soft:#e4ebe1;--so-warn:#7d5810;--so-warn-soft:#f3ead3;--so-bad:#9b3a2c;--so-bad-soft:#f4dfd9;--so-info:#3f5a70;--so-info-soft:#e2e8ec;
  height:100%;overflow:auto;padding:20px 22px 44px;box-sizing:border-box;background:var(--so-bg);color:var(--so-ink);
  font-family:Cambria,"Noto Serif SC","Source Han Serif SC","Songti SC",STSong,SimSun,serif;font-size:15px;line-height:1.62;letter-spacing:0;font-variant-numeric:tabular-nums;
}
.so-root *{box-sizing:border-box}
.so-root button,.so-root input,.so-root select,.so-root textarea{font-family:inherit;color:inherit}
.so-root ::selection{background:var(--so-accent-soft);color:var(--so-ink)}
.so-shell{max-width:1280px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
.so-pagehead{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap}
.so-headtext{min-width:0;flex:1 1 320px}
.so-pagehead h1{margin:0;font-size:21px;line-height:1.24;font-weight:600;letter-spacing:0}
.so-pagemeta{margin:5px 0 0;font-size:13.5px;color:var(--so-ink-3)}
.so-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.so-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 13px;border:1px solid transparent;border-radius:5px;background:transparent;font-size:14.5px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;transition:background .14s ease,border-color .14s ease,color .14s ease}
.so-btn-quiet{background:var(--so-raised);border-color:var(--so-line-strong);color:var(--so-ink)}
.so-btn-quiet:hover:not(:disabled){background:var(--so-alt);border-color:var(--so-ink-3)}
.so-btn-primary{background:var(--so-accent-deep);border-color:var(--so-accent-deep);color:var(--so-on-accent)}
.so-btn-primary:hover:not(:disabled){background:var(--so-accent-darker);border-color:var(--so-accent-darker)}
.so-btn-ghost{color:var(--so-ink-2);border-color:transparent}
.so-btn-ghost:hover:not(:disabled){background:var(--so-alt);color:var(--so-ink)}
.so-btn:disabled{background:var(--so-alt);border-color:var(--so-line);color:var(--so-ink-3);cursor:not-allowed}
.so-root button:focus-visible,.so-root input:focus-visible,.so-root select:focus-visible,.so-root summary:focus-visible{outline:2px solid var(--so-accent-deep);outline-offset:2px}
.so-cellbtn{border:0;background:transparent;cursor:pointer;font:inherit;padding:0;text-align:left}
.so-cellbtn:disabled{cursor:default}
.so-mini{height:30px;padding:0 8px;border:1px solid var(--so-line-strong);border-radius:5px;background:var(--so-raised);color:var(--so-ink);font-size:13px}
.so-spine{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:10px 16px;border:1px solid var(--so-line);border-radius:7px;background:var(--so-panel)}
.so-spine-id{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0}
.so-spine-id b{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:44ch}
.so-spine-id span{font-size:12.5px;color:var(--so-ink-3)}
.so-spine-facts{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;margin-left:auto;font-size:12.5px;color:var(--so-ink-2)}
.so-tag{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px solid transparent;border-radius:4px;font-size:12.5px;line-height:1.2;white-space:nowrap}
.so-tag-ok{color:var(--so-ok);background:var(--so-ok-soft);border-color:#cad8c8}
.so-tag-warn{color:var(--so-warn);background:var(--so-warn-soft);border-color:#e1d2ab}
.so-tag-bad{color:var(--so-bad);background:var(--so-bad-soft);border-color:#e0c1b7}
.so-tag-info{color:var(--so-info);background:var(--so-info-soft);border-color:#cbd6dd}
.so-tag-plain{color:var(--so-ink-2);background:var(--so-alt);border-color:var(--so-line)}
.so-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.so-metric{display:flex;flex-direction:column;gap:4px;padding:14px 16px;border:1px solid var(--so-line);border-radius:7px;background:var(--so-panel);text-align:left;min-width:0}
.so-metric-name{font-size:13.5px;color:var(--so-ink-2)}
.so-metric-value{font-size:26px;line-height:1.15;font-weight:600;letter-spacing:-.01em;color:var(--so-ink)}
.so-metric-value small{font-size:13.5px;font-weight:400;color:var(--so-ink-3);margin-left:4px}
.so-metric-scope{font-size:12.5px;line-height:1.5;color:var(--so-ink-3)}
.so-metric[data-tone="bad"] .so-metric-value{color:var(--so-bad)}
.so-metric[data-tone="warn"] .so-metric-value{color:var(--so-warn)}
.so-block{border:1px solid var(--so-line);border-radius:7px;background:var(--so-panel);padding:16px 18px 18px;min-width:0}
.so-blockhead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.so-blockhead h2{margin:0;font-size:17px;line-height:1.3;font-weight:600}
.so-blocknote{margin:0;font-size:13.5px;color:var(--so-ink-3);flex:1 1 240px}
.so-groupgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.so-groupcard{padding:12px 14px 13px;border:1px solid var(--so-line);border-radius:7px;background:var(--so-raised);min-width:0}
.so-groupname{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:14.5px;font-weight:600}
.so-groupname span{font-size:12px;font-weight:400;color:var(--so-ink-3)}
.so-groupcount{margin-top:3px;font-size:23px;line-height:1.15;font-weight:600;letter-spacing:-.01em}
.so-groupcount small{font-size:13px;font-weight:400;color:var(--so-ink-3);margin-left:3px}
.so-groupscope{margin-top:3px;font-size:12.5px;color:var(--so-ink-3)}
.so-groupsex{margin-top:3px;font-size:12.5px;color:var(--so-ink-2);font-variant-numeric:tabular-nums}
.so-tasklist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0}
.so-task{display:grid;grid-template-columns:118px minmax(0,1fr) auto auto;gap:12px;align-items:center;padding:9px 0;border-top:1px solid var(--so-line-soft)}
.so-task:first-child{border-top:0}
.so-task-time{display:flex;flex-direction:column;line-height:1.4;color:var(--so-ink-3);font-size:12.5px;white-space:nowrap}
.so-task-time b{color:var(--so-ink);font-size:13.5px;font-weight:600}
.so-task-title{font-size:14.5px;color:var(--so-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.so-task-sub{font-size:12.5px;color:var(--so-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.so-task-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.so-btn-sm{height:28px;padding:0 9px;font-size:13px;border-radius:4px}
.so-disclosure{margin-top:10px;border-top:1px solid var(--so-line-soft);padding-top:10px}
.so-disclosure summary{cursor:pointer;font-size:13.5px;color:var(--so-ink-2);outline:none}
.so-disclosure summary:hover{color:var(--so-ink)}
.so-form{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;margin-top:12px}
.so-form-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
.so-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12.5px;color:var(--so-ink-2)}
.so-field input,.so-field select{height:34px;padding:0 9px;border:1px solid var(--so-line-strong);border-radius:5px;background:var(--so-raised);color:var(--so-ink);font-size:14px;outline:none;min-width:0}
.so-field input:focus,.so-field select:focus{border-color:var(--so-accent-deep);outline:2px solid var(--so-accent-deep);outline-offset:1px}
.so-form-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.so-form-error{font-size:12.5px;color:var(--so-bad)}
.so-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.so-search{width:230px;height:32px;padding:0 9px;border:1px solid var(--so-line-strong);border-radius:5px;background:var(--so-raised);font-size:13.5px;outline:none}
.so-search:focus{border-color:var(--so-accent-deep);outline:2px solid var(--so-accent-deep);outline-offset:1px}
.so-filter{display:flex;gap:4px;flex-wrap:wrap}
.so-filter button{height:30px;padding:0 10px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--so-ink-2);font-size:13px;cursor:pointer}
.so-filter button:hover{background:var(--so-alt);color:var(--so-ink)}
.so-filter button[aria-pressed="true"]{background:var(--so-accent-soft);border-color:#dcb6a4;color:var(--so-accent-darker);font-weight:600}
.so-count{margin-left:auto;font-size:12.5px;color:var(--so-ink-3);white-space:nowrap}
.so-table-wrap{overflow:auto;max-height:62vh;border:1px solid var(--so-line);border-radius:5px;background:var(--so-raised)}
.so-table-wrap:focus-visible{outline:2px solid var(--so-accent-deep);outline-offset:1px}
.so-table{width:max-content;min-width:100%;border-collapse:separate;border-spacing:0;font-size:13.5px}
.so-table th,.so-table td{padding:7px 10px;border-bottom:1px solid var(--so-line-soft);border-right:1px solid var(--so-line-soft);text-align:left;vertical-align:middle;background:var(--so-raised);white-space:nowrap}
.so-table thead th{position:sticky;top:0;z-index:2;background:var(--so-alt);color:var(--so-ink-2);font-size:12.5px;font-weight:600;white-space:nowrap}
.so-table thead tr:nth-child(2) th{top:35px;z-index:1;font-size:12.5px;font-weight:500;color:var(--so-ink-3)}
.so-table .so-idcol{position:sticky;left:0;z-index:3;background:var(--so-raised);min-width:132px;box-shadow:1px 0 0 var(--so-line-strong)}
.so-table thead .so-idcol{z-index:4;background:var(--so-alt)}
.so-id-main{font-weight:600;font-size:13.5px}
.so-id-sub{display:block;margin-top:1px;font-size:12px;color:var(--so-ink-3)}
.so-cell{display:inline-flex;align-items:center;justify-content:center;min-width:72px;height:26px;padding:0 7px;border:1px solid transparent;border-radius:4px;font-size:12.5px;white-space:nowrap}
.so-cell[data-s="ok"]{background:var(--so-ok-soft);color:var(--so-ok);border-color:#cad8c8}
.so-cell[data-s="pending"]{background:var(--so-warn-soft);color:var(--so-warn);border-color:#e1d2ab}
.so-cell[data-s="missing"],.so-cell[data-s="bad"],.so-cell[data-s="conflict"]{background:var(--so-bad-soft);color:var(--so-bad);border-color:#e0c1b7}
.so-cell[data-s="unknown"]{background:var(--so-alt);color:var(--so-ink-2);border-color:var(--so-line)}
.so-cell[data-s="not_due"],.so-cell[data-s="not_applicable"]{background:transparent;color:var(--so-ink-3);border:1px dashed var(--so-line-strong)}
.so-fucol{min-width:210px;white-space:normal !important}
.so-fu{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12.5px;color:var(--so-ink-2);margin:2px 0}
.so-fu .so-btn-sm{margin-left:auto}
.so-empty{border:1px dashed var(--so-line-strong);border-radius:7px;background:var(--so-panel);padding:34px 20px;text-align:center;color:var(--so-ink-3);display:flex;flex-direction:column;align-items:center;gap:8px}
.so-empty strong{font-size:15px;font-weight:600;color:var(--so-ink)}
.so-empty span{font-size:13.5px;max-width:52ch;line-height:1.7}
.so-alert{padding:9px 12px;border:1px solid;border-radius:5px;font-size:13.5px;line-height:1.6;overflow-wrap:anywhere}
.so-error{color:var(--so-bad);background:var(--so-bad-soft);border-color:#e0c1b7}
.so-warning{color:var(--so-warn);background:var(--so-warn-soft);border-color:#e1d2ab}
.so-note{color:var(--so-ink-3);font-size:13px}
.so-anomlist{list-style:none;margin:0;padding:0}
.so-anom{display:grid;grid-template-columns:78px minmax(0,1fr) auto;gap:10px;align-items:start;padding:9px 0;border-top:1px solid var(--so-line-soft)}
.so-anom:first-child{border-top:0}
.so-anom-msg{min-width:0;font-size:13.5px}
.so-anom-msg b{display:block;font-weight:600;overflow-wrap:anywhere}
.so-anom-msg p{margin:2px 0 0;color:var(--so-ink-3);font-size:13px;line-height:1.55;overflow-wrap:anywhere}
.so-anom-act{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.so-source{display:grid;grid-template-columns:130px minmax(0,1fr);gap:6px 12px;font-size:13px;padding:8px 0 0;border-top:1px solid var(--so-line-soft);min-width:0}
.so-source:first-child{border-top:0}
.so-source b{font-weight:600;color:var(--so-ink-2);white-space:nowrap}
.so-source span{color:var(--so-ink-3);overflow-wrap:anywhere;min-width:0}
.so-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px;color:var(--so-ink-3);padding-top:2px}
@media (max-width:1100px){
.so-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:900px){
.so-pagehead{gap:12px}
.so-block{padding:14px 15px 16px}
.so-task{grid-template-columns:104px minmax(0,1fr) auto;row-gap:6px}
.so-task-actions{grid-column:2 / -1;justify-content:flex-start}
}
@media (max-width:700px){
.so-root{padding:16px 14px 36px}
.so-pagehead h1{font-size:20px}
.so-actions{width:100%}
.so-actions .so-btn{flex:1 1 auto}
.so-spine{padding:9px 12px;gap:8px}
.so-spine-facts{margin-left:0;width:100%;padding-top:6px;border-top:1px solid var(--so-line-soft)}
.so-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.so-metric{padding:12px 13px}
.so-metric-value{font-size:23px}
.so-task{grid-template-columns:minmax(0,1fr);gap:4px}
.so-task-time{flex-direction:row;gap:8px;align-items:baseline}
.so-task-actions{grid-column:1;justify-content:flex-start;margin-top:2px}
.so-toolbar{gap:8px}
.so-search{width:100%}
.so-count{margin-left:0}
.so-anom{grid-template-columns:64px minmax(0,1fr)}
.so-anom-act{grid-column:2;justify-content:flex-start}
.so-source{grid-template-columns:1fr}
}
@media (max-width:430px){
.so-root{font-size:15px;padding:12px 10px 30px}
.so-btn{height:40px;font-size:15px}
.so-btn-sm{height:36px;font-size:14px}
.so-field input,.so-field select,.so-search{height:40px;font-size:16px}
.so-metrics{grid-template-columns:1fr 1fr}
.so-groupgrid{grid-template-columns:repeat(2,minmax(0,1fr))}
.so-groupcard{padding:10px 11px 11px}
.so-metric-name{font-size:13px}
}
`
  /** 页面身份：共享逻辑在 research-core/client-identity.mjs，预置段把同一实现装到 window。 */
  const identityApi=window.__DSH_RESEARCH_CLIENT_IDENTITY__
  if(!identityApi)throw new Error('页面身份模块未加载，请刷新页面')
  let hostCtx=null
  const identity=identityApi.createClientIdentity({
    plugin:'study-ops',
    storage:(()=>{try{return sessionStorage}catch{return null}})(),
    global:(typeof window!=='undefined'?window:globalThis),
    workspaceProvider:ctx=>identityApi.workspaceFromContext(ctx),
  })
  function newPage(){identity.newPage();activeBinding=null;return identity.pageId()}
  /** 数据视图：both=并列（缺省）、core=核心优先、legacy=只看旧文件。 */
  function readView(){try{const saved=localStorage.getItem('dsh:research:run-view:v1');return ['both','core','legacy'].includes(saved)?saved:'both'}catch{return 'both'}}
  let activeBinding=null
  async function requestTicket(){
    await identity.ready()
    const snapshot=identity.prepare(hostCtx)
    return {snapshot,headers:identity.headers(),body:identity.body()}
  }
  async function call(action,payload){
    const ticket=await requestTicket()
    const headers={'x-study-ops':'1',...ticket.headers}
    const url='/api/study-ops'+(payload===undefined?'?action='+encodeURIComponent(action):'')
    if(payload!==undefined)headers['content-type']='application/json'
    const res=await fetch(url,{method:payload===undefined?'GET':'POST',headers,...(payload===undefined?{}:{body:JSON.stringify({action,payload:{...payload,...ticket.body}})})})
    const data=await res.json()
    if(!res.ok||!data.ok){const failure=new Error(data.error?.message||'请求失败');failure.code=data.error?.code;failure.details=data.error?.details;throw failure}
    // 晚到的旧响应不能把当前页面状态改回旧研究/旧工作区（按本次 capture 的绑定核对）。
    identity.accept(ticket.snapshot,data.data&&data.data.binding,{allowRebind:action==='studyConnect'||action==='studyCreate'})
    if(data.data&&data.data.binding&&data.data.binding.token)activeBinding=data.data.binding.token
    return data.data
  }
  const sourceLabel={page:'页面连接',session:'会话连接',workspace:'工作区记录',project:'工作区项目配置',legacy:'旧配置来源',candidate:'候选研究',empty:'空研究',explicit:'已连接'}
  const labels={ok:'通过',missing:'缺记录',unknown:'未知',pending:'待完成',bad:'失败',conflict:'待选择',not_applicable:'不适用',not_due:'待到期'}
  const followupStates={overdue:'已逾期',due:'到期',done:'已完成',scheduled:'未到期',unknown:'未确定'}
  const followupLabel=(follow,visits)=>follow.label||visits.find(visit=>visit.id===(follow.visitId||follow.id))?.label||'随访'
  const groupName=name=>name===''||name==null?'未分组':name
  const fmtTime=value=>{try{return new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}catch{return String(value||'')}}
  function ScheduleForm({snap,onSave,busy}){
    const initial={id:'',date:snap.today,visitId:snap.visits[0]?.id||'',start:'',end:'',resource:'',note:''}
    const [draft,setDraft]=useState(initial),[error,setError]=useState(''),[saving,setSaving]=useState(false)
    const field=(name,label,type='text')=>h('label',{className:'so-field'},h('span',null,label),h('input',{name,'aria-label':label,placeholder:label,type,value:draft[name],onChange:e=>setDraft({...draft,[name]:e.target.value})}))
    async function submit(e){e.preventDefault();if(saving||busy)return;setSaving(true);setError('');try{await onSave(draft);setDraft({...draft,id:'',start:'',end:'',resource:'',note:''})}catch(e){setError(e.message)}finally{setSaving(false)}}
    return h('form',{className:'so-form',onSubmit:submit},
      h('div',{className:'so-form-fields'},
        field('id','参与者编号'),
        h('label',{className:'so-field'},h('span',null,'访视'),h('select',{'aria-label':'访视',value:draft.visitId,onChange:e=>setDraft({...draft,visitId:e.target.value})},snap.visits.map(v=>h('option',{key:v.id,value:v.id},v.label||v.id)))),
        field('date','预约日期','date'),field('start','开始 HH:mm'),field('end','结束 HH:mm'),field('resource','资源或地点'),field('note','备注')),
      h('div',{className:'so-form-actions'},h('button',{className:'so-btn so-btn-primary',disabled:busy||saving||!snap.visits.length,type:'submit'},saving?'保存中…':'加入安排'),error?h('span',{className:'so-form-error',role:'alert'},error):null))
  }
  function ConnectBar({snap,busy,onDone}){
    const [path,setPath]=useState((snap&&snap.study&&snap.study.path)||'')
    const [name,setName]=useState('')
    const [err,setErr]=useState('')
    const [working,setWorking]=useState(false)
    const view=(snap&&snap.binding)||{}
    const source=sourceLabel[view.source]||view.source||'未连接'
    async function run(kind){
      if(working||busy)return
      const target=path.trim()
      if(!target){setErr('请填写研究定义 JSON 的完整路径');return}
      setWorking(true);setErr('')
      try{
        newPage()
        if(kind==='create')await call('studyCreate',{studyPath:target,name:name.trim()||undefined})
        else await call('studyConnect',{studyPath:target})
        await onDone()
      }catch(e){setErr(e.message)}finally{setWorking(false)}
    }
    return h('details',{className:'so-disclosure so-connect'},
      h('summary',null,'研究连接 · '+(snap&&snap.study?snap.study.name:'未连接')+'（'+source+'）'),
      h('div',{className:'so-form'},
        h('div',{className:'so-form-fields'},
          h('label',{className:'so-field'},h('span',null,'研究定义路径（…/study.json）'),h('input',{value:path,placeholder:'D:\\研究目录\\study.json',onChange:e=>setPath(e.target.value),'aria-label':'研究定义路径'})),
          h('label',{className:'so-field'},h('span',null,'新建时的研究名称（可选）'),h('input',{value:name,placeholder:'例如：合成研究 A',onChange:e=>setName(e.target.value),'aria-label':'新建研究名称'}))),
        h('div',{className:'so-form-actions'},
          h('button',{className:'so-btn so-btn-primary',type:'button',disabled:working||busy,onClick:()=>run('connect')},'连接已有研究'),
          h('button',{className:'so-btn so-btn-quiet',type:'button',disabled:working||busy,onClick:()=>run('create')},'创建空研究'),
          h('span',{className:'so-note'},'连接只改变当前页面；其他页面与会话保留各自绑定。')),
        err?h('span',{className:'so-form-error',role:'alert'},err):null,
        h('div',{className:'so-source'},h('b',null,'当前绑定'),h('span',null,source+(view.instanceId?' · 实例 '+String(view.instanceId).slice(0,14):'')+(view.studyPath?' · '+view.studyPath:' · 无研究定义')+(view.bindingRevision!==undefined?' · 版本 '+view.bindingRevision:'')))))
  }
  function CoreSection({core,busy,onRefresh,detail,reason,setReason,onOpen,onAdjudicate,onCancel,onOpenPanel,onFollowup,coreAt,coreError}){
    const [colFilter,setColFilter]=useState('behavior')
    const staleNote=coreError?h('p',{className:'so-alert so-error',role:'alert'},'核心读取失败：'+coreError+(core&&coreAt?'；显示的是 '+fmtTime(coreAt)+' 的快照，可点刷新重试':'')):null
    // 首次渲染时 core 还是 null（load() 先 setSnap 再 await loadCore）；这里必须能安全渲染，
    // 否则整个面板会被错误边界抹成空白。
    if(!core)return h('details',{className:'so-disclosure so-core'},h('summary',null,'已提交数据（核心）：正在读取…'),staleNote)
    const totals=core.totals||{}
    const sex=core.sex||{}
    const label={male:'男',female:'女',other:'其他',unknown:'未知',missing:'缺失'}
    const stateLabel={not_due:'未到期',missing:'缺失',received:'已收到',entered:'已录入',complete:'完成',conflict:'冲突'}
    const qualityLabel={unchecked:'未校验',valid:'有效',invalid:'不合格',unscorable:'不可计分',unknown:'未知'}
    const legacyBytes=Object.values(core.sources||{}).reduce((sum,health)=>sum+((health&&health.legacy&&health.legacy.state==='ok'&&health.legacy.bytes)||0),0)
    const summary=core.error
      ? '已提交数据（核心）：读取失败'
      : (totals.participants||0)===0&&legacyBytes>0
        ? '已提交数据（核心）：尚未开始（旧文件 '+Math.round(legacyBytes/1024)+' KB 未迁移）'
        : '已提交数据（核心）：入组 '+(totals.enrolled||0)+' · 男 '+(sex.male||0)+' 女 '+(sex.female||0)+' 其他 '+(sex.other||0)+' 未知 '+(sex.unknown||0)+' 缺失 '+(sex.missing||0)
    const visits=core.visits||[]
    const tasks=core.tasks||[]
    const allCols=[]
    for(const visit of visits)for(const task of tasks)if((task.visits||[]).includes(visit.id))allCols.push({visit,task})
    // 任务多起来以后（私有研究现在 34 个任务、38 列），默认只显示有记录的列；取消勾选可看全部。
    const recordedKeys=new Set()
    for(const row of (core.matrix||[])){
      for(const [key,slot] of Object.entries(row.slots||{})){
        if(slot&&!['missing','not_applicable','not_due'].includes(slot.collection))recordedKeys.add(key)
      }
    }
    const scaleTaskIds=new Set(tasks.filter(task=>task.source&&task.source.type==='scale').map(task=>task.id))
    const cols=
      colFilter==='recorded'?allCols.filter(item=>recordedKeys.has(item.visit.id+'::'+item.task.id))
      :colFilter==='behavior'?allCols.filter(item=>!scaleTaskIds.has(item.task.id))
      :colFilter==='scale'?allCols.filter(item=>scaleTaskIds.has(item.task.id))
      :allCols
    const matrix=Array.isArray(core.matrix)&&cols.length
      ? h('div',{className:'so-table-wrap',tabIndex:0,role:'region','aria-label':'核心数据任务矩阵'},
          h('table',{className:'so-table'},
            h('thead',null,h('tr',null,
              h('th',{className:'so-idcol',scope:'col'},'参与者'),
              cols.map(c=>h('th',{key:c.visit.id+'|'+c.task.id,className:'so-taskcol',scope:'col'},(c.visit.label||c.visit.id)+' · '+(c.task.label||c.task.id))),
              h('th',{className:'so-fucol',scope:'col'},'状态'))),
            h('tbody',null,core.matrix.map(row=>h('tr',{key:row.participantKey},
              h('th',{className:'so-idcol',scope:'row'},h('span',{className:'so-id-main'},row.participantId),h('span',{className:'so-id-sub'},(row.status==='enrolled'?'已入组':row.status)+' · '+(Object.values(row.groups||{}).join(' · ')||'未分组'))),
              cols.map(c=>{
                const slot=row.slots[c.visit.id+'::'+c.task.id]||{}
                const state=slot.collection||'missing'
                return h('td',{key:c.visit.id+'|'+c.task.id,title:(stateLabel[state]||state)+' · 质量 '+(qualityLabel[slot.quality]||slot.quality||'未知')},
                  h('button',{type:'button',className:'so-cell so-cellbtn',disabled:busy,onClick:()=>onOpen(row.participantId,c.visit.id,c.task.id),'data-s':state, 'aria-label':(stateLabel[state]||state)+'：'+row.participantId+' '+c.visit.id+' '+c.task.id},
                    (stateLabel[state]||state)+(slot.quality&&!['unchecked','unknown'].includes(slot.quality)?' · '+(qualityLabel[slot.quality]||slot.quality):'')))
              }),
              h('td',{className:'so-fucol'},row.status==='enrolled'?'已入组':row.status))))
          ))
      : h('p',{className:'so-note'},tasks.length?'研究定义已声明 '+tasks.length+' 个任务，但核心还没有参与者或记录，矩阵暂时为空。':'核心投影里还没有任务矩阵（研究定义没有访视或任务）。')
    return h('details',{className:'so-disclosure so-core'},
      h('summary',{title:'分母=已入组；来源版本 '+(String(core.inputRevision||'').slice(0,8)||'—')+'（同一版本可重复重建）'},summary),
      core.error
        ? h('div',null,h('p',{className:'so-note'},'核心读取失败：'+core.error),staleNote)
        : h('div',{className:'so-shell'},
          staleNote,
          (totals.participants||0)===0
            ? h('p',{className:'so-note'},'核心还没有已提交记录；下面的数字来自旧文件扫描。迁移完成后这里才会成为唯一来源。')
            : h('p',{className:'so-note'},'上面四个指标来自旧文件扫描；这里读的是已提交版本（迁移期并列显示，两边不同属正常）。'),
          h('div',{className:'so-spine-facts'},
            h('span',null,'参与者 '+(totals.participants||0)),
            h('span',null,'已入组 '+(totals.enrolled||0)),
            h('span',null,'已登记未入组 '+(totals.registered||0)),
            h('span',null,'退出 '+(totals.exited||0)),
            h('span',{className:'so-tag '+(sex.mapped?'so-tag-info':'so-tag-warn')},sex.mapped?'核心人口学':'未识别性别字段')),
          (core.groups||[]).length?h('div',{className:'so-groupgrid'},core.groups.map(group=>h('div',{key:group.group,className:'so-groupcard',title:'分母：该组已入组 '+group.enrolled+' 人；来源版本 '+(String(core.inputRevision||'').slice(0,8)||'—')},            h('div',{className:'so-groupname'},group.group==='未分组'?'未分组':group.group),
            h('div',{className:'so-groupcount'},group.enrolled,h('small',null,'人已入组')),
            h('div',{className:'so-groupsex'},['male','female','other','unknown','missing'].map(key=>label[key]+' '+group.sex[key]).join(' · '))))):h('p',{className:'so-note'},'核心投影里还没有分组。'),
          h('div',{className:'so-spine-facts'},
            h('span',null,'异常 '+((core.anomalies||[]).length)),
            h('span',null,'随访 到期 '+((core.followupCounts&&core.followupCounts.due)||0)+' · 逾期 '+((core.followupCounts&&core.followupCounts.overdue)||0)),
            h('span',null,'输入版本 '+String(core.inputRevision||'').slice(0,8))),
          h('div',{className:'so-spine-facts'},h('b',null,'图例'),
            h('span',{className:'so-tag so-tag-ok'},'完成'),
            h('span',{className:'so-tag so-tag-info'},'已录入'),
            h('span',{className:'so-tag so-tag-warn'},'缺失/未到期'),
            h('span',{className:'so-tag so-tag-bad'},'冲突/不合格'),
            h('label',{className:'so-note',style:{display:'inline-flex',alignItems:'center',gap:6,marginLeft:'auto'}},'列范围',
              h('select',{className:'so-mini',value:colFilter,onChange:e=>setColFilter(e.target.value),'aria-label':'矩阵列范围'},
                h('option',{value:'behavior'},'行为任务（DDT/IDM）'),
                h('option',{value:'scale'},'量表'),
                h('option',{value:'recorded'},'有记录的列'),
                h('option',{value:'all'},'全部（'+allCols.length+' 列）')))),
          matrix,
          (()=>{
            const rows=core.followups||[]
            const followupLabel={scheduled:'未到期',due:'到期',overdue:'逾期',unknown:'未确定',done:'完成'}
            const tone={scheduled:'so-tag-plain',due:'so-tag-warn',overdue:'so-tag-bad',unknown:'so-tag-warn',done:'so-tag-ok'}
            return h('div',{className:'so-block'},
              h('div',{className:'so-blockhead'},h('h3',null,'随访（核心）'),h('p',{className:'so-blocknote'},'锚点=全部必需且适用任务都有效完成的最晚日期；完成后保留证据。')),
              rows.length
                ? h('ul',{className:'so-anomlist'},rows.slice(0,10).map(row=>h('li',{key:row.participantId+'|'+row.followupId,className:'so-anom'},
                    h('span',{className:'so-tag '+(tone[row.state]||'so-tag-plain')},followupLabel[row.state]||row.state),
                    h('span',{className:'so-anom-msg'},h('b',null,row.participantId+' · '+(row.label||row.followupId)),h('p',null,'锚点 '+(row.anchorDate||'未知')+' · 到期 '+(row.dueAt||'未知')+(row.evidence?(' · 证据 '+(row.evidence.type==='observation'?'observation '+row.evidence.observationId:'人工 '+(row.evidence.reason||''))):''))),
                    h('span',{className:'so-anom-act'},h('button',{type:'button',className:'so-btn so-btn-quiet so-btn-sm',disabled:busy,onClick:()=>onFollowup(row,row.state!=='done')},row.state==='done'?'撤销':'完成')))))
                : h('p',{className:'so-note'},'没有随访规则。'))
          })(),
          detail?h('div',{className:'so-block'},
            h('div',{className:'so-blockhead'},h('h3',null,'单元格明细：'+((detail.participant&&detail.participant.participantId)||'')+' '+detail.visitId+' / '+detail.taskId),h('p',{className:'so-blocknote'},'来源、采集状态、质量与冲突；不显示身份联系表。')),
            h('div',{className:'so-spine-facts'},h('span',null,'状态 '+detail.state)),
            (detail.observations||[]).length?h('ul',{className:'so-anomlist'},detail.observations.map(row=>h('li',{key:row.observationId,className:'so-anom'},
              h('span',{className:'so-tag '+((row.adjudication&&row.adjudication.chosen)?'so-tag-ok':'so-tag-plain')},(row.adjudication&&row.adjudication.chosen)?'已选':'候选'),
              h('span',{className:'so-anom-msg'},h('b',null,row.observationId),h('p',null,'采集 '+(stateLabel[row.collectionState]||row.collectionState)+' · 质量 '+(qualityLabel[row.qualityState]||row.qualityState)+' · 来源 '+(row.sourceType||'—')+(row.sourceRevision?' / '+row.sourceRevision:'')+(row.eventDate?' · '+row.eventDate:' · 日期未知'))),
              h('span',{className:'so-anom-act'},h('button',{type:'button',className:'so-btn so-btn-quiet so-btn-sm',disabled:busy||(row.adjudication&&row.adjudication.chosen),onClick:()=>onAdjudicate(row.observationId)},'选为有效'))))):h('p',{className:'so-note'},'这个单元格还没有记录。'),
            h('div',{className:'so-actions'},
              h('input',{className:'so-search',placeholder:'裁决理由（可留空用默认）',value:reason||'',onChange:e=>setReason(e.target.value),'aria-label':'裁决理由',style:{maxWidth:'260px'}}),
              h('button',{type:'button',className:'so-btn so-btn-ghost so-btn-sm',disabled:busy,onClick:onCancel},'撤销裁决'),
              (()=>{
                const taskDef=(core.tasks||[]).find(task=>task.id===detail.taskId)
                const source=taskDef&&taskDef.source&&taskDef.source.type==='scale'?taskDef.source:null
                if(!source||!source.scaleId)return null
                return h('button',{type:'button',className:'so-btn so-btn-quiet so-btn-sm',disabled:busy,onClick:()=>onOpenPanel({participantId:detail.participant&&detail.participant.participantId,scaleId:source.scaleId,waveId:source.waveId})},'在量表计分中打开这个编号')
              })()))
            :h('p',{className:'so-note'},'点击矩阵单元格查看来源、采集状态、质量与冲突，并做裁决。'),
          h('div',{className:'so-actions'},h('button',{className:'so-btn so-btn-quiet so-btn-sm',type:'button',disabled:busy,onClick:onRefresh},'刷新核心投影'))))
  }
  function Panel({openPanel}){
    const [snap,setSnap]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[filter,setFilter]=useState('all'),[notice,setNotice]=useState(''),[dismissed,setDismissed]=useState(false),[query,setQuery]=useState(''),[stale,setStale]=useState(false),[staleKind,setStaleKind]=useState(''),[core,setCore]=useState(null),[cellDetail,setCellDetail]=useState(null),[reason,setReason]=useState(''),[coreAt,setCoreAt]=useState(''),[coreError,setCoreError]=useState(''),[view,setView]=useState(readView())
    function switchView(next){setView(next);try{localStorage.setItem('dsh:research:run-view:v1',next)}catch{/* 忽略 */}}
    async function loadCore(){
      try{const next=await call('flowProjection');setCore(next);setCoreError('');setCoreAt(new Date().toISOString())}
      catch(e){setCoreError(e.message)}
    }
    // 变化订阅的轻量版：页面可见时每 20 秒读一次核心投影，窗口重新聚焦时也读一次；
    // 读失败保留最后一次成功的核心数据与时间，不把已显示的投影清空。
    useEffect(()=>{
      const tick=()=>{ if(typeof document!=='undefined'&&document.visibilityState==='hidden')return; loadCore() }
      const timer=setInterval(tick,20000)
      const onFocus=()=>loadCore()
      if(typeof window!=='undefined')window.addEventListener('focus',onFocus)
      return ()=>{clearInterval(timer);if(typeof window!=='undefined')window.removeEventListener('focus',onFocus)}
    },[])
    async function openCell(participantId,visitId,taskId){
      try{setCellDetail(await call('observationDetail',{participantId,visitId,taskId}))}
      catch(e){setNotice('读取单元格明细失败：'+e.message)}
    }
    async function adjudicateCell(observationId){
      if(!cellDetail)return
      try{
        setBusy(true)
        const detail=await call('observationAdjudicate',{participantId:cellDetail.participant&&cellDetail.participant.participantId,visitId:cellDetail.visitId,taskId:cellDetail.taskId,observationId,reason:reason.trim()||'运行台人工裁决'})
        setCellDetail(detail);setReason('');await loadCore()
      }catch(e){setError(e.message)}finally{setBusy(false)}
    }
    async function cancelCell(){
      if(!cellDetail)return
      try{
        setBusy(true)
        const detail=await call('observationCancel',{participantId:cellDetail.participant&&cellDetail.participant.participantId,visitId:cellDetail.visitId,taskId:cellDetail.taskId})
        setCellDetail(detail);await loadCore()
      }catch(e){setError(e.message)}finally{setBusy(false)}
    }
    async function markFollowup(row,done){
      try{
        setBusy(true)
        await call('followupMark',{participantId:row.participantId,followupId:row.followupId,done,reason:done?'运行台人工标记':'运行台撤销标记'})
        await loadCore();setNotice(done?'已标记随访完成：'+row.participantId:'已撤销随访完成：'+row.participantId)
      }catch(e){setError(e.message)}finally{setBusy(false)}
    }
    function openScalePanel(hint){
      try{localStorage.setItem(identity.focusKey(),JSON.stringify({...hint,at:Date.now()}))}catch(e){setNotice('无法写入焦点提示：'+e.message)}
      if(openPanel)openPanel('scale-desk')
      else setNotice('已在本地记录焦点；打开「量表计分」即可看到提示')
    }
    const load=useCallback(async(force=false)=>{setBusy(true);setError('');try{const next=await call(force?'refresh':'status',force?{forceQc:true}:undefined);setSnap(next);setStale(false);await loadCore()}catch(e){if(['binding_conflict','binding_required','study_missing'].includes(e.code)){setStale(true);setStaleKind(e.code)};setError(e.message)}finally{setBusy(false)}},[snap?.binding?.bindingRevision])
    useEffect(()=>{load()},[])
    async function save(action,payload){setBusy(true);setError('');try{const result=await call(action,{...payload,stateRevision:snap.stateRevision});try{setSnap(await call('status'))}catch(e){setNotice('已保存；状态刷新失败，请刷新后再操作：'+e.message)}return result}catch(e){if(['binding_conflict','binding_required','study_missing'].includes(e.code)){setStale(true);setStaleKind(e.code)};setError(e.message);throw e}finally{setBusy(false)}}
    const click=(action,payload)=>()=>{save(action,payload).catch(()=>{})}
    const header=h('header',{className:'so-pagehead'},
      h('div',{className:'so-headtext'},h('h1',null,'实验运行台'),h('p',{className:'so-pagemeta'},(snap?.study.name||'当前研究')+(snap?.generatedAt?' · 更新于 '+fmtTime(snap.generatedAt):''))),
      h('div',{className:'so-actions'},
        h('button',{className:'so-btn so-btn-quiet',type:'button',title:'共享研究选择器 v2（2026-11-14）',onClick:openPickerFromButton},'研究切换'),
        h('div',{className:'so-filter',role:'group','aria-label':'数据视图'},
          h('button',{type:'button','aria-pressed':view==='both',onClick:()=>switchView('both')},'并列'),
          h('button',{type:'button','aria-pressed':view==='core',onClick:()=>switchView('core')},'核心'),
          h('button',{type:'button','aria-pressed':view==='legacy',onClick:()=>switchView('legacy')},'旧文件')),
        h('button',{className:'so-btn so-btn-quiet',disabled:busy,onClick:()=>load()},'刷新'),
        h('button',{className:'so-btn so-btn-primary',disabled:busy,onClick:()=>load(true)},'重新检查'),
        h('button',{className:'so-btn so-btn-quiet',disabled:busy||!snap,onClick:async()=>{try{const data=await call('export',{});setNotice('已导出：'+data.files.map(f=>f.name).join('、'))}catch(e){setError(e.message)}}},'导出报告')))
    if(!snap)return h('div',{className:'so-root'},h('div',{className:'so-shell'},header,error?h('div',{className:'so-alert so-error',role:'alert'},error):null,h('div',{className:'so-empty',role:'status'},h('strong',null,busy?'正在读取研究来源…':'还没有研究状态'),h('span',null,'研究来源连接后，这里会显示入组、预约、随访、矩阵与异常。')),h(ConnectBar,{snap:null,busy,onDone:()=>load()})))
    const slotList=snap.subjects.flatMap(s=>Object.values(s.slots))
    const dueSlots=slotList.filter(x=>!['not_due','not_applicable','na'].includes(x.state))
    const doneSlots=dueSlots.filter(x=>x.state==='ok')

    const followups=snap.subjects.flatMap(s=>(s.followups||[]).filter(f=>['due','overdue'].includes(f.state)).map(f=>({...f,subject:s.id})))
    const schedule=(snap.schedule||[]).slice().sort((a,b)=>(a.date+a.start).localeCompare(b.date+b.start))
    const tasks=[
      ...schedule.map(item=>({kind:'appt',date:item.date,time:item.start,item})),
      ...followups.map(item=>({kind:'follow',date:item.due||'',time:'',item}))
    ].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time))
    const filtered=snap.subjects.filter(s=>filter==='issues'?s.hasIssue:filter==='followup'?s.followups.some(f=>['due','overdue'].includes(f.state)):true).filter(s=>{if(!query.trim())return true;const q=query.trim();return s.id.includes(q)||Object.values(s.groups).some(g=>String(g).includes(q))})
    const sources=Object.entries(snap.sources||{})
    const healthy=sources.filter(([,s])=>s.state==='ok').length
    // 顶部的四个指标按视图取数：核心优先（core）用已提交版本，其余用旧文件扫描。
    const coreReady=Boolean(core&&core.totals&&(core.totals.participants||0)>0)
    const useCore=view==='core'&&coreReady
    // 分组卡与核心投影同源：core 视图优先用已提交代次的 enrolled 分组，避免旧文件分母把登记未入组也算进去。
    const coreGroups=useCore&&core&&Array.isArray(core.groups)&&core.groups.length?core.groups:null
    const groups=coreGroups?coreGroups.map(group=>[group.group,group.enrolled]):Object.entries(snap.enrollment.groups||{})
    const groupSex=coreGroups?(name=>{const found=coreGroups.find(group=>String(group.group)===String(name));return found?{male:found.sex?.male||0,female:found.sex?.female||0,unknown:found.sex?.unknown||0}:null}):(name=>snap.demographics?.present?(snap.demographics.byGroup?.[name]||{male:0,female:0,unknown:0}):null)
    const coreDone=coreReady?((core.matrix||[]).reduce((sum,row)=>sum+Object.values(row.slots||{}).filter(slot=>slot&&slot.collection==='complete').length,0)):0
    const coreBad=coreReady?(core.anomalies||[]).length:0
    const coreFollow=coreReady?(((core.followupCounts||{}).due||0)+((core.followupCounts||{}).overdue||0)):0
    const coreNote=useCore?' · 核心已提交 版本 '+String((core&&core.inputRevision)||'').slice(0,8):''
    const visitCols=(snap.visits||[]).map(v=>({visit:v,cols:(snap.columns||[]).filter(c=>c.visitId===v.id)})).filter(x=>x.cols.length)
    const taskName=c=>{const parts=String(c.label||'').split(' · ');return parts.length>1?parts.slice(1).join(' · '):(c.taskId||c.label||'任务')}
    const matrixHead = h('thead', null,
      h('tr', null,
        h('th', { className: 'so-idcol', rowSpan: 2, scope: 'col' }, '参与者'),
        visitCols.map(({ visit, cols }) => h('th', { key: visit.id, colSpan: cols.length, className: 'so-visitcol', scope: 'colgroup' }, visit.label || visit.id)),
        h('th', { rowSpan: 2, className: 'so-fucol', scope: 'col' }, '随访')),
      h('tr', null, visitCols.flatMap(({ cols }) => cols.map(c => h('th', { key: c.id, className: 'so-taskcol', scope: 'col' }, taskName(c))))))
    const matrixBody = filtered.length
      ? filtered.map(s => h('tr', { key: s.id },
          h('th', { className: 'so-idcol', scope: 'row' },
            h('span', { className: 'so-id-main' }, s.id),
            h('span', { className: 'so-id-sub' }, (Object.values(s.groups).join(' · ') || '未分组') + ' · ' + (s.enrolled ? '已入组' : '待入组'))),
          visitCols.flatMap(({ cols }) => cols.map(c => {
            const slot = s.slots[c.id] || {}
            return h('td', { key: c.id, title: (slot.records || []).map(r => r.recordId + ' ' + r.date + ' ' + r.status).join('\n') },
              h('span', { className: 'so-cell', 'data-s': slot.state || 'unknown' }, labels[slot.state] || slot.state || '—'))
          })),
          h('td', { className: 'so-fucol' }, s.followups?.length
            ? s.followups.map(f => h('div', { key: f.id, className: 'so-fu' },
                h('span', null, followupLabel(f, snap.visits) + ' ' + (f.due || '日期未确定') + ' ' + (followupStates[f.state] || '')),
                f.due ? h('button', { className: 'so-btn so-btn-quiet so-btn-sm', disabled: busy, onClick: click('followup', { id: s.id, followupId: f.id, done: f.state !== 'done' }) }, f.state === 'done' ? '撤销' : '完成') : null))
            : h('span', { className: 'so-note' }, '—'))))
      : h('tr', null, h('td', { colSpan: visitCols.reduce((n, x) => n + x.cols.length, 0) + 2, className: 'so-note' }, snap.subjects.length ? '当前筛选没有参与者。' : '参与者表中还没有可显示的记录。'))
    const matrix = h('section', { className: 'so-block' },
      h('div', { className: 'so-blockhead' }, h('h2', null, '参与者进度'), h('p', { className: 'so-blocknote' }, '按访视组织任务列；悬停单元格可看记录日期与状态依据。'+(view==='core'?' · 旧文件来源':''))),
      h('div', { className: 'so-toolbar' },
        h('input', { className: 'so-search', type: 'search', placeholder: '搜索编号或组别，如 P-013 / A', value: query, onChange: e => setQuery(e.target.value), 'aria-label': '搜索参与者' }),
        h('div', { className: 'so-filter', role: 'group', 'aria-label': '参与者筛选' },
          [['all', '全部'], ['issues', '有异常'], ['followup', '待随访']].map(([key, label]) => h('button', { key, 'aria-pressed': filter === key, onClick: () => setFilter(key) }, label))),
        h('span', { className: 'so-count' }, '显示 ' + filtered.length + ' / ' + snap.subjects.length + ' 人')),
      h('div', { className: 'so-table-wrap', tabIndex: 0, role: 'region', 'aria-label': '参与者任务矩阵' },
        h('table', { className: 'so-table' }, matrixHead, h('tbody', null, matrixBody))))
    const body=h('div',{className:'so-shell'},
      header,
      h(ConnectBar,{snap,busy,onDone:()=>load()}),
      view==='legacy'?null:h(CoreSection,{core,busy,onRefresh:loadCore,detail:cellDetail,reason,setReason,onOpen:openCell,onAdjudicate:adjudicateCell,onCancel:cancelCell,onOpenPanel:openScalePanel,onFollowup:markFollowup,coreAt,coreError}),
      stale?h('div',{className:'so-alert so-error',role:'alert'},(staleKind==='binding_required'?'页面绑定已失效：点“重新加载研究”后即可写入；草稿不会丢失。':'研究已变化：当前页面的绑定已过期，写入会被拒绝。请先导出需要的草稿，再重新加载或连接研究。'),h('button',{className:'so-btn so-btn-quiet so-btn-sm',type:'button',onClick:()=>{newPage();(async()=>{try{await call('studyConnect',{studyPath:snap.study&&snap.study.path})}catch(e){setError(e.message)}finally{load()}})()}},'重新加载研究')):null,
      error?h('div',{className:'so-alert so-error',role:'alert'},error):null,
      notice?h('div',{className:'so-alert so-note',role:'status'},notice):null,
      h('div',{className:'so-spine'},
        h('div',{className:'so-spine-id'},h('b',null,snap.study.name),h('span',null,snap.study.id)),
        h('div',{className:'so-spine-facts'},h('span',null,'状态版本 '+snap.stateRevision),h('span',null,'来源 '+healthy+' / '+sources.length+' 正常'),snap.demographics?.present?h('span',null,'男 '+snap.demographics.sex.male+' · 女 '+snap.demographics.sex.female+(snap.demographics.sex.unknown?' · 未知 '+snap.demographics.sex.unknown:'')):null,snap.binding?h('span',null,'实例 '+String(snap.binding.instanceId||'').slice(0,12)):null)),
      snap.empty?h('div',{className:'so-empty'},h('strong',null,'尚未配置研究来源'),h('span',null,'通过 studyPath 指定参与者表、访视、任务和记录长表。')):null,
      sources.filter(([,s])=>s.state!=='ok').map(([name,s])=>h('div',{key:name,className:'so-alert '+(s.state==='empty'?'so-note':'so-warning')},name+'：'+({empty:'来源为空',missing:'来源不存在',error:'读取失败',unconfigured:'未配置'}[s.state]||s.state)+(s.error?'；'+s.error:''))),
      (snap.fileIssues||[]).map((f,i)=>h('div',{key:i,className:'so-alert so-error'},f.source+(f.row?' 第'+f.row+'行':'')+'：'+f.text)),
      view==='core'&&!coreReady?h('div',{className:'so-alert so-note',role:'status'},'当前视图是「核心」，但核心还没有已提交数据；下面暂时显示旧文件扫描的数字。完成一次人口学保存或量表重算后会自动改用核心。'):null,
      h('div',{className:'so-metrics'},
        h('div',{className:'so-metric'},h('span',{className:'so-metric-name'},'已入组'),h('span',{className:'so-metric-value'},useCore?core.totals.enrolled:snap.enrollment.n,h('small',null,'人')),h('span',{className:'so-metric-scope'},useCore?'分母：核心参与者索引'+coreNote:'参与者表共 '+snap.enrollment.total+' 人；按研究规则统计')),
        h('div',{className:'so-metric'},h('span',{className:'so-metric-name'},'任务完成'),h('span',{className:'so-metric-value'},useCore?coreDone:doneSlots.length,h('small',null,'份')),h('span',{className:'so-metric-scope'},useCore?'核心矩阵里采集状态为「完成」的格'+coreNote:'已完成 '+doneSlots.length+' / 应完成 '+dueSlots.length+'；不含未到期与不适用')),
        h('div',{className:'so-metric','data-tone':(useCore?coreBad:snap.counts.bad+snap.counts.warn)>0?'bad':'ok'},h('span',{className:'so-metric-name'},'异常'),h('span',{className:'so-metric-value'},useCore?coreBad:snap.counts.bad+snap.counts.warn,h('small',null,'条')),h('span',{className:'so-metric-scope'},useCore?'冲突 / 已到期缺失 / 质量不合格'+coreNote:'高 '+snap.counts.bad+' 条 · 中 '+snap.counts.warn+' 条')),
        h('div',{className:'so-metric'},h('span',{className:'so-metric-name'},'随访待办'),h('span',{className:'so-metric-value'},useCore?coreFollow:snap.counts.followupDue,h('small',null,'项')),h('span',{className:'so-metric-scope'},useCore?'核心随访里「到期 + 逾期」'+coreNote:'到期或逾期；每人按随访规则计'))),
      h('section',{className:'so-block'},h('div',{className:'so-blockhead'},h('h2',null,'分组进度'),h('p',{className:'so-blocknote'},'按入组规则统计；未设置目标人数时不显示进度。'+(coreGroups?' · 核心已入组':' · 旧文件来源'))),
        groups.length?h('div',{className:'so-groupgrid'},groups.map(([name,n])=>{
          const sex=groupSex(name)
          return h('div',{key:name,className:'so-groupcard'},
            h('div',{className:'so-groupname'},groupName(name),name?h('span',null,'组'):null),
            h('div',{className:'so-groupcount'},n,h('small',null,'人已入组')),
            sex?h('div',{className:'so-groupsex'},'男 '+sex.male+' · 女 '+sex.female+(sex.unknown?' · 未知 '+sex.unknown:'')):null,
            h('div',{className:'so-groupscope'},'未设置目标人数，不显示进度'))
        })):h('p',{className:'so-note'},'当前研究没有分组列。')),
      h('section',{className:'so-block'},h('div',{className:'so-blockhead'},h('h2',null,'今日与近期任务'),h('p',{className:'so-blocknote'},'预约与到期随访按日期排序；完成操作会立即写入研究状态。')),
        tasks.length?h('ul',{className:'so-tasklist'},tasks.map(({kind,date,time,item})=>{
          const isAppt=kind==='appt'
          const visit=isAppt?snap.visits.find(v=>v.id===item.visitId):null
          const state=isAppt?item.status:item.state
          const stateText=isAppt?({arrived:'已到',noshow:'缺席',planned:'未到',missed:'未到',data:'数据已到'}[state]||state):(followupStates[state]||'未确定')
          const tone=isAppt?(state==='arrived'||state==='data'?'ok':state==='noshow'?'bad':'warn'):(state==='overdue'?'bad':'warn')
          return h('li',{key:kind+'-'+(item.key||item.id)+'-'+(item.subject||''),className:'so-task'},
            h('div',{className:'so-task-time'},h('b',null,date||'日期未定'),h('span',null,time||'—')),
            h('div',null,h('div',{className:'so-task-title'},(item.subject||item.id||'参与者')+' · '+(isAppt?(visit?.label||item.visitId):followupLabel(item,snap.visits))),h('div',{className:'so-task-sub'},isAppt?(item.note||'预约')+' · '+(item.resource||'未指定地点'):('到期 '+item.due+' · 随访'))),
            h('span',{className:'so-tag so-tag-'+tone},stateText),
            h('div',{className:'so-task-actions'},isAppt?[
              h('button',{key:'att',className:'so-btn so-btn-quiet so-btn-sm',disabled:busy,onClick:click('attendance',{key:item.key,status:item.attendance==='arrived'?'noshow':item.attendance==='noshow'?'':'arrived'})},item.attendance==='arrived'?'取消已到':item.attendance==='noshow'?'标记已到':'标记已到'),
              h('button',{key:'del',className:'so-btn so-btn-ghost so-btn-sm',disabled:busy,onClick:click('schedule',{op:'remove',key:item.key})},'删除')
            ]:[item.due?h('button',{key:'done',className:'so-btn so-btn-quiet so-btn-sm',disabled:busy,onClick:click('followup',{id:item.subject,followupId:item.id,done:item.state!=='done'})},'标记完成'):h('span',{key:'nodue',className:'so-note'},'日期未确定')])
          )
        })):h('p',{className:'so-note'},'今天与近期没有预约或到期随访。'),
        h('details',{className:'so-disclosure'},h('summary',null,'新建预约'),h(ScheduleForm,{key:snap.study.id,snap,busy,onSave:draft=>save('schedule',{op:'add',...draft})}))),
      matrix,
      h('section',{className:'so-block'},h('div',{className:'so-blockhead'},h('h2',null,'异常处理'),h('p',{className:'so-blocknote'},'忽略不会删除记录；忽略原因会写入研究状态。'+(view==='core'?' · 旧文件来源':''))),
        snap.anomalies.length?h('ul',{className:'so-anomlist'},snap.anomalies.map(a=>h('li',{key:a.key,className:'so-anom'},h('span',{className:'so-tag '+(a.level==='bad'?'so-tag-bad':'so-tag-warn')},a.level==='bad'?'高':'中'),h('span',{className:'so-anom-msg'},h('b',null,a.id),h('p',null,a.text)),h('span',{className:'so-anom-act'},h('button',{className:'so-btn so-btn-quiet so-btn-sm',disabled:busy,onClick:click('dismiss',{key:a.key})},'忽略'))))):h('p',{className:'so-note'},'没有待处理异常。'),
        h('button',{className:'so-btn so-btn-ghost so-btn-sm',disabled:busy,onClick:()=>setDismissed(!dismissed)},(dismissed?'收起':'查看')+'已忽略 '+snap.dismissed.length+' 条'),
        dismissed?h('ul',{className:'so-anomlist',style:{marginTop:8}},snap.dismissed.map(a=>h('li',{key:a.key,className:'so-anom'},h('span',{className:'so-tag so-tag-plain'},'已忽略'),h('span',{className:'so-anom-msg'},h('b',null,a.id),h('p',null,a.text+'；'+a.dismissedAt+(a.note?'；'+a.note:''))),h('span',{className:'so-anom-act'},h('button',{className:'so-btn so-btn-quiet so-btn-sm',disabled:busy,onClick:click('restore',{key:a.key})},'恢复'))))):null,
        h('details',{className:'so-disclosure'},h('summary',null,'来源与技术详情'),sources.map(([name,s])=>h('div',{key:name,className:'so-source'},h('b',null,name),h('span',null,({ok:'正常',empty:'空来源',missing:'不存在',error:'读取失败',unconfigured:'未配置'}[s.state]||s.state)+(s.path?' · '+s.path:'')+(s.hash?' · '+String(s.hash).slice(0,12):'')))))),
      h('div',{className:'so-foot'},h('span',null,'更新于 '+fmtTime(snap.generatedAt)),h('span',null,'状态版本 '+snap.stateRevision),h('span',null,'规则 '+(snap.ruleVersion||'—')))
    )
    return h('div',{className:'so-root'},body)
  }
  function openPickerFromButton() {
    try {
      const ui = (hostCtx && hostCtx.get && hostCtx.get('uiWorkspace')) || (hostCtx && hostCtx.uiWorkspace)
      const factory = window.__DSH_RESEARCH_PICKER__
      if (!factory) throw new Error('共享选择器模块未加载')
      const picker = factory.createStudyPicker({
        plugin: 'study-ops', route: '/api/study-ops',
        headers: () => ({ 'x-study-ops': '1', ...identity.headers() }),
        pickDirectory: ui && typeof ui.pickDirectory === 'function' ? () => ui.pickDirectory() : null,
      })
      picker.install()
      picker.open()
    } catch (error) {
      try { window.alert('研究选择器不可用：' + (error && error.message ? error.message : String(error))) } catch { /* 无窗口 */ }
    }
  }
  return {inject:['slots'],identity,apply(ctx){hostCtx=ctx;ctx.effect(()=>{const style=document.createElement('style');style.textContent=CSS;document.head.appendChild(style);return()=>style.remove()},'study-ops: styles');
try{const ui=(ctx.get&&ctx.get('uiWorkspace'))||ctx.uiWorkspace;window.__DSH_RESEARCH_PICKER__&&window.__DSH_RESEARCH_PICKER__.createStudyPicker({plugin:'study-ops',route:'/api/study-ops',headers:()=>({'x-study-ops':'1',...identity.headers()}),pickDirectory:ui&&typeof ui.pickDirectory==='function'?()=>ui.pickDirectory():null}).install()}catch(error){console.warn('[study-ops] study picker not installed',error)}
ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'study-ops',order:31,label:'实验运行台'},()=>h('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,'aria-hidden':true},h('rect',{x:4,y:3,width:16,height:18,rx:3}),h('path',{d:'M8 8h8M8 12h8M8 16h5'}))));ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'study-ops'},()=>h(Panel,{openPanel:id=>{try{ctx.get('layout')?.selectPanel?.(id)}catch{/* 没有布局服务时只保留焦点提示 */}}})))}}
}})
