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

function authHeaders(extra = {}) { return { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`, "Content-Type": "application/json", ...extra }; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char])); }
function formatTime(value) { if (!value) return ""; try { return new Date(value).toLocaleTimeString("ar-YE", {hour:"2-digit", minute:"2-digit"}); } catch { return ""; } }

function appendMessage(item, optimistic = false) {
  if (!optimistic && item.id != null && renderedIds.has(String(item.id))) return;
  const wrapper = document.createElement("div");
  const type = item.sender === "client" ? "user" : "support";
  wrapper.className = `message ${type}`;
  if (item.id != null) { wrapper.dataset.messageId = String(item.id); renderedIds.add(String(item.id)); }
  if (optimistic) wrapper.dataset.optimistic = "true";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = escapeHtml(item.message).replace(/\n/g, "<br>");
  if (item.created_at) { const time = document.createElement("div"); time.className = "message-time"; time.textContent = formatTime(item.created_at); bubble.appendChild(time); }
  wrapper.appendChild(bubble); messages.appendChild(wrapper); messages.scrollTop = messages.scrollHeight;
}
function removeOptimistic(text) { [...messages.querySelectorAll('[data-optimistic="true"]')].forEach(el => { if (el.querySelector(".bubble")?.textContent?.startsWith(text)) el.remove(); }); }
function renderMessages(data) { messages.innerHTML = ""; renderedIds = new Set(); data.forEach(item => appendMessage(item)); messages.scrollTop = messages.scrollHeight; }

async function supabaseGet(path) { const response = await fetch(`${SUPABASE_URL}${path}`, {headers:authHeaders()}); const text = await response.text(); let data; try { data=JSON.parse(text); } catch { data=text; } if (!response.ok) throw new Error(typeof data === "string" ? data : data?.message || data?.error || `HTTP ${response.status}`); return data; }
async function findConversation() {
  if (!macAddress) return null;
  const clients = await supabaseGet(`/rest/v1/clients?select=id,mac_address&mac_address=eq.${encodeURIComponent(macAddress)}&limit=1`);
  if (!clients.length) return null;
  const conversations = await supabaseGet(`/rest/v1/conversations?select=id,client_id,status,created_at,updated_at&client_id=eq.${clients[0].id}&order=updated_at.desc&limit=1`);
  if (!conversations.length) return null;
  currentConversationId = conversations[0].id;
  return conversations[0];
}
async function loadHistory() {
  if (!currentConversationId) return;
  try {
    const data = await supabaseGet(`/rest/v1/messages?select=id,conversation_id,sender,message,created_at&conversation_id=eq.${currentConversationId}&order=created_at.desc&limit=20`);
    data.reverse();
    renderMessages(data);
    statusText.textContent = "متصل";
  } catch(error) { console.error(error); statusText.textContent = "تعذر تحميل المحادثة"; }
}

function scheduleRealtimeRetry() {
  if (realtimeRetryTimer || !currentConversationId) return;
  realtimeRetryTimer = setTimeout(() => {
    realtimeRetryTimer = null;
    subscribeToConversation();
  }, 4000);
}

function subscribeToConversation() {
  if (!supabase || !currentConversationId) return;
  if (channel) { try { supabase.removeChannel(channel); } catch {} channel = null; }
  const conversationId = String(currentConversationId);
  channel = supabase.channel(`client-messages-${conversationId}`)
    .on("postgres_changes", { event:"INSERT", schema:"public", table:"messages", filter:`conversation_id=eq.${conversationId}` }, payload => {
      const item = payload.new;
      [...messages.querySelectorAll('[data-optimistic="true"]')].forEach(el => { if (el.querySelector(".bubble")?.textContent?.startsWith(item.message)) el.remove(); });
      appendMessage(item);
      statusText.textContent = "متصل";
    })
    .subscribe(status => {
      if (status === "SUBSCRIBED") statusText.textContent = "متصل";
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        statusText.textContent = "إعادة الاتصال...";
        scheduleRealtimeRetry();
      }
    });
}

async function sendMessage(message) {
  const response = await fetch(SUPABASE_FUNCTION_URL,{method:"POST",headers:authHeaders(),body:JSON.stringify({mac_address:macAddress,message,conversation_id:currentConversationId})});
  const text = await response.text(); let data; try { data=JSON.parse(text); } catch { data={raw:text}; }
  if(!response.ok) throw new Error(data?.error||data?.message||data?.raw||`HTTP ${response.status}`);
  const previousConversationId = currentConversationId;
  if(data?.conversation_id) currentConversationId=data.conversation_id;
  if (currentConversationId && String(currentConversationId) !== String(previousConversationId)) subscribeToConversation();
  return data;
}

form.addEventListener("submit", async event=>{ event.preventDefault(); const message=input.value.trim(); if(!message||!macAddress)return; appendMessage({sender:"client",message},true); input.value=""; sendButton.disabled=true; input.disabled=true; statusText.textContent="جاري الإرسال..."; try { const data=await sendMessage(message); if(data?.user_message){ removeOptimistic(message); appendMessage(data.user_message); } if(data?.response) appendMessage(data.response); statusText.textContent="متصل"; } catch(error) { console.error(error); removeOptimistic(message); appendMessage({sender:"admin",message:`تعذر إرسال الرسالة: ${error.message}`}); statusText.textContent="تعذر الاتصال"; } finally { sendButton.disabled=false; input.disabled=false; input.focus(); } });

(async()=>{
  if(!macAddress){statusText.textContent="عنوان MAC غير موجود";input.disabled=true;sendButton.disabled=true;return;}
  try {
    if (!window.supabase?.createClient) throw new Error("تعذر تحميل مكتبة Supabase");
    supabase=window.supabase.createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);
    const conversation = await findConversation();
    if (!conversation) { statusText.textContent="متصل"; return; }
    subscribeToConversation();
    await loadHistory();
  } catch(error){ console.error(error); statusText.textContent="تعذر الاتصال"; }
})();