// Lazy-loaded Persistent Chat & Voice Room View (/chat)
let chatWs = null;

export async function mount(container, ctx) {
  ctx.ensureCssLoaded('/css/chat.css');

  let activeChannel = 'general';
  let channels = [];
  let messages = [];
  let members = [];
  let replyTarget = null;

  container.innerHTML = `
    <div class="chat-shell" id="chatShellGrid">
      <aside class="chat-channels-col">
        <div class="chat-srv-head">
          <span>astra server</span>
          <button type="button" class="tb-icon-btn" id="chatNewChBtn" title="New channel">+</button>
        </div>
        <div class="chat-ch-scroll" id="chatChList"></div>
        <div class="chat-me-bar">
          <div style="min-width:0;">
            <div style="font-size:12.5px;font-weight:700;color:var(--bright-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" id="chatMeName">${ctx.escapeHtml(ctx.appState.user?.displayName || ctx.appState.user?.username || 'user')}</div>
            <div style="font-size:10.5px;color:var(--text-muted);">online</div>
          </div>
          <button type="button" class="tb-icon-btn" id="chatMembersToggleBtn" title="Toggle Members">👥</button>
        </div>
      </aside>

      <section class="chat-main-col">
        <div class="chat-head-bar">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <span style="color:var(--accent);font-weight:800;">#</span>
            <span id="chatChTitle" style="font-weight:700;color:var(--bright-text);">general</span>
            <span id="chatChTopic" style="font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
          </div>
          <span id="chatWsPill" class="badge-pill">connecting</span>
        </div>

        <div class="chat-pin-bar" id="chatPinBar">
          <span id="chatPinText">📌 Pinned</span>
        </div>

        <div class="chat-feed" id="chatFeed"></div>

        <div class="chat-reply-strip" id="chatReplyStrip">
          <span id="chatReplyLabel">Replying...</span>
          <button type="button" class="chat-act-btn" id="chatCancelReply">✕</button>
        </div>

        <div class="chat-composer-wrap">
          <form class="chat-composer" id="chatForm">
            <input type="text" id="chatInput" placeholder="Message #general" autocomplete="off" />
            <button type="submit" class="btn btn-accent" style="height:30px;padding:0 12px;font-size:12px;">Send</button>
          </form>
        </div>
      </section>

      <aside class="chat-members-col" id="chatMembersCol"></aside>
    </div>
  `;

  const chListEl = container.querySelector('#chatChList');
  const feedEl = container.querySelector('#chatFeed');
  const membersEl = container.querySelector('#chatMembersCol');
  const wsPill = container.querySelector('#chatWsPill');
  const pinBar = container.querySelector('#chatPinBar');
  const pinText = container.querySelector('#chatPinText');
  const replyStrip = container.querySelector('#chatReplyStrip');
  const replyLabel = container.querySelector('#chatReplyLabel');

  function cleanDisplay(m) {
    const raw = String(m.displayName || m.username || 'user');
    if (m.username === 'coolbacon' || /Luis\s*\(coolbacon\)/i.test(raw)) return 'coolbacon';
    return raw;
  }

  function renderChannels() {
    chListEl.innerHTML = channels.filter((c) => c.type !== 'voice').map((c) => `
      <button type="button" class="chat-ch-btn ${c.id === activeChannel ? 'active' : ''}" data-ch="${ctx.escapeHtml(c.id)}">
        <span><span style="opacity:0.6;">#</span> ${ctx.escapeHtml(c.name || c.id)}</span>
      </button>
    `).join('');
    chListEl.querySelectorAll('[data-ch]').forEach((b) => {
      b.onclick = () => loadChannel(b.dataset.ch);
    });
  }

  function renderMembers() {
    membersEl.innerHTML = `<div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;padding:0 6px;">Members (${members.length})</div>` +
      members.map((m) => `
        <div class="chat-member-row">
          <span class="chat-dot ${m.online ? 'online' : ''}"></span>
          <span style="font-size:12.5px;font-weight:600;color:${m.online ? 'var(--bright-text)' : 'var(--text-muted)'};">${ctx.escapeHtml(cleanDisplay(m))}</span>
        </div>
      `).join('');
  }

  function renderMessages() {
    const pins = messages.filter((m) => m.pinned);
    if (pins.length) {
      pinBar.classList.add('visible');
      pinText.textContent = `📌 ${cleanDisplay(pins[pins.length - 1])}: ${pins[pins.length - 1].text || ''}`;
    } else {
      pinBar.classList.remove('visible');
    }

    const me = ctx.appState.user;
    feedEl.innerHTML = messages.map((m) => {
      const name = cleanDisplay(m);
      const av = m.avatar ? `<img src="${ctx.escapeHtml(m.avatar)}" alt="" />` : ctx.escapeHtml(name[0].toUpperCase());
      const ts = new Date(m.ts || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const canMod = me && (me.role === 'admin' || me.username === m.username);
      const replyHdr = m.replyTo ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">↳ ${ctx.escapeHtml(m.replyTo.displayName || m.replyTo.username)}: ${ctx.escapeHtml(String(m.replyTo.text || '').slice(0, 60))}</div>` : '';
      return `
        <div class="chat-msg" data-msg-id="${ctx.escapeHtml(m.id)}">
          <div class="chat-msg-pfp">${av}</div>
          <div class="chat-msg-body">
            ${replyHdr}
            <div class="chat-msg-head">
              <span class="chat-msg-author">${ctx.escapeHtml(name)}</span>
              ${m.role === 'admin' ? `<span class="chat-role-badge" style="color:var(--accent);">Admin</span>` : ''}
              <span class="chat-msg-time">${ts}${m.editedAt ? ' (edited)' : ''}</span>
            </div>
            <div class="chat-msg-text">${ctx.escapeHtml(m.text || '')}</div>
          </div>
          <div class="chat-msg-actions">
            <button type="button" class="chat-act-btn" data-act="reply">Reply</button>
            ${canMod ? `<button type="button" class="chat-act-btn" data-act="edit">Edit</button>` : ''}
            ${canMod ? `<button type="button" class="chat-act-btn" data-act="del">Delete</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
    feedEl.scrollTop = feedEl.scrollHeight;

    feedEl.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = async () => {
        const msgId = btn.closest('[data-msg-id]')?.dataset.msgId;
        const msg = messages.find((x) => x.id === msgId);
        if (!msg) return;
        const act = btn.dataset.act;
        if (act === 'reply') {
          replyTarget = msg;
          replyLabel.textContent = `Replying to ${cleanDisplay(msg)}`;
          replyStrip.classList.add('visible');
        } else if (act === 'del') {
          await fetch(`/api/chat/messages?channel=${encodeURIComponent(activeChannel)}&id=${encodeURIComponent(msgId)}`, { method: 'DELETE', credentials: 'same-origin' });
          messages = messages.filter((x) => x.id !== msgId);
          renderMessages();
        } else if (act === 'edit') {
          const next = prompt('Edit message:', msg.text || '');
          if (next === null || !next.trim()) return;
          const r = await fetch('/api/chat/messages', {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: activeChannel, id: msgId, text: next.trim() })
          });
          if (r.ok) {
            const j = await r.json();
            const idx = messages.findIndex((x) => x.id === msgId);
            if (idx !== -1 && j.message) messages[idx] = j.message;
            renderMessages();
          }
        }
      };
    });
  }

  async function loadChannel(ch) {
    activeChannel = ch;
    container.querySelector('#chatChTitle').textContent = ch;
    container.querySelector('#chatInput').placeholder = `Message #${ch}`;
    renderChannels();
    try {
      const r = await fetch(`/api/chat/messages?channel=${encodeURIComponent(ch)}&limit=120`, { credentials: 'same-origin' });
      const j = await r.json();
      if (j && j.ok) {
        channels = j.channels || channels;
        messages = j.messages || [];
        members = j.members || members;
        const curObj = channels.find((x) => x.id === ch);
        container.querySelector('#chatChTopic').textContent = curObj?.topic || '';
        renderChannels();
        renderMembers();
        renderMessages();
      }
    } catch {}
  }

  function connectWs() {
    if (chatWs && (chatWs.readyState === 0 || chatWs.readyState === 1)) return;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    chatWs = new WebSocket(`${proto}${location.host}/chat-ws`);
    chatWs.onopen = () => {
      if (wsPill) { wsPill.textContent = 'live'; wsPill.className = 'badge-pill ok'; }
    };
    chatWs.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.type === 'message' && d.channel === activeChannel && d.message) {
          if (!messages.some((m) => m.id === d.message.id)) {
            messages.push(d.message);
            renderMessages();
          }
        } else if (d.type === 'message-update' && d.channel === activeChannel && d.message) {
          const i = messages.findIndex((m) => m.id === d.message.id);
          if (i !== -1) { messages[i] = d.message; renderMessages(); }
        } else if (d.type === 'message-delete' && d.channel === activeChannel) {
          messages = messages.filter((m) => m.id !== d.messageId);
          renderMessages();
        } else if (d.type === 'members-update' && Array.isArray(d.members)) {
          members = d.members;
          renderMembers();
        }
      } catch {}
    };
    chatWs.onclose = () => {
      if (wsPill) { wsPill.textContent = 'reconnecting'; wsPill.className = 'badge-pill warn'; }
    };
  }

  container.querySelector('#chatForm').onsubmit = async (e) => {
    e.preventDefault();
    const inp = container.querySelector('#chatInput');
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    const tempId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const r = await fetch('/api/chat/messages', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: activeChannel,
        text,
        clientTempId: tempId,
        replyToId: replyTarget?.id || null
      })
    });
    replyTarget = null;
    replyStrip.classList.remove('visible');
    const j = await r.json();
    if (!r.ok || !j.ok) return ctx.showToast(j.error || 'Failed to save message');
    if (j.message && !messages.some((m) => m.id === j.message.id)) {
      messages.push(j.message);
      renderMessages();
    }
  };

  container.querySelector('#chatCancelReply').onclick = () => {
    replyTarget = null;
    replyStrip.classList.remove('visible');
  };
  container.querySelector('#chatMembersToggleBtn').onclick = () => {
    container.querySelector('#chatShellGrid')?.classList.toggle('no-members');
  };
  container.querySelector('#chatNewChBtn').onclick = async () => {
    const name = prompt('New channel name:');
    if (!name || !name.trim()) return;
    const r = await fetch('/api/chat/channels', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), type: 'text' })
    });
    const j = await r.json();
    if (r.ok && j.ok && j.channel) {
      await loadChannel(j.channel.id);
    }
  };

  connectWs();
  await loadChannel('general');

  return () => {
    try { if (chatWs) chatWs.close(); } catch {}
    chatWs = null;
  };
}
