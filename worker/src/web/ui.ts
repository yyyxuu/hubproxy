// ---------- Worker 内置 Web 界面（与主项目 web/ 的界面功能对齐） ----------
// 单文件 HTML：分三页（GitHub 加速 + Releases / 镜像搜索 / 镜像标签详情），路径驱动（/、/search、/search/:ns/:name）。
// 无构建步骤、无外部依赖；所有请求都发回本 Worker 自己的 /api/* 与代理路径。

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HubProxy · GitHub 加速 · Releases 下载 · 镜像搜索</title>
<link rel="icon" href="/favicon.ico">
<style>
:root{--bg:#f5f7f8;--fg:#101828;--muted:#667085;--card:#ffffff;--border:#e4e7ec;--soft:#f0fdf4;--soft-border:#bbf7d0;--primary:#0f9d58;--primary-fg:#ffffff;--primary-soft:#e7f6ee;--err:#d92d20;--shadow:0 6px 24px rgba(16,24,40,.06);--radius:16px}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--fg:#e6e8eb;--muted:#98a2b3;--card:#161b22;--border:#252c36;--soft:#10231a;--soft-border:#1f5133;--primary:#22a863;--primary-fg:#04160c;--primary-soft:#122b1d;--err:#f97066;--shadow:0 6px 24px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
[hidden]{display:none !important}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
button{font:inherit;color:inherit}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
.site-header{position:sticky;top:0;z-index:30;background:var(--bg);border-bottom:1px solid var(--border)}
.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;height:64px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px;letter-spacing:.01em}
.logo{width:32px;height:32px;border-radius:9px;display:block}
nav{display:flex;gap:6px;flex-wrap:wrap}
nav a{padding:7px 14px;border-radius:999px;color:var(--muted);font-size:14px;transition:.15s}
nav a:hover{background:var(--primary-soft);color:var(--primary)}
nav a.active{background:var(--primary-soft);color:var(--primary);font-weight:600}
.hero{padding:48px 0 24px;text-align:center}
.eyebrow{margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--primary)}
h1{margin:0 0 10px;font-size:clamp(26px,4vw,38px);line-height:1.25;letter-spacing:-.01em}
h2{margin:0;font-size:19px;letter-spacing:-.01em}
h3{margin:0;font-size:16px}
.sub{margin:0;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:22px;margin-bottom:22px;scroll-margin-top:80px}
.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.muted{color:var(--muted)}
.small{font-size:12.5px}
.tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.tab{border:1px solid var(--border);background:transparent;color:var(--muted);padding:9px 18px;border-radius:10px;cursor:pointer;transition:.15s;font-size:14px;flex:1 1 auto;min-width:105px}
.tab:hover{border-color:var(--primary);color:var(--primary)}
.tab.active{background:var(--primary);border-color:var(--primary);color:var(--primary-fg);font-weight:600}
.row{display:flex;gap:10px;flex-wrap:wrap}
.row>input{flex:1 1 260px;min-width:0}
input{border:1px solid var(--border);background:var(--card);color:var(--fg);border-radius:11px;padding:12px 14px;font:inherit;outline:none;transition:.15s}
input:focus{border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-soft)}
.btn{border:1px solid var(--border);background:var(--card);color:var(--fg);border-radius:11px;padding:11px 18px;cursor:pointer;transition:.15s;font-size:14px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
.btn:hover{border-color:var(--primary);color:var(--primary)}
.btn.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-fg);font-weight:600}
.btn.primary:hover{filter:brightness(1.06);color:var(--primary-fg)}
.btn.ghost{padding:7px 12px;border-radius:9px;font-size:13px;background:transparent;color:var(--muted)}
.btn.ghost:hover{border-color:var(--primary);color:var(--primary)}
.hints{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px}
.hint-label{color:var(--muted);font-size:13px}
.chip{border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:999px;padding:5px 12px;font-size:12.5px;cursor:pointer;transition:.15s}
.chip:hover{border-color:var(--primary);color:var(--primary);background:var(--primary-soft)}
.result{margin-top:16px;border:1px solid var(--soft-border);background:var(--soft);border-radius:12px;padding:14px}
.result-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;font-size:13px;color:var(--primary);font-weight:600}
pre{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.65;white-space:pre-wrap;word-break:break-all}
.notes{max-height:320px;overflow:auto;margin-top:12px;padding:4px 14px;border-radius:10px;background:var(--bg);border:1px solid var(--border)}
.md{font-size:13.5px;line-height:1.7}
.md>:first-child{margin-top:10px}
.md>:last-child{margin-bottom:10px}
.md p{margin:8px 0}
.md h3,.md h4,.md h5,.md h6{margin:14px 0 8px;font-size:15px;line-height:1.4}
.md h3{font-size:16px}
.md ul,.md ol{margin:8px 0;padding-left:20px}
.md li{margin:3px 0}
.md code{background:var(--primary-soft);color:var(--primary);padding:1px 5px;border-radius:5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
.md pre{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px;overflow:auto;margin:10px 0}
.md pre code{background:none;color:inherit;padding:0}
.md a{color:var(--primary);text-decoration:underline}
.md img{max-width:100%;height:auto;vertical-align:middle;margin:2px 4px 2px 0}
.md blockquote{margin:8px 0;padding-left:10px;border-left:3px solid var(--border);color:var(--muted)}
.md hr{border:0;border-top:1px solid var(--border);margin:14px 0}
.err{margin:14px 0 0;color:var(--err);font-size:13.5px}
.release{border:1px solid var(--border);border-radius:13px;padding:16px;margin-top:14px;background:var(--card)}
.rel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.rel-title{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.rel-meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:13px}
.tag{display:inline-flex;align-items:center;border-radius:6px;padding:2px 8px;font-size:12px;background:var(--primary-soft);color:var(--primary);font-weight:600}
.tag.version{background:var(--soft);border:1px solid var(--soft-border)}
.tag.latest{background:var(--primary);color:var(--primary-fg)}
.tag.pre{background:transparent;border:1px dashed var(--border);color:var(--muted)}
.tag.size{background:transparent;border:1px solid var(--border);color:var(--muted);font-weight:400}
.assets{margin-top:12px;display:flex;flex-direction:column;gap:8px}
.asset{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--border);border-radius:10px;padding:10px 12px;flex-wrap:wrap}
.asset-name{display:flex;align-items:center;gap:9px;flex-wrap:wrap;min-width:0}
.asset-name .name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;word-break:break-all}
.asset-actions{display:flex;gap:8px}
.file-icon{color:var(--primary);font-size:13px}
.link{border:0;background:none;color:var(--primary);cursor:pointer;padding:0;font-size:13px}
.list{margin-top:14px;display:flex;flex-direction:column}
.row-item{display:flex;flex-direction:column;gap:4px;text-align:left;border:0;border-bottom:1px solid var(--border);background:none;padding:13px 2px;cursor:pointer;transition:.15s}
.row-item:hover{color:var(--primary)}
.row-item .title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:600}
.row-item .desc{margin:0;color:var(--muted);font-size:13.5px}
.tag-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding:11px 2px;flex-wrap:wrap}
.tag-row .info{min-width:0;display:flex;flex-direction:column;gap:3px}
.tag-row .name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;word-break:break-all}
.archs{display:flex;gap:6px;flex-wrap:wrap}
.arch{border-radius:6px;background:var(--primary-soft);color:var(--primary);padding:1px 7px;font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.skeleton{height:56px;border-radius:11px;background:linear-gradient(90deg,var(--border),var(--card),var(--border));background-size:200% 100%;animation:shimmer 1.2s infinite}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
footer{border-top:1px solid var(--border);margin-top:34px;padding:22px 0 40px;text-align:center;color:var(--muted);font-size:13px}
@media(max-width:600px){.card{padding:16px}.rel-meta{font-size:12px}}
</style>
</head>
<body>
<header class="site-header">
  <div class="wrap bar">
    <a class="brand" href="/" data-nav><img class="logo" src="/favicon.ico" alt="HubProxy" width="32" height="32">HubProxy</a>
    <nav>
      <a href="/" data-nav>GitHub 加速</a>
      <a href="/search" data-nav>镜像搜索</a>
    </nav>
  </div>
</header>

<main class="wrap">
  <!-- 页面一：GitHub 加速 + Releases 解析 -->
  <div id="viewHome" hidden>
    <section class="hero">
      <p class="eyebrow">面向开发者和运维人员的加速服务</p>
      <h1>GitHub 文件加速 · Releases 下载</h1>
      <p class="sub">粘贴 GitHub / Hugging Face 原始链接即得加速地址；仓库主页可直接解析 Releases 全部版本与资产。</p>
    </section>

    <section class="card" id="convert">
      <div class="tabs" id="tabs" role="tablist" aria-label="转换输出格式">
        <button class="tab active" data-mode="raw">原始链接</button>
        <button class="tab" data-mode="clone">Git Clone</button>
        <button class="tab" data-mode="wget">Wget</button>
        <button class="tab" data-mode="curl">cURL</button>
      </div>
      <div class="row">
        <input id="urlInput" aria-label="GitHub 或 Hugging Face 链接" placeholder="https://github.com/owner/repo" autocomplete="off" spellcheck="false">
        <button class="btn primary" id="convertBtn">转换链接</button>
      </div>
      <div class="hints">
        <span class="hint-label">快捷示例：</span>
        <button class="chip" data-fill="https://github.com/sky22333/hubproxy">仓库 Releases 解析</button>
        <button class="chip" data-fill="https://github.com/sky22333/hubproxy/releases/download/v1.2.5/hubproxy-linux-amd64.tar.gz">Release 资产包</button>
        <button class="chip" data-fill="https://github.com/sky22333/hubproxy/archive/refs/heads/main.zip">分支源码（Zip）</button>
        <button class="chip" data-fill="https://raw.githubusercontent.com/sky22333/hubproxy/main/README.md">Raw 原始文件</button>
        <button class="chip" data-fill="https://github.com/sky22333/hubproxy.git">Git 仓库克隆</button>
      </div>
      <p class="err" id="convertErr" hidden></p>
      <div class="result" id="result" hidden>
        <div class="result-head"><span>✓ 加速链接已生成</span><span class="muted" id="resultMode"></span></div>
        <pre id="resultText"></pre>
        <div class="row" style="margin-top:12px">
          <button class="btn ghost" id="copyBtn">复制</button>
          <a class="btn ghost" id="openLink" target="_blank" rel="noopener noreferrer">打开</a>
        </div>
      </div>
    </section>

    <section class="card" id="releases">
      <div class="card-head">
        <div>
          <h2>Releases 版本与资产下载</h2>
          <p class="muted small" id="relSub" style="margin:6px 0 0">输入 owner/repo 或粘贴 GitHub 仓库链接，解析版本列表与下载资产</p>
        </div>
      </div>
      <div class="row">
        <input id="repoInput" aria-label="GitHub 仓库 owner/repo" placeholder="owner/repo，例如 sky22333/hubproxy" autocomplete="off" spellcheck="false">
        <button class="btn primary" id="relBtn">解析 Releases</button>
      </div>
      <p class="err" id="relErr" hidden></p>
      <div id="relList"></div>
    </section>
  </div>

  <!-- 页面二：镜像搜索 -->
  <div id="viewSearch" hidden>
    <section class="hero">
      <p class="eyebrow">Docker Hub</p>
      <h1>镜像搜索</h1>
      <p class="sub">检索官方与社区镜像，查看标签架构，一键复制加速后的镜像名。</p>
    </section>
    <section class="card">
      <div class="row">
        <input id="q" aria-label="镜像搜索关键词" placeholder="例如 nginx、redis、library/ubuntu" autocomplete="off" spellcheck="false">
        <button class="btn primary" id="searchBtn">搜索</button>
      </div>
      <p class="err" id="searchErr" hidden></p>
      <div id="searchList" class="list"></div>
    </section>
  </div>

  <!-- 页面三：镜像标签详情 -->
  <div id="viewDetail" hidden>
    <section class="card">
      <a class="link" href="/search" data-nav>← 返回镜像搜索</a>
      <div class="row" style="margin-top:14px">
        <input id="detailQ" aria-label="筛选当前镜像的标签" placeholder="筛选当前镜像的标签，例如 cu134、latest" autocomplete="off" spellcheck="false">
        <button class="btn primary" id="detailSearchBtn">筛选</button>
      </div>
      <div style="margin-top:20px">
        <div class="rel-title">
          <h2 id="detailTitle"></h2>
          <span class="tag" id="detailOfficial" hidden>官方</span>
        </div>
        <p class="muted small" id="detailSub" style="margin:8px 0 0"></p>
        <div class="row" style="margin-top:12px">
          <button class="btn ghost" id="copyImageName">复制镜像名</button>
        </div>
      </div>
      <p class="err" id="tagErr" hidden></p>
      <div id="tagList" class="list"></div>
      <div class="row" style="margin-top:12px">
        <button class="btn ghost" id="tagMore" hidden>加载更多标签</button>
      </div>
    </section>
  </div>
</main>

<footer>HubProxy · Cloudflare Worker 版 · Docker / GitHub / Hugging Face 加速</footer>

<script>
(function () {
  var origin = location.origin;
  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    var units = ['B', 'KB', 'MB', 'GB'], size = bytes, i = 0;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return size.toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
  }
  function fmtCount(n) {
    if (!n) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function fmtDate(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function getJSON(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || ('请求失败（' + res.status + '）'));
        return data;
      });
    });
  }
  function copy(text, btn) {
    var done = function () {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = old; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }
  function fallbackCopy(text, done) {
    var area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (e) { window.prompt('请手动复制', text); }
    document.body.removeChild(area);
  }

  // ---------- Markdown 渲染（仅支持 Release 说明里的常见语法） ----------
  // 页面脚本内嵌在 TS 模板字符串里，反引号用字符码拼出，避免截断模板
  var TICK = String.fromCharCode(96);
  var FENCE = TICK + TICK + TICK;
  var INLINE_CODE_RE = new RegExp(TICK + '([^' + TICK + ']+)' + TICK, 'g');

  // Release 说明里常夹带 HTML：去掉注释（如 changelog JSON 块），把徽章/链接/表格转成 Markdown 可读形式
  function prepareMarkdown(source) {
    return String(source == null ? '' : source)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<img[^>]*?src=["']([^"']+)["'][^>]*?>/gi, function (match, src) {
        var alt = match.match(/alt=["']([^"']*)["']/i);
        return '![' + (alt ? alt[1] : '') + '](' + src + ')';
      })
      .replace(/<a[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
      .replace(/<\/(td|th)>/gi, ' | ')
      .replace(/<\/(tr|p|div|table|thead|tbody|h[1-6]|li|ul|ol)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/ \|\s*\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  }

  function renderMarkdown(source) {
    var lines = esc(prepareMarkdown(source)).replace(/\r\n?/g, '\n').split('\n');
    var html = '', listType = '', paragraph = [], codeLines = [], inCode = false;

    function inline(text) {
      return text
        .replace(INLINE_CODE_RE, '<code>$1</code>')
        .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    }
    function flushParagraph() {
      if (!paragraph.length) return;
      html += '<p>' + inline(paragraph.join('\n')).replace(/\n/g, '<br>') + '</p>';
      paragraph = [];
    }
    function closeList() {
      if (listType) { html += '</' + listType + '>'; listType = ''; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf(FENCE) === 0) {
        if (inCode) {
          html += '<pre><code>' + codeLines.join('\n') + '</code></pre>';
          codeLines = [];
          inCode = false;
        } else {
          flushParagraph();
          closeList();
          inCode = true;
        }
        continue;
      }
      if (inCode) { codeLines.push(line); continue; }
      if (/^\s*$/.test(line)) { flushParagraph(); closeList(); continue; }

      var heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        closeList();
        var level = Math.min(heading[1].length + 2, 6);
        html += '<h' + level + '>' + inline(heading[2]) + '</h' + level + '>';
        continue;
      }
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flushParagraph(); closeList(); html += '<hr>'; continue; }

      var ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      var bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ordered || bullet) {
        flushParagraph();
        var wanted = ordered ? 'ol' : 'ul';
        if (listType && listType !== wanted) closeList();
        if (!listType) { listType = wanted; html += '<' + wanted + '>'; }
        html += '<li>' + inline((ordered || bullet)[1]) + '</li>';
        continue;
      }
      var quote = line.match(/^&gt;\s?(.*)$/);
      if (quote) { flushParagraph(); closeList(); html += '<blockquote>' + inline(quote[1]) + '</blockquote>'; continue; }
      paragraph.push(line);
    }

    if (inCode) html += '<pre><code>' + codeLines.join('\n') + '</code></pre>';
    flushParagraph();
    closeList();
    return html;
  }

  // ---------- 路由（/、/search、/search/:namespace/:name） ----------
  var DETAIL_RE = /^\/search\/([^/]+)\/([^/]+)\/?$/;
  var views = { home: $('viewHome'), search: $('viewSearch'), detail: $('viewDetail') };

  function currentRoute() {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    var detail = path.match(DETAIL_RE);
    if (detail) {
      try {
        return { name: 'detail', ns: decodeURIComponent(detail[1]), repo: decodeURIComponent(detail[2]) };
      } catch (e) {
        return { name: 'search' };
      }
    }
    if (path === '/search') return { name: 'search' };
    return { name: 'home' };
  }

  function setNav(name) {
    Array.prototype.forEach.call(document.querySelectorAll('nav a[data-nav]'), function (link) {
      var target = link.getAttribute('href');
      var active = name === 'home' ? target === '/' : target === '/search';
      link.classList.toggle('active', active);
    });
  }

  function toggleViews(name) {
    views.home.hidden = name !== 'home';
    views.search.hidden = name !== 'search';
    views.detail.hidden = name !== 'detail';
  }

  function route() {
    var current = currentRoute();
    toggleViews(current.name);
    setNav(current.name);
    window.scrollTo(0, 0);

    if (current.name === 'detail') {
      document.title = current.ns + '/' + current.repo + ' · 镜像详情 · HubProxy';
      loadTags(current.ns, current.repo, 1);
      return;
    }
    if (current.name === 'search') {
      document.title = '镜像搜索 · HubProxy';
      var keyword = new URLSearchParams(location.search).get('q') || '';
      $('q').value = keyword;
      $('searchErr').hidden = true;
      if (keyword) {
        runSearch(keyword);
      } else {
        $('searchList').innerHTML = '';
      }
      return;
    }
    document.title = 'HubProxy · GitHub 加速 · Releases 下载';
  }

  function navigate(url) {
    if (url === location.pathname + location.search) return;
    history.pushState({}, '', url);
    route();
  }

  document.addEventListener('click', function (ev) {
    var link = ev.target.closest('a[data-nav]');
    if (!link) return;
    var url = new URL(link.href, location.href);
    if (url.origin !== location.origin) return;
    ev.preventDefault();
    navigate(url.pathname + url.search);
  });
  window.addEventListener('popstate', route);

  // ---------- 链接转换 ----------
  var GITHUB_HOSTS = ['github.com/', 'raw.githubusercontent.com/', 'gist.githubusercontent.com/', 'gist.github.com/', 'api.github.com/', 'huggingface.co/', 'cdn-lfs.hf.co/'];
  var MODE_LABELS = { raw: '原始链接', clone: 'Git Clone', wget: 'Wget', curl: 'cURL' };
  var mode = 'raw';

  function normalizeLink(raw) {
    var link = String(raw || '').trim();
    if (link === '') return '';
    if (/^https?:\/\//.test(link)) return link;
    if (link.indexOf('//') === 0) return 'https:' + link;
    return 'https://' + link.replace(/^\/+/, '');
  }

  function parseRepo(raw) {
    var s = String(raw || '').trim().replace(/^https?:\/\//, '').replace(/^\/+/, '');
    var parts = s.split(/[?#]/)[0].split('/').filter(Boolean);
    if (parts.length === 0) return null;
    if (parts[0].indexOf('.') >= 0) {
      if (parts[0] !== 'github.com') return null;
      parts.shift();
    }
    if (parts.length < 2) return null;
    var owner = parts[0].replace(/\.git$/, '');
    var repo = parts[1].replace(/\.git$/, '');
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
    return { repo: owner + '/' + repo, root: parts.length === 2 };
  }

  function convert() {
    var errBox = $('convertErr'), result = $('result');
    errBox.hidden = true;
    result.hidden = true;
    var link = normalizeLink($('urlInput').value);
    if (link === '') { errBox.textContent = '请输入 GitHub / Hugging Face 链接'; errBox.hidden = false; return; }
    var hostPath = link.replace(/^https?:\/\//, '');
    var supported = GITHUB_HOSTS.some(function (prefix) { return hostPath.indexOf(prefix) === 0; });
    if (!supported) { errBox.textContent = '仅支持 GitHub / Hugging Face 链接'; errBox.hidden = false; return; }

    var proxy = origin + '/' + link;
    var text = proxy;
    if (mode === 'clone') text = 'git clone ' + proxy;
    else if (mode === 'wget') text = 'wget ' + proxy;
    else if (mode === 'curl') text = 'curl -L -O ' + proxy;

    $('resultText').textContent = text;
    $('resultMode').textContent = MODE_LABELS[mode];
    $('openLink').href = proxy;
    result.hidden = false;

    var found = parseRepo(link);
    if (found && found.root) {
      $('repoInput').value = found.repo;
      loadReleases(found.repo);
    }
  }

  $('tabs').addEventListener('click', function (ev) {
    var tab = ev.target.closest('.tab');
    if (!tab) return;
    mode = tab.dataset.mode;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (el) {
      el.classList.toggle('active', el === tab);
    });
    if (!$('result').hidden) convert();
  });
  $('convertBtn').addEventListener('click', convert);
  $('urlInput').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') convert(); });
  $('copyBtn').addEventListener('click', function () { copy($('resultText').textContent, $('copyBtn')); });
  Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (chip) {
    chip.addEventListener('click', function () {
      $('urlInput').value = chip.dataset.fill;
      convert();
    });
  });

  // ---------- Releases ----------
  function renderAsset(asset, index) {
    var size = fmtSize(asset.size);
    return '<div class="asset"' + (index >= 5 ? ' hidden' : '') + '>' +
      '<div class="asset-name"><span class="file-icon">⬇</span><span class="name">' + esc(asset.name) + '</span>' +
      (size ? '<span class="tag size">' + size + '</span>' : '') +
      '<span class="muted small">' + fmtCount(asset.download_count) + ' 次下载</span></div>' +
      '<div class="asset-actions">' +
      '<a class="btn ghost" href="' + esc(asset.url) + '">下载</a>' +
      '<button class="btn ghost" data-copy="' + esc(asset.url) + '">复制</button>' +
      '</div></div>';
  }

  function renderRelease(release, index) {
    var assets = release.assets || [];
    var badge = index === 0 && !release.prerelease
      ? '<span class="tag latest">最新版本</span>'
      : (release.prerelease ? '<span class="tag pre">预发布</span>' : '');
    var notesToggle = release.notes ? '<button class="link notes-toggle">查看更新日志</button>' : '';
    var notes = release.notes
      ? '<div class="notes md" hidden>' + renderMarkdown(release.notes) + '</div>'
      : '';
    var more = assets.length > 5
      ? '<button class="link more-toggle" style="margin-top:10px">展开全部（' + assets.length + '）</button>'
      : '';
    return '<article class="release">' +
      '<header class="rel-head">' +
      '<div class="rel-title"><span class="tag version">' + esc(release.tag_name) + '</span>' +
      '<h3>' + esc(release.name) + '</h3>' + badge + '</div>' +
      '<div class="rel-meta"><span class="muted">' + esc(fmtDate(release.published_at)) + '</span>' + notesToggle + '</div>' +
      '</header>' + notes +
      '<p class="muted small" style="margin:10px 0 0">' + assets.length + ' 个安装包文件' +
      (assets.length > 5 ? '（默认展示前 5 个）' : '') + '</p>' +
      '<div class="assets">' + assets.map(renderAsset).join('') + '</div>' + more +
      '</article>';
  }

  function loadReleases(repo) {
    var errBox = $('relErr'), list = $('relList'), sub = $('relSub');
    repo = String(repo || '').trim();
    errBox.hidden = true;
    if (repo === '') { errBox.textContent = '请输入 owner/repo'; errBox.hidden = false; return; }
    sub.textContent = '正在解析 ' + repo + ' 的 Releases…';
    list.innerHTML = '<div class="skeleton" style="margin-top:14px"></div><div class="skeleton" style="margin-top:10px"></div>';
    getJSON('/api/releases?repo=' + encodeURIComponent(repo) + '&per_page=15').then(function (data) {
      if (!data.releases.length) {
        sub.textContent = data.repo + ' · 暂无发布版本';
        list.innerHTML = '<p class="muted" style="margin-top:14px">该仓库还没有发布 Release</p>';
        return;
      }
      sub.textContent = data.repo + ' · 共 ' + data.count + ' 个版本' + (data.count >= 15 ? '（仅展示最近 15 个）' : '');
      list.innerHTML = data.releases.map(renderRelease).join('');
    }).catch(function (e) {
      sub.textContent = '';
      list.innerHTML = '';
      errBox.textContent = e.message;
      errBox.hidden = false;
    });
  }

  $('relBtn').addEventListener('click', function () {
    var found = parseRepo($('repoInput').value);
    loadReleases(found ? found.repo : $('repoInput').value.trim());
  });
  $('repoInput').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') $('relBtn').click();
  });
  $('relList').addEventListener('click', function (ev) {
    var target = ev.target;
    var article = target.closest('article');
    if (target.classList.contains('notes-toggle') && article) {
      var notes = article.querySelector('.notes');
      if (notes) {
        notes.hidden = !notes.hidden;
        target.textContent = notes.hidden ? '查看更新日志' : '收起更新日志';
      }
      return;
    }
    if (target.classList.contains('more-toggle') && article) {
      var hiddenAssets = article.querySelectorAll('.asset[hidden]');
      if (hiddenAssets.length) {
        Array.prototype.forEach.call(hiddenAssets, function (el) { el.hidden = false; });
        target.textContent = '收起';
      } else {
        Array.prototype.forEach.call(article.querySelectorAll('.asset'), function (el, i) { el.hidden = i >= 5; });
        target.textContent = '展开全部（' + article.querySelectorAll('.asset').length + '）';
      }
      return;
    }
    if (target.dataset && target.dataset.copy) copy(target.dataset.copy, target);
  });

  // ---------- 镜像搜索 ----------
  function renderSearchResults(data) {
    var list = $('searchList');
    if (!data.results.length) {
      list.innerHTML = '<p class="muted" style="margin-top:14px">未找到相关镜像</p>';
      return;
    }
    list.innerHTML = '<p class="muted small" style="margin:12px 0 0">共 ' + data.count + ' 条结果，点击查看标签</p>' +
      data.results.map(function (repo) {
        var full = repo.namespace + '/' + repo.name;
        return '<button class="row-item" data-ns="' + esc(repo.namespace) + '" data-name="' + esc(repo.name) + '">' +
          '<span class="title">' + esc(full) +
          (repo.is_official ? '<span class="tag">官方</span>' : '') +
          '<span class="muted small" style="font-weight:400">★ ' + fmtCount(repo.star_count) + ' · ⬇ ' + fmtCount(repo.pull_count) + '</span>' +
          '</span><span class="desc">' + esc(repo.short_description || '暂无描述') + '</span></button>';
      }).join('');
  }

  function runSearch(keyword) {
    var list = $('searchList'), errBox = $('searchErr');
    errBox.hidden = true;
    list.innerHTML = '<div class="skeleton" style="margin-top:14px"></div>';
    getJSON('/api/search?q=' + encodeURIComponent(keyword) + '&page=1&page_size=25').then(renderSearchResults).catch(function (e) {
      list.innerHTML = '';
      errBox.textContent = e.message;
      errBox.hidden = false;
    });
  }

  function submitSearch() {
    var keyword = $('q').value.trim();
    if (keyword === '') {
      $('searchErr').textContent = '请输入搜索关键词';
      $('searchErr').hidden = false;
      return;
    }
    navigate('/search?q=' + encodeURIComponent(keyword));
    route();
  }

  $('searchBtn').addEventListener('click', submitSearch);
  $('q').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submitSearch(); });
  $('searchList').addEventListener('click', function (ev) {
    var item = ev.target.closest('.row-item');
    if (!item) return;
    navigate('/search/' + encodeURIComponent(item.dataset.ns) + '/' + encodeURIComponent(item.dataset.name));
  });

  // ---------- 镜像标签详情 ----------
  var current = { ns: '', name: '', page: 1, hasMore: false, loaded: 0, tags: [], filter: '' };

  function imageName(tag) {
    return location.host + '/' + current.ns + '/' + current.name + (tag ? ':' + tag : '');
  }

  function renderTag(tag) {
    var pull = imageName(tag.name);
    var archs = [];
    (tag.images || []).forEach(function (image) {
      if (!image.architecture || image.architecture === 'unknown') return;
      var label = image.os && image.os !== 'unknown' ? image.os + '/' + image.architecture : image.architecture;
      if (image.variant) label += '/' + image.variant;
      if (archs.indexOf(label) < 0) archs.push(label);
    });
    var size = fmtSize(tag.full_size);
    return '<div class="tag-row"><div class="info">' +
      '<span class="name">' + esc(tag.name) + '</span>' +
      '<span class="muted small">' + (size ? size + ' · ' : '') + esc(fmtDate(tag.last_updated)) + '</span>' +
      (archs.length ? '<span class="archs">' + archs.map(function (a) { return '<span class="arch">' + esc(a) + '</span>'; }).join('') + '</span>' : '') +
      '</div><button class="btn ghost" data-pull="' + esc(pull) + '">复制</button></div>';
  }

  // 按当前镜像已加载的标签筛选（不做 Docker Hub 全局搜索）：完全匹配 > 前缀 > 包含
  function visibleTags() {
    var keyword = current.filter.trim().toLowerCase();
    if (keyword === '') return current.tags;
    var exact = [], starts = [], includes = [];
    current.tags.forEach(function (tag) {
      var name = tag.name.toLowerCase();
      if (name === keyword) exact.push(tag);
      else if (name.indexOf(keyword) === 0) starts.push(tag);
      else if (name.indexOf(keyword) >= 0) includes.push(tag);
    });
    return exact.concat(starts, includes);
  }

  function renderTags() {
    var list = $('tagList');
    var tags = visibleTags();
    list.innerHTML = tags.length
      ? tags.map(renderTag).join('')
      : '<p class="muted" style="margin-top:14px">' +
        (current.filter.trim() ? '已加载的标签中没有匹配项' + (current.hasMore ? '，可加载更多后再筛选' : '') : '该镜像暂无标签') +
        '</p>';
    var summary = current.filter.trim()
      ? '筛选出 ' + tags.length + ' 个 / 已加载 ' + current.loaded + ' 个'
      : '共 ' + current.loaded + ' 个标签';
    $('detailSub').textContent = summary + (current.hasMore ? ' · 可继续加载' : '');
    $('tagMore').hidden = !current.hasMore;
  }

  function loadTags(ns, name, page) {
    if (page === 1) {
      current.tags = [];
      current.loaded = 0;
      current.filter = '';
      $('detailQ').value = '';
    }
    current.ns = ns;
    current.name = name;
    current.page = page;
    $('detailTitle').textContent = ns + '/' + name;
    $('detailSub').textContent = page === 1 ? '正在加载标签…' : '正在加载第 ' + page + ' 页…';
    $('tagErr').hidden = true;
    $('copyImageName').textContent = '复制镜像名';
    if (page === 1) $('tagList').innerHTML = '<div class="skeleton" style="margin-top:14px"></div>';
    getJSON('/api/tags/' + encodeURIComponent(ns) + '/' + encodeURIComponent(name) + '?page=' + page + '&page_size=100').then(function (data) {
      current.hasMore = !!data.has_more;
      current.tags = current.tags.concat(data.tags);
      current.loaded = current.tags.length;
      renderTags();
    }).catch(function (e) {
      if (page === 1) $('tagList').innerHTML = '';
      $('detailSub').textContent = '';
      $('tagMore').hidden = true;
      $('tagErr').textContent = e.message;
      $('tagErr').hidden = false;
    });
  }

  $('tagList').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-pull]');
    if (btn) copy(btn.dataset.pull, btn);
  });
  $('copyImageName').addEventListener('click', function () {
    copy(imageName(''), $('copyImageName'));
  });
  $('tagMore').addEventListener('click', function () {
    loadTags(current.ns, current.name, current.page + 1);
  });
  function applyTagFilter() {
    current.filter = $('detailQ').value;
    renderTags();
  }
  $('detailSearchBtn').addEventListener('click', applyTagFilter);
  $('detailQ').addEventListener('input', applyTagFilter);
  $('detailQ').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') applyTagFilter();
    if (ev.key === 'Escape') { $('detailQ').value = ''; applyTagFilter(); }
  });

  route();
})();
</script>
</body>
</html>
`

/** 返回内置 Web 界面 HTML */
export function renderUI(): string {
  return PAGE
}
