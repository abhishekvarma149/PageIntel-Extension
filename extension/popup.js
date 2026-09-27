const API = "http://127.0.0.1:8000";
const DEFAULT_MODEL_A = "openai/gpt-4o";
const DEFAULT_MODEL_B = "anthropic/claude-sonnet-4.5";

// ── DOM refs ───────────────────────────────────────────────────────────────
const compareToggle = document.getElementById("compareToggle");
const singlePanel = document.getElementById("singlePanel");
const compareInputRow = document.getElementById("compareInputRow");
const comparePanel = document.getElementById("comparePanel");

// Single mode
const userQuery = document.getElementById("userQuery");
const modelSelect = document.getElementById("modelSelect");
const askBtn = document.getElementById("askBtn");
const responseBox = document.getElementById("responseBox");

// Compare mode
const compareQuery = document.getElementById("compareQuery");
const modelSelectA = document.getElementById("modelSelectA");
const modelSelectB = document.getElementById("modelSelectB");
const compareAskBtn = document.getElementById("compareAskBtn");
const responseA = document.getElementById("responseA");
const responseB = document.getElementById("responseB");

let compareMode = false;


let globalSessionId = null;

async function getSessionId() {
  if (globalSessionId) return globalSessionId;
  return new Promise(resolve => {
    chrome.storage.local.get(['session_id'], res => {
      if (res.session_id) {
        globalSessionId = res.session_id;
        resolve(res.session_id);
      } else {
        const newId = crypto.randomUUID();
        chrome.storage.local.set({ session_id: newId }, () => {
          globalSessionId = newId;
          resolve(newId);
        });
      }
    });
  });
}

async function loadHistory() {
  try {
    const sessionId = await getSessionId();
    const res = await fetch(`${API}/history/${sessionId}`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.history && data.history.length > 0) {
      const ph = responseBox.querySelector('.placeholder-msg');
      if (ph) ph.remove();

      data.history.forEach(item => {
        appendMessage(responseBox, 'You', item.user);
        appendMessage(responseBox, 'AI', stripMarkdown(item.ai));
        responseBox.innerHTML += '<hr style="border:0; border-top:1px solid var(--border); margin:14px 0;">';
      });
      responseBox.scrollTop = responseBox.scrollHeight;
    }
  } catch (err) {
    console.warn("Could not load history:", err.message);
  }
}

// ── Load models from backend ────────────────────────────────────────────────
async function loadModels() {
  try {
    const res = await fetch(`${API}/models`);
    const data = await res.json();
    const models = data.models;

    [modelSelect, modelSelectA, modelSelectB].forEach((sel, i) => {
      sel.innerHTML = "";
      models.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.name;
        sel.appendChild(opt);
      });
    });

    // Set defaults
    modelSelect.value = DEFAULT_MODEL_A;
    modelSelectA.value = DEFAULT_MODEL_A;
    modelSelectB.value = DEFAULT_MODEL_B;

  } catch (err) {
    [modelSelect, modelSelectA, modelSelectB].forEach(sel => {
      sel.innerHTML = `<option value="gpt-4o">GPT-4o (offline)</option>`;
    });
    console.warn("Could not load models:", err.message);
  }
}

// ── Compare mode toggle ────────────────────────────────────────────────────
compareToggle.addEventListener("click", () => {
  compareMode = !compareMode;
  document.body.classList.toggle("compare-mode", compareMode);
  compareToggle.classList.toggle("active", compareMode);
  compareToggle.innerHTML = compareMode
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Exit`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><rect x="2" y="3" width="9" height="18" rx="2"/><rect x="13" y="3" width="9" height="18" rx="2"/></svg> Compare`;
});

// ── Grab current page content ──────────────────────────────────────────────
function getPageContent() {
  return document.body.innerText;
}

async function extractPageContent() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      chrome.scripting.executeScript(
        { target: { tabId: tabs[0].id }, function: getPageContent },
        results => {
          if (!results || !results[0]) {
            reject(new Error("Could not extract page content. Try reloading the tab."));
          } else {
            resolve({ text: results[0].result, tabId: tabs[0].id.toString() });
          }
        }
      );
    });
  });
}

// Strip markdown symbols but keep structure (bullets, line breaks)
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '$1')   // **bold** → bold
    .replace(/\*(.+?)\*/gs, '$1')        // *italic* → italic
    .replace(/^#{1,6}\s+/gm, '')         // ## Heading → Heading
    .replace(/```[\s\S]*?```/g, '')       // remove code blocks
    .replace(/`([^`]+)`/g, '$1')         // `inline code` → inline code
    .replace(/^\s*>\s?/gm, '')           // remove blockquotes >
    .trim();
}

// ── Helper: Render Message ──────────────────────────────────────────────────
function appendMessage(container, role, text, modelName = null) {
  const isUser = role === 'You';
  const color = isUser ? 'var(--accent)' : 'var(--text-sub)';
  const label = isUser ? 'You:' : (modelName ? `AI (${modelName}):` : 'AI:');
  container.innerHTML += `
    <div style="font-weight:700; color:${color}; margin-top:14px; margin-bottom:4px; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">${label}</div>
    <div class="response-text" style="margin-bottom:14px;">${text}</div>
  `;
}

// ── Word-by-word stream animation ──────────────────────────────────────────
function streamText(text, container, delayMs = 35) {
  const holder = document.createElement("div");
  holder.className = "response-text";
  holder.style.marginBottom = "14px";
  container.appendChild(holder);
  const tokens = text.split(/(\s+)/);
  let i = 0;

  function next() {
    if (i >= tokens.length) return;
    const token = tokens[i++];
    if (token.trim() === "") {
      holder.appendChild(document.createTextNode(token));
    } else {
      const span = document.createElement("span");
      span.className = "word";
      span.style.animationDelay = `0ms`;
      span.innerText = token;
      holder.appendChild(span);
    }
    container.scrollTop = container.scrollHeight;
    setTimeout(next, delayMs);
  }

  const originalNext = next;
  next = () => {
    if (i >= tokens.length) {
      const hr = document.createElement("hr");
      hr.style = "border:0; border-top:1px solid var(--border); margin:14px 0;";
      container.appendChild(hr);
      container.scrollTop = container.scrollHeight;
      return;
    }
    originalNext();
  }
  next();
}

function setLoading(container, msg = "Thinking…") {
  const ph = container.querySelector('.placeholder-msg');
  if (ph) ph.remove();
  const loader = document.createElement("div");
  loader.className = "loading-indicator";
  loader.style = "color:var(--text-dim);display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:14px;";
  loader.innerHTML = `<span class="spinner" style="width:12px;height:12px;border-width:2px;"></span>${msg}`;
  container.appendChild(loader);
  container.scrollTop = container.scrollHeight;
  return loader;
}

function showError(container, msg) {
  const err = document.createElement("div");
  err.className = "error-message";
  err.style.marginBottom = "14px";
  err.innerHTML = `⚠️ ${msg}`;
  container.appendChild(err);
  container.scrollTop = container.scrollHeight;
}

// ── Single mode – Ask ───────────────────────────────────────────────────────
askBtn.addEventListener("click", handleSingleAsk);
userQuery.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askBtn.click(); }
});

async function handleSingleAsk() {
  const query = userQuery.value.trim();
  if (!query) return;

  askBtn.disabled = true;
  askBtn.innerHTML = '<span class="spinner"></span>Thinking…';

  const ph = responseBox.querySelector('.placeholder-msg');
  if (ph) ph.remove();

  appendMessage(responseBox, 'You', query);
  responseBox.innerHTML += `<div style="font-weight:700; color:var(--text-sub); margin-top:14px; margin-bottom:4px; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">AI:</div>`;
  const loader = setLoading(responseBox);

  try {
    const { text } = await extractPageContent();
    const sessionId = await getSessionId();
    const res = await fetch(`${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        query,
        session_id: sessionId,
        model: modelSelect.value || DEFAULT_MODEL_A
      })
    });

    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    loader.remove();
    streamText(stripMarkdown(data.answer), responseBox);
    userQuery.value = '';

  } catch (err) {
    loader.remove(); showError(responseBox, `${err.message}. Is the Python backend running on port 8000?`);
  } finally {
    askBtn.disabled = false;
    askBtn.textContent = "Ask";
  }
}

// ── Compare mode – Ask ──────────────────────────────────────────────────────
compareAskBtn.addEventListener("click", handleCompareAsk);
compareQuery.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); compareAskBtn.click(); }
});

async function handleCompareAsk() {
  const query = compareQuery.value.trim();
  if (!query) return;

  compareAskBtn.disabled = true;
  compareAskBtn.innerHTML = '<span class="spinner"></span>Comparing…';

  const mA = modelSelectA.value || DEFAULT_MODEL_A;
  const mB = modelSelectB.value || DEFAULT_MODEL_B;

  const phA = responseA.querySelector('.placeholder-msg');
  if (phA) phA.remove();
  const phB = responseB.querySelector('.placeholder-msg');
  if (phB) phB.remove();

  appendMessage(responseA, 'You', query);
  responseA.innerHTML += `<div style="font-weight:700; color:var(--text-sub); margin-top:14px; margin-bottom:4px; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">AI (${getModelName(mA)}):</div>`;
  
  appendMessage(responseB, 'You', query);
  responseB.innerHTML += `<div style="font-weight:700; color:var(--text-sub); margin-top:14px; margin-bottom:4px; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">AI (${getModelName(mB)}):</div>`;

  const loaderA = setLoading(responseA, `Asking ${getModelName(mA)}…`);
  const loaderB = setLoading(responseB, `Asking ${getModelName(mB)}…`);

  try {
    const { text } = await extractPageContent();
    const sessionId = await getSessionId();
    const res = await fetch(`${API}/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        query,
        session_id: sessionId,
        model_a: mA,
        model_b: mB
      })
    });

    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();

    loaderA.remove();
    loaderB.remove();

    // Stream both responses simultaneously
    streamText(stripMarkdown(data.answer_a), responseA, 30);
    streamText(stripMarkdown(data.answer_b), responseB, 30);
    compareQuery.value = '';

  } catch (err) {
    loaderA.remove(); showError(responseA, err.message);
    loaderB.remove(); showError(responseB, `${err.message}. Is the Python backend running on port 8000?`);
  } finally {
    compareAskBtn.disabled = false;
    compareAskBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="9" height="18" rx="2"/><rect x="13" y="3" width="9" height="18" rx="2"/></svg> Compare Models`;
  }
}

// ── Helper: get model display name from id ─────────────────────────────────
function getModelName(id) {
  const opt = [...modelSelectA.options, ...modelSelectB.options].find(o => o.value === id);
  return opt ? opt.textContent : id;
}

// ── Init ───────────────────────────────────────────────────────────────────
loadModels();
loadHistory();


// ── Delete All Conversation ──────────────────────────────────────────────────
const clearBtn = document.getElementById("clearBtn");
if (clearBtn) {
  clearBtn.addEventListener("click", async () => {
    try {
      const sessionId = await getSessionId();
      await fetch(`${API}/history/${sessionId}`, { method: "DELETE" });
      
      // Reset UI
      responseBox.innerHTML = '<div class="placeholder-msg">Your response will appear here…</div>';
      responseA.innerHTML = '<div class="placeholder-msg">Response A will appear here…</div>';
      responseB.innerHTML = '<div class="placeholder-msg">Response B will appear here…</div>';
    } catch (err) {
      console.warn("Could not delete history:", err.message);
    }
  });
}
