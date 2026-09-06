const SUPABASE_FUNCTION_URL = "https://quylfcqnzubxedlatzpv.supabase.co/functions/v1/super-responder";
const SUPABASE_URL = "https://quylfcqnzubxedlatzpv.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_9Nl91eoKWdraNH_kw2cCIg_GHRn-IJJ";

const params = new URLSearchParams(window.location.search);
const macAddress = params.get("mac_address")?.trim() || "";
const form = document.getElementById("chat-form");
const input = document.getElementById("message-input");
const messages = document.getElementById("messages");
const sendButton = document.getElementById("send-button");
const statusText = document.getElementById("status");
let currentConversationId = null;
let supabase = null;
let channel = null;
let renderedIds = new Set();
let realtimeRetryTimer = null;
let authReady = false;

function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char])); }
function formatTime(value) { if (!value) return ""; try { return new Date(value).toLocaleTimeString("ar-YE", {hour:"2-digit", minute:"2-digit"}); } catch { return ""; } }
function trimClientMessages() { while (messages.children.length > 20) { const first = messages.firstElementChild; if (!first) break; const id = first.dataset.messageId; if (id) renderedIds.delete(String(id)); first.remove(); } }
function appendMessage(item, optimistic = false) {
  if (!optimistic && item.id != null && renderedIds.has(String(item.id))) return;
  const wrapper = document.createElement("div"); const type = item.sender === "client" ? "user" : "support"; wrapper.className = `message ${type}`;
  if (item.id != null) { wrapper.dataset.messageId = String(item.id); renderedIds.add(String(item.id)); }
  if (optimistic) wrapper.dataset.optimistic = "true";
  const bubble = document.createElement("div"); bubble.className = "bubble"; bubble.innerHTML = escapeHtml(item.message).replace(/\n/g, "<br>");
  if (item.created_at) { const time = document.createElement("div"); time.className = "message-time"; time.textContent = formatTime(item.created_at); bubble.appendChild(time); }
  wrapper.appendChild(bubble); messages.appendChild(wrapper); trimClientMessages(); messages.scrollTop = messages.scrollHeight;
}
function removeOptimistic(text) { [...messages.querySelectorAll('[data-optimistic="true"]')].forEach(el => { if (el.querySelector(".bubble")?.textContent?.startsWith(text)) el.remove(); }); }
function renderMessages(data) { messages.innerHTML = ""; renderedIds = new Set(); data.slice(-20).forEach(item => appendMessage(item)); messages.scrollTop = messages.scrollHeight; }

async function authHeaders(extra = {}) {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const accessToken = data?.session?.access_token;
  if (!accessToken) throw new Error("جلسة المصادقة غير موجودة");
  return { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...extra };
}

async function ensureAnonymousSession() {
  if (!supabase) throw new Error("تعذر تحميل مكتبة Supabase");
  const { data: existing, error: existingError } = await supabase.auth.getSession();
  if (existingError) throw existingError;
  if (existing?.session?.user) {
    authReady = true;
    return existing.session;
  }
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  if (!data?.session?.access_token) throw new Error("لم يتم إنشاء جلسة Anonymous");
  authReady = true;
  return data.session;
}

async function bootstrapConversation() {
  if (!macAddress || !authReady) return null;
  const query = new URLSearchParams({ action: "bootstrap", mac_address: macAddress });
  if (currentConversationId) query.set("conversation_id", String(currentConversationId));
  const response = await fetch(`${SUPABASE_FUNCTION_URL}?${query.toString()}`, { headers: await authHeaders(), cache: "no-store" });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data?.error || data?.message || data?.raw || `HTTP ${response.status}`);
  if (data?.conversation?.id) currentConversationId = data.conversation.id;
  return data;
}

async function loadHistory() {
  try {
    const data = await bootstrapConversation();
    renderMessages(Array.isArray(data?.messages) ? data.messages : []);
    statusText.textContent = "متصل";
  } catch(error) { console.error(error); statusText.textContent = "تعذر تحميل المحادثة"; }
}

function scheduleRealtimeRetry() { if (realtimeRetryTimer || !currentConversationId) return; realtimeRetryTimer = setTimeout(() => { realtimeRetryTimer = null; subscribeToConversation(); }, 4000); }
function subscribeToConversation() {
  if (!supabase || !currentConversationId || !authReady) return;
  if (channel) { try { supabase.removeChannel(channel); } catch {} channel = null; }
  const conversationId = String(currentConversationId);
  channel = supabase.channel(`client-messages-${conversationId}`, { config: { private: true } })
    .on("postgres_changes", { event:"INSERT", schema:"public", table:"messages", filter:`conversation_id=eq.${conversationId}` }, payload => {
      const item = payload.new;
      [...messages.querySelectorAll('[data-optimistic="true"]')].forEach(el => { if (el.querySelector(".bubble")?.textContent?.startsWith(item.message)) el.remove(); });
      appendMessage(item); statusText.textContent = "متصل";
    })
    .subscribe(status => { if (status === "SUBSCRIBED") statusText.textContent = "متصل"; else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") { statusText.textContent = "إعادة الاتصال..."; scheduleRealtimeRetry(); } });
}

async function sendMessage(message) {
  const response = await fetch(SUPABASE_FUNCTION_URL,{method:"POST",headers:await authHeaders(),body:JSON.stringify({mac_address:macAddress,message,conversation_id:currentConversationId})});
  const text = await response.text(); let data; try { data=JSON.parse(text); } catch { data={raw:text}; }
  if(!response.ok) throw new Error(data?.error||data?.message||data?.raw||`HTTP ${response.status}`);
  const previousConversationId = currentConversationId; if(data?.conversation_id) currentConversationId=data.conversation_id; if (currentConversationId && String(currentConversationId) !== String(previousConversationId)) subscribeToConversation(); return data;
}

form.addEventListener("submit", async event=>{ event.preventDefault(); const message=input.value.trim(); if(!message||!macAddress||!authReady)return; appendMessage({sender:"client",message},true); input.value=""; sendButton.disabled=true; input.disabled=true; statusText.textContent="جاري الإرسال..."; try { const data=await sendMessage(message); if(data?.user_message){ removeOptimistic(message); appendMessage(data.user_message); } if(data?.response) appendMessage(data.response); statusText.textContent="متصل"; } catch(error) { console.error(error); removeOptimistic(message); appendMessage({sender:"admin",message:`تعذر إرسال الرسالة: ${error.message}`}); statusText.textContent="تعذر الاتصال"; } finally { sendButton.disabled=false; input.disabled=false; input.focus(); } });

(async()=>{
  if(!macAddress){statusText.textContent="عنوان MAC غير موجود";input.disabled=true;sendButton.disabled=true;return;}
  try {
    if (!window.supabase?.createClient) throw new Error("تعذر تحميل مكتبة Supabase");
    supabase=window.supabase.createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
    await ensureAnonymousSession();
    const bootstrap = await bootstrapConversation();
    if (!bootstrap?.conversation?.id) { renderMessages(Array.isArray(bootstrap?.messages) ? bootstrap.messages : []); statusText.textContent="متصل"; return; }
    renderMessages(Array.isArray(bootstrap.messages) ? bootstrap.messages : []);
    subscribeToConversation();
    statusText.textContent = "متصل";
  } catch(error){ console.error(error); statusText.textContent="تعذر الاتصال"; }
})();
