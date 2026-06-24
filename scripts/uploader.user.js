// ==UserScript==
// @name         Image Uploader (R2 + hw-img-host)
// @name:zh-CN   图片上传助手 (R2 + 自建图床 双通道)
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Hover any image to upload to Cloudflare R2 OR your self-hosted hw-img-host gallery (with tags + dedup). Original R2 logic preserved.
// @description:zh-CN 悬停图片即可上传，支持上传到 Cloudflare R2 或自建图床(hw-img-host，带标签+查重)。保留原 R2 上传逻辑。
// @author       Your Name
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @connect      *
// ==/UserScript==

(function () {
  'use strict'

  // --- 全局配置与状态 ---
  let cfg = {}
  let hoveredImageUrl = null
  let hideButtonTimeout = null
  let hwToken = null
  let hwTokenExpire = 0

  // --- 样式注入 ---
  GM_addStyle(`
    #up-btn { position: absolute; z-index: 100001; display: none; padding: 6px 10px; background-color: rgba(255,145,0,0.9); color: #fff; border: none; border-radius: 5px; cursor: pointer; font-size: 13px; box-shadow: 0 1px 4px rgba(0,0,0,.3); transition: opacity .2s, background-color .2s; }
    #up-btn:hover { background-color: rgba(245,124,0,1); }
    .up-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 100002; display: none; justify-content: center; align-items: center; }
    .up-box { background: #fff; padding: 25px; border-radius: 8px; box-shadow: 0 5px 15px rgba(0,0,0,.3); width: 90%; max-width: 500px; box-sizing: border-box; }
    .up-box h2 { margin: 0 0 20px; text-align: center; color: #333; font-size: 18px; }
    .up-field { margin-bottom: 15px; }
    .up-field label { display: block; margin-bottom: 5px; font-weight: bold; color: #555; font-size: 13px; }
    .up-field input, .up-field textarea { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; font-size: 13px; font-family: inherit; }
    .up-field input[type=number] { width: 120px; }
    .up-field textarea { min-height: 90px; resize: vertical; }
    .up-field p { font-size: 11px; color: #888; margin: 5px 0 0; }
    .up-btns { text-align: right; margin-top: 20px; }
    .up-btns button { padding: 9px 18px; border: none; border-radius: 4px; cursor: pointer; margin-left: 10px; font-size: 13px; }
    .up-b-green { background: #4CAF50; color: #fff; }
    .up-b-red { background: #f44336; color: #fff; }
    .up-b-blue { background: #2196F3; color: #fff; }
    .up-b-orange { background: #ff9100; color: #fff; }
    .up-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
    .up-chip { display: inline-flex; align-items: center; gap: 4px; background: #eef; border: 1px solid #ccd; border-radius: 12px; padding: 2px 8px; font-size: 12px; color: #336; }
    .up-chip span { cursor: pointer; color: #c00; font-weight: bold; }
    .up-choice { display: flex; flex-direction: column; gap: 12px; }
    .up-choice button { padding: 16px; border: 1px solid #ddd; border-radius: 8px; cursor: pointer; font-size: 15px; text-align: left; background: #fafafa; transition: all .15s; }
    .up-choice button:hover { border-color: #2196F3; background: #f0f7ff; }
    .up-choice small { display: block; color: #888; font-size: 11px; margin-top: 3px; }
    #up-notif { position: fixed; bottom: 20px; right: 20px; z-index: 100003; padding: 13px 22px; border-radius: 5px; color: #fff; font-size: 14px; box-shadow: 0 4px 8px rgba(0,0,0,.2); display: none; max-width: 400px; }
    #up-notif.success { background: #4CAF50; }
    #up-notif.error { background: #f44336; }
    #up-notif.info { background: #2196F3; }
    #up-notif.warn { background: #ff9800; }
  `)

  // --- UI 元素创建 ---
  const notif = document.createElement('div')
  notif.id = 'up-notif'
  document.body.appendChild(notif)

  const upBtn = document.createElement('button')
  upBtn.id = 'up-btn'
  upBtn.textContent = '⬆️ 上传图片'
  document.body.appendChild(upBtn)

  // 设置模态框（R2 + 图床 配置）
  const settingsOverlay = mkOverlay('up-settings-overlay')
  settingsOverlay.querySelector('.up-box').innerHTML = `
    <h2>上传助手设置</h2>
    <div class="up-field"><label>Cloudflare R2 Worker URL</label><input type="text" id="set-r2-url" placeholder="https://your-worker.workers.dev"></div>
    <div class="up-field"><label>R2 Worker 密钥</label><input type="password" id="set-r2-key" placeholder="AUTH_KEY_SECRET"></div>
    <div class="up-field"><label>R2 预设路径（每行一个，可选）</label><textarea id="set-r2-paths"></textarea></div>
    <hr style="border:none;border-top:1px solid #eee;margin:18px 0">
    <div class="up-field"><label>自建图床地址</label><input type="text" id="set-hw-url" placeholder="https://cdn.example.com"></div>
    <div class="up-field"><label>图床上传密码</label><input type="password" id="set-hw-pwd" placeholder="UPLOAD_PASSWORD"></div>
    <div class="up-field"><label>图床常用标签（每行一个，可选）</label><textarea id="set-hw-tags" placeholder="动漫&#10;风景&#10;头像"></textarea></div>
    <hr style="border:none;border-top:1px solid #eee;margin:18px 0">
    <div class="up-field"><label>图片最小尺寸（像素）</label><input type="number" id="set-min-size" placeholder="100"></div>
    <div class="up-btns"><button class="up-b-red" id="set-close">关闭</button><button class="up-b-green" id="set-save">保存</button></div>`

  // 目标选择模态框（R2 / 图床）
  const choiceOverlay = mkOverlay('up-choice-overlay')
  choiceOverlay.querySelector('.up-box').innerHTML = `
    <h2>上传到哪里？</h2>
    <div class="up-choice">
      <button id="choice-hw">🏠 上传到自建图床<small>带标签、自动查重、返回 CDN 链接并自动复制</small></button>
      <button id="choice-r2">☁️ 上传到 Cloudflare R2<small>原 R2 逻辑，可选预设路径</small></button>
    </div>
    <div class="up-btns"><button class="up-b-red" id="choice-cancel">取消</button></div>`

  // R2 路径选择模态框（保留原逻辑）
  const pathOverlay = mkOverlay('up-path-overlay')
  pathOverlay.querySelector('.up-box').innerHTML = `
    <h2>选择 R2 上传路径</h2>
    <div id="r2-presets" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:15px"></div>
    <div class="up-field"><label>目标路径</label><input type="text" id="r2-path-input" placeholder="点击预设或手动输入，须以 / 结尾"></div>
    <div class="up-btns"><button class="up-b-red" id="r2-path-cancel">取消</button><button class="up-b-blue" id="r2-path-ok">确认上传</button></div>`

  // 图床 tag 输入模态框
  const tagOverlay = mkOverlay('up-tag-overlay')
  tagOverlay.querySelector('.up-box').innerHTML = `
    <h2>输入标签（可选）</h2>
    <div class="up-field"><label>标签（逗号或回车分隔）</label><input type="text" id="hw-tag-input" placeholder="动漫, 风景"></div>
    <div id="hw-tag-presets" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px"></div>
    <div class="up-field"><label>自定义文件名（可选）</label><input type="text" id="hw-name-input" placeholder="留空用原文件名"></div>
    <div class="up-btns"><button class="up-b-red" id="hw-tag-cancel">取消</button><button class="up-b-green" id="hw-tag-ok">上传</button></div>`

  function mkOverlay(id) {
    const el = document.createElement('div')
    el.id = id
    el.className = 'up-overlay'
    el.innerHTML = '<div class="up-box"></div>'
    document.body.appendChild(el)
    el.addEventListener('click', (e) => { if (e.target === el) el.style.display = 'none' })
    el.querySelector('.up-box').addEventListener('click', (e) => e.stopPropagation())
    return el
  }

  // --- 工具函数 ---
  function notify(msg, type = 'info', dur = 3000) {
    notif.textContent = msg
    notif.className = type
    notif.style.display = 'block'
    clearTimeout(notify._t)
    notify._t = setTimeout(() => { notif.style.display = 'none' }, dur)
  }

  function gmReq(details) {
    return new Promise((resolve, reject) => {
      details.onload = (r) => (r.status >= 200 && r.status < 300 ? resolve(r) : reject(r))
      details.onerror = (e) => reject(e)
      GM_xmlhttpRequest(details)
    })
  }

  function showOverlay(el) { el.style.display = 'flex' }
  function hideOverlay(el) { el.style.display = 'none' }

  // Promise 化的模态框确认
  function awaitConfirm(overlay, okId, cancelId, onShow) {
    return new Promise((resolve, reject) => {
      const ok = document.getElementById(okId)
      const cancel = document.getElementById(cancelId)
      const onOk = () => { cleanup(); resolve() }
      const onCancel = () => { cleanup(); reject(new Error('cancelled')) }
      const cleanup = () => {
        ok.removeEventListener('click', onOk)
        cancel.removeEventListener('click', onCancel)
        hideOverlay(overlay)
      }
      ok.addEventListener('click', onOk)
      cancel.addEventListener('click', onCancel)
      showOverlay(overlay)
      if (onShow) onShow() // 显示后再执行（focus 才有效）
    })
  }

  // --- 配置管理 ---
  function loadCfg() {
    cfg.r2Url = GM_getValue('r2_url', '')
    cfg.r2Key = GM_getValue('r2_key', '')
    cfg.r2Paths = GM_getValue('r2_paths', 'images/wallpaper/\nimages/avatar/\nimages/temp/')
    cfg.hwUrl = GM_getValue('hw_url', '')
    cfg.hwPwd = GM_getValue('hw_pwd', '')
    cfg.hwTags = GM_getValue('hw_tags', '')
    cfg.minSize = GM_getValue('min_size', 100)
  }

  function showSettings() {
    loadCfg()
    document.getElementById('set-r2-url').value = cfg.r2Url
    document.getElementById('set-r2-key').value = cfg.r2Key
    document.getElementById('set-r2-paths').value = cfg.r2Paths
    document.getElementById('set-hw-url').value = cfg.hwUrl
    document.getElementById('set-hw-pwd').value = cfg.hwPwd
    document.getElementById('set-hw-tags').value = cfg.hwTags
    document.getElementById('set-min-size').value = cfg.minSize
    showOverlay(settingsOverlay)
  }

  function saveSettings() {
    GM_setValue('r2_url', document.getElementById('set-r2-url').value.trim())
    GM_setValue('r2_key', document.getElementById('set-r2-key').value.trim())
    GM_setValue('r2_paths', document.getElementById('set-r2-paths').value)
    GM_setValue('hw_url', document.getElementById('set-hw-url').value.trim().replace(/\/$/, ''))
    GM_setValue('hw_pwd', document.getElementById('set-hw-pwd').value.trim())
    GM_setValue('hw_tags', document.getElementById('set-hw-tags').value)
    const ms = parseInt(document.getElementById('set-min-size').value, 10)
    GM_setValue('min_size', !isNaN(ms) && ms >= 0 ? ms : 100)
    loadCfg()
    hideOverlay(settingsOverlay)
    notify('配置已保存！', 'success')
  }

  // --- 图床鉴权：密码登录拿 JWT，自动续期 ---
  async function getHwToken() {
    if (hwToken && Date.now() < hwTokenExpire - 60000) return hwToken // 提前1分钟续期
    if (!cfg.hwUrl || !cfg.hwPwd) {
      notify('请先在设置里填写图床地址和密码', 'error')
      showSettings()
      throw new Error('no hw config')
    }
    const r = await gmReq({
      method: 'POST',
      url: cfg.hwUrl + '/api/auth/login',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: cfg.hwPwd }),
    })
    const d = JSON.parse(r.responseText)
    if (d.code !== 0 || !d.data || !d.data.token) throw new Error('登录失败: ' + (d.msg || ''))
    hwToken = d.data.token
    // JWT 默认 7 天过期，提前 1 分钟续期
    hwTokenExpire = Date.now() + 6 * 24 * 3600 * 1000
    return hwToken
  }

  // 解析 JWT exp（无需密钥，只读 payload）
  function jwtExp(token) {
    try {
      const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
      return (p.exp || 0) * 1000
    } catch { return 0 }
  }

  // --- 上传到自建图床 ---
  async function uploadToHw(imageUrl) {
    let token
    try {
      token = await getHwToken()
    } catch (e) {
      notify(e.message, 'error', 5000)
      return
    }

    // 弹 tag 框
    let tags = []
    let customName = ''
    try {
      await awaitConfirm(tagOverlay, 'hw-tag-ok', 'hw-tag-cancel', () => {
        // 预设标签按钮
        const presetBox = document.getElementById('hw-tag-presets')
        presetBox.innerHTML = ''
        const tagInput = document.getElementById('hw-tag-input')
        tagInput.value = ''
        document.getElementById('hw-name-input').value = ''
        cfg.hwTags.split('\n').map((t) => t.trim()).filter(Boolean).forEach((t) => {
          const b = document.createElement('button')
          b.className = 'up-chip'
          b.textContent = '+' + t
          b.onclick = () => {
            const cur = tagInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
            if (!cur.includes(t)) cur.push(t)
            tagInput.value = cur.join(', ')
          }
          presetBox.appendChild(b)
        })
        tagInput.focus()
      })
      const tagInput = document.getElementById('hw-tag-input')
      tags = tagInput.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
      customName = document.getElementById('hw-name-input').value.trim()
    } catch {
      notify('已取消', 'info')
      return
    }

    try {
      notify('下载图片中...', 'info')
      const imgResp = await gmReq({
        method: 'GET',
        url: imageUrl,
        responseType: 'blob',
        headers: { Referer: new URL(imageUrl).origin },
      })
      const blob = imgResp.response

      // 文件名：自定义 > 原文件名
      let urlFilenameRaw = imageUrl.substring(imageUrl.lastIndexOf('/') + 1).split('?')[0].split('#')[0]
      const mimeParts = blob.type.split('/')
      let ext = 'jpg'
      if (mimeParts.length > 1 && mimeParts[0] === 'image') {
        let de = mimeParts[1].toLowerCase()
        if (de === 'jpeg') ext = 'jpg'
        else if (de === 'svg+xml') ext = 'svg'
        else if (de) ext = de
      }
      let base = urlFilenameRaw.includes('.')
        ? urlFilenameRaw.substring(0, urlFilenameRaw.lastIndexOf('.'))
        : urlFilenameRaw
      if (!base) base = 'image'
      const finalName = (customName || base) + '.' + ext

      notify('上传到图床...', 'info')

      // FormData 上传（自动查重，命中返回已有链接）
      const form = new FormData()
      form.append('file', blob, finalName)
      const upResp = await gmReq({
        method: 'POST',
        url: cfg.hwUrl + '/api/upload/img',
        headers: { Authorization: 'Bearer ' + token },
        data: form,
      })
      const ud = JSON.parse(upResp.responseText)
      if (ud.code !== 0) throw new Error('上传失败: ' + (ud.msg || '未知'))

      const proxyUrl = ud.data.url
      const isDup = ud.data.duplicate

      // 写入图床索引（带 tag），duplicate 则跳过
      if (!isDup) {
        try {
          await gmReq({
            method: 'POST',
            url: cfg.hwUrl + '/kv-api',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + token,
            },
            data: JSON.stringify({
              url: proxyUrl,
              urlOriginal: ud.data.assets ? 'https://cnb.cool' + ud.data.assets.path : undefined,
              name: finalName,
              size: blob.size,
              type: blob.type,
              compressionRatio: 0,
              width: 0,
              height: 0,
              hasThumbnail: false,
              thumbnailWidth: 0,
              thumbnailHeight: 0,
              thumbnailSize: 0,
              assetsPath: ud.data.assets ? ud.data.assets.path : undefined,
              tags: tags,
              hash: ud.data.hash,
            }),
          })
        } catch (e) { /* 索引写入失败不影响主流程 */ }
      }

      // 复制链接到剪贴板
      try { GM_setClipboard(proxyUrl) } catch {}
      notify(
        (isDup ? '♻️ 文件已存在，复用链接\n' : '✅ 上传成功') + '\n' + proxyUrl + '\n（已复制）' +
          (tags.length ? '\n标签: ' + tags.join(', ') : ''),
        isDup ? 'warn' : 'success',
        6000,
      )
    } catch (error) {
      console.error('hw upload failed:', error)
      let msg = error.responseText || error.message || '未知错误'
      if (error.status === 0) msg = '图片跨域下载失败(防盗链)'
      else if (error.status) msg = `[${error.status}] ${msg}`
      notify('❌ ' + msg, 'error', 5000)
    }
  }

  // --- 上传到 Cloudflare R2（保留原逻辑）---
  async function uploadToR2(imageUrl) {
    if (!cfg.r2Url || !cfg.r2Key) {
      notify('请先在设置里填写 R2 Worker 信息', 'error')
      showSettings()
      return
    }

    // 选路径（保留原交互）
    let chosenPath
    try {
      chosenPath = await new Promise((resolve, reject) => {
        const presets = document.getElementById('r2-presets')
        presets.innerHTML = ''
        const pathInput = document.getElementById('r2-path-input')
        const opts = cfg.r2Paths.split('\n').map((p) => p.trim()).filter(Boolean)
        if (opts.length) {
          opts.forEach((p) => {
            const b = document.createElement('button')
            b.className = 'up-chip'
            b.textContent = p
            b.onclick = () => { pathInput.value = p }
            presets.appendChild(b)
          })
          pathInput.value = opts[0]
        } else {
          pathInput.value = ''
        }
        const ok = document.getElementById('r2-path-ok')
        const cancel = document.getElementById('r2-path-cancel')
        const onOk = () => { cleanup(); resolve(pathInput.value) }
        const onCancel = () => { cleanup(); reject(new Error('cancelled')) }
        const cleanup = () => {
          ok.removeEventListener('click', onOk)
          cancel.removeEventListener('click', onCancel)
          hideOverlay(pathOverlay)
        }
        ok.addEventListener('click', onOk)
        cancel.addEventListener('click', onCancel)
        showOverlay(pathOverlay)
        pathInput.focus()
      })
    } catch {
      notify('已取消', 'info')
      return
    }

    chosenPath = chosenPath.trim()
    if (!chosenPath) { notify('路径不能为空', 'error'); return }
    if (!chosenPath.endsWith('/')) chosenPath += '/'

    try {
      notify('下载图片中...', 'info')
      const imgResp = await gmReq({
        method: 'GET',
        url: imageUrl,
        responseType: 'blob',
        headers: { Referer: new URL(imageUrl).origin },
      })
      const blob = imgResp.response

      notify('上传至 R2...', 'info')
      let urlFilenameRaw = imageUrl.substring(imageUrl.lastIndexOf('/') + 1).split('?')[0].split('#')[0]
      const mimeParts = blob.type.split('/')
      let ext = 'jpg'
      if (mimeParts.length > 1 && mimeParts[0] === 'image') {
        let de = mimeParts[1].toLowerCase()
        if (de === 'jpeg') ext = 'jpg'
        else if (de === 'svg+xml') ext = 'svg'
        else if (de) ext = de
      }
      let base = urlFilenameRaw.includes('.')
        ? urlFilenameRaw.substring(0, urlFilenameRaw.lastIndexOf('.'))
        : urlFilenameRaw
      if (!base) base = 'image'
      const filename = `${base}_${Date.now()}.${ext}`

      await gmReq({
        method: 'PUT',
        url: cfg.r2Url,
        headers: {
          'Content-Type': blob.type,
          'X-Custom-Auth-Key': cfg.r2Key,
          'X-Destination-Filename': chosenPath + filename,
        },
        data: blob,
      })
      notify(`✅ 上传成功: ${filename}`, 'success')
    } catch (error) {
      console.error('R2 upload failed:', error)
      let msg = error.responseText || error.message || '未知错误'
      if (error.status === 0) msg = '图片跨域下载失败(防盗链)'
      else if (error.status) msg = `[${error.status}] ${msg}`
      notify('❌ ' + msg, 'error', 5000)
    }
  }

  // --- 上传入口：点击按钮弹出目标选择 ---
  function bindChoice() {
    document.getElementById('choice-hw').onclick = () => {
      hideOverlay(choiceOverlay)
      uploadToHw(hoveredImageUrl)
    }
    document.getElementById('choice-r2').onclick = () => {
      hideOverlay(choiceOverlay)
      uploadToR2(hoveredImageUrl)
    }
    document.getElementById('choice-cancel').onclick = () => hideOverlay(choiceOverlay)
  }

  // --- 初始化 ---
  function init() {
    loadCfg()
    GM_registerMenuCommand('⚙️ 上传助手设置', showSettings)

    bindChoice()

    // 设置按钮
    document.getElementById('set-save').onclick = saveSettings
    document.getElementById('set-close').onclick = () => hideOverlay(settingsOverlay)

    // 悬停图片显示按钮
    document.addEventListener('mouseover', (e) => {
      const img = e.target
      if (
        img.tagName === 'IMG' &&
        img.src &&
        img.clientWidth >= cfg.minSize &&
        img.clientHeight >= cfg.minSize
      ) {
        if (hideButtonTimeout) clearTimeout(hideButtonTimeout)
        hoveredImageUrl = new URL(img.src, window.location.href).href
        const rect = img.getBoundingClientRect()
        upBtn.style.display = 'block'
        const bw = upBtn.offsetWidth
        const PAD = 5
        upBtn.style.top = `${rect.top + window.scrollY + PAD}px`
        upBtn.style.left = `${rect.right + window.scrollX - bw - PAD}px`
      }
    })

    document.addEventListener('mouseout', (e) => {
      if (e.target.tagName === 'IMG') {
        hideButtonTimeout = setTimeout(() => { upBtn.style.display = 'none' }, 300)
      }
    })
    upBtn.addEventListener('mouseover', () => { if (hideButtonTimeout) clearTimeout(hideButtonTimeout) })
    upBtn.addEventListener('mouseout', () => { hideButtonTimeout = setTimeout(() => { upBtn.style.display = 'none' }, 300) })
    upBtn.addEventListener('click', () => {
      upBtn.style.display = 'none'
      showOverlay(choiceOverlay)
    })

    if (!GM_getValue('r2_url') && !GM_getValue('hw_url')) {
      notify('欢迎使用！点击油猴菜单「上传助手设置」配置', 'info', 6000)
    }
  }

  init()
})()
